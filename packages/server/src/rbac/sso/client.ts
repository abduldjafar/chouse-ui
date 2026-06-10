/**
 * SSO Client Wrapper
 *
 * Thin layer over openid-client v6: provider Configuration cache,
 * authorization-URL building, code exchange, identity normalization.
 */

import * as oidc from "openid-client";
import type { SsoProviderConfig } from "./config";

export interface SsoIdentity {
  provider: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  username: string | null;
  displayName: string | null;
  claims: Record<string, unknown>;
}

const configCache = new Map<string, oidc.Configuration>();

export async function getProviderConfiguration(
  p: SsoProviderConfig
): Promise<oidc.Configuration> {
  const hit = configCache.get(p.id);
  if (hit) return hit;

  let cfg: oidc.Configuration;
  if (p.type === "oidc") {
    cfg = await oidc.discovery(new URL(p.issuer), p.clientId, p.clientSecret);
  } else {
    // Configuration 3rd param accepts a bare string as shorthand for client_secret
    cfg = new oidc.Configuration(
      {
        issuer: `urn:chouse:sso:${p.id}`,
        authorization_endpoint: p.authorizationEndpoint,
        token_endpoint: p.tokenEndpoint,
        userinfo_endpoint: p.userinfoEndpoint,
      },
      p.clientId,
      p.clientSecret
    );
  }
  configCache.set(p.id, cfg);
  return cfg;
}

/** Test-only: clear discovery cache. */
export function resetProviderConfigurationCache(): void {
  configCache.clear();
}

export interface AuthorizationRedirect {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export async function buildAuthorizationRedirect(
  p: SsoProviderConfig,
  redirectUri: string
): Promise<AuthorizationRedirect> {
  const cfg = await getProviderConfiguration(p);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();

  const params: Record<string, string> = {
    redirect_uri: redirectUri,
    scope: p.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };
  if (p.type === "oidc") params.nonce = nonce;

  const url = oidc.buildAuthorizationUrl(cfg, params);
  return { url: url.toString(), state, nonce, codeVerifier };
}

export async function exchangeCodeForIdentity(
  p: SsoProviderConfig,
  callbackUrl: URL,
  checks: { codeVerifier: string; state: string; nonce: string }
): Promise<SsoIdentity> {
  const cfg = await getProviderConfiguration(p);

  const tokens = await oidc.authorizationCodeGrant(cfg, callbackUrl, {
    pkceCodeVerifier: checks.codeVerifier,
    expectedState: checks.state,
    ...(p.type === "oidc"
      ? { expectedNonce: checks.nonce, idTokenExpected: true }
      : {}),
  });

  if (p.type === "oidc") {
    const claims = tokens.claims();
    if (!claims) {
      throw new Error(`[SSO] Provider ${p.id} returned no ID token claims`);
    }
    return normalizeOidcClaims(p.id, claims as Record<string, unknown>);
  }

  const userinfo = await oidc.fetchUserInfo(
    cfg,
    tokens.access_token,
    oidc.skipSubjectCheck
  );
  return applyClaimMapping(
    p.id,
    p.claimMapping,
    userinfo as Record<string, unknown>
  );
}

export function normalizeOidcClaims(
  providerId: string,
  claims: Record<string, unknown>
): SsoIdentity {
  const subject = claims.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    throw new Error(
      `[SSO] Provider ${providerId} ID token has no sub claim`
    );
  }
  const email =
    typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  const username =
    typeof claims.preferred_username === "string"
      ? claims.preferred_username.toLowerCase()
      : null;
  return {
    provider: providerId,
    subject,
    email,
    emailVerified: claims.email_verified === true,
    username,
    displayName:
      typeof claims.name === "string" ? claims.name : null,
    claims,
  };
}

export function applyClaimMapping(
  providerId: string,
  mapping: Record<string, string>,
  userinfo: Record<string, unknown>
): SsoIdentity {
  const pick = (field: string | undefined): string | null => {
    if (!field) return null;
    const v = userinfo[field];
    if (v === undefined || v === null) return null;
    return String(v);
  };

  const subject = pick(mapping.subject);
  if (!subject) {
    throw new Error(
      `[SSO] Provider ${providerId} userinfo is missing mapped subject field "${mapping.subject}"`
    );
  }
  const email = pick(mapping.email);
  const username = pick(mapping.username);

  return {
    provider: providerId,
    subject,
    email: email ? email.toLowerCase() : null,
    emailVerified: false, // plain OAuth2 cannot assert verification
    username: username ? username.toLowerCase() : null,
    displayName:
      typeof userinfo.name === "string" ? userinfo.name : null,
    claims: userinfo,
  };
}
