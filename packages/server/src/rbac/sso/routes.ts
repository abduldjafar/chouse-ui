/**
 * SSO Routes — /rbac/auth/sso/*
 */

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getSsoConfig } from "./config";
import { buildAuthorizationRedirect, exchangeCodeForIdentity } from "./client";
import { provisionSsoUser } from "./service";
import {
  signStatePayload,
  verifyStatePayload,
  SSO_STATE_COOKIE,
  SSO_STATE_TTL_SECONDS,
  type SsoStatePayload,
} from "./state";
import { createAuditLogWithContext } from "../services/rbac";
import { AUDIT_ACTIONS } from "../schema/base";
import { getClientIp } from "../middleware/rbacAuth";
import { requestLogger } from "../../utils/logger";
import { AppError } from "../../types";

const ssoRoutes = new Hono();

const CallbackSchema = z.object({
  code: z.string().min(1, "Authorization code is required"),
  state: z.string().min(1, "State is required"),
});

/** Only allow same-app relative redirect targets. */
function safeRedirect(target: string | undefined): string {
  if (!target || !target.startsWith("/") || target.startsWith("//")) return "/";
  return target;
}

const isProduction = (): boolean =>
  (process.env.NODE_ENV || "development") === "production";

/**
 * GET /rbac/auth/sso/providers — public list for the login page.
 */
ssoRoutes.get("/providers", (c) => {
  const config = getSsoConfig();
  const providers = config.enabled
    ? [...config.providers.values()].map((p) => ({
        id: p.id,
        displayName: p.displayName,
      }))
    : [];
  return c.json({ success: true, data: { providers } });
});

/**
 * GET /rbac/auth/sso/:provider/start — begin the authorization code flow.
 */
ssoRoutes.get("/:provider/start", async (c) => {
  const config = getSsoConfig();
  const provider = config.providers.get(c.req.param("provider"));
  if (!config.enabled || !provider) {
    throw AppError.notFound("Unknown SSO provider");
  }

  const redirect = safeRedirect(c.req.query("redirect"));
  // The provider id rides along in the redirect_uri so the SPA callback page
  // knows which provider to post back to. Must match the IdP-registered URI.
  const redirectUri = `${config.baseUrl}/auth/sso/callback?provider=${encodeURIComponent(provider.id)}`;

  let auth;
  try {
    auth = await buildAuthorizationRedirect(provider, redirectUri);
  } catch (error) {
    // Discovery/metadata failure: degrade gracefully, never crash the server.
    requestLogger(c.get("requestId")).error(
      {
        module: "SSO",
        provider: provider.id,
        err: error instanceof Error ? error.message : String(error),
      },
      "SSO provider discovery failed"
    );
    throw AppError.internal(
      "SSO provider is currently unavailable. Please try again later or use password login."
    );
  }

  const stateJwt = await signStatePayload({
    provider: provider.id,
    state: auth.state,
    nonce: auth.nonce,
    codeVerifier: auth.codeVerifier,
    redirect,
  });

  setCookie(c, SSO_STATE_COOKIE, stateJwt, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "Lax",
    path: "/",
    maxAge: SSO_STATE_TTL_SECONDS,
  });

  return c.redirect(auth.url, 302);
});

/**
 * POST /rbac/auth/sso/:provider/callback — finish the flow, mint tokens.
 */
ssoRoutes.post(
  "/:provider/callback",
  zValidator("json", CallbackSchema),
  async (c) => {
    const providerId = c.req.param("provider");
    const { code, state } = c.req.valid("json");
    const ipAddress = getClientIp(c);
    const config = getSsoConfig();
    const provider = config.providers.get(providerId);

    const stateCookie = getCookie(c, SSO_STATE_COOKIE);
    // One-time use: always clear, even on failure.
    deleteCookie(c, SSO_STATE_COOKIE, { path: "/" });

    try {
      if (!config.enabled || !provider)
        throw AppError.notFound("Unknown SSO provider");
      if (!stateCookie)
        throw AppError.unauthorized(
          "Sign-in session expired. Please try again."
        );

      let payload: SsoStatePayload;
      try {
        payload = await verifyStatePayload(stateCookie);
      } catch {
        throw AppError.unauthorized(
          "Sign-in session is invalid. Please try again."
        );
      }

      if (payload.provider !== providerId || payload.state !== state) {
        throw AppError.unauthorized(
          "Sign-in state mismatch. Please try again."
        );
      }

      // Must reconstruct the exact redirect_uri used in /start (incl. ?provider=).
      const callbackUrl = new URL(`${config.baseUrl}/auth/sso/callback`);
      callbackUrl.searchParams.set("provider", providerId);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", state);

      const identity = await exchangeCodeForIdentity(provider, callbackUrl, {
        codeVerifier: payload.codeVerifier,
        state: payload.state,
        nonce: payload.nonce,
      });

      const result = await provisionSsoUser(
        provider,
        identity,
        ipAddress,
        c.req.header("User-Agent")
      );

      await createAuditLogWithContext(c, AUDIT_ACTIONS.SSO_LOGIN, result.user.id, {
        details: { provider: providerId },
        ipAddress,
        status: "success",
      });

      return c.json({
        success: true,
        data: {
          user: result.user,
          tokens: result.tokens,
          redirect: payload.redirect,
        },
      });
    } catch (error) {
      await createAuditLogWithContext(
        c,
        AUDIT_ACTIONS.SSO_LOGIN_FAILED,
        undefined,
        {
          details: { provider: providerId },
          ipAddress,
          status: "failure",
          errorMessage:
            error instanceof Error ? error.message : "SSO login failed",
        }
      );
      if (error instanceof AppError) throw error;
      requestLogger(c.get("requestId")).warn(
        {
          module: "SSO",
          provider: providerId,
          err: error instanceof Error ? error.message : String(error),
        },
        "SSO code exchange failed"
      );
      throw AppError.unauthorized("SSO sign-in failed. Please try again.");
    }
  }
);

export default ssoRoutes;
