import { describe, it, expect, mock, beforeEach } from "bun:test";
import { normalizeOidcClaims, applyClaimMapping } from "./client";

describe("normalizeOidcClaims", () => {
  it("maps standard claims", () => {
    const id = normalizeOidcClaims("okta", {
      sub: "s1",
      email: "A@B.co",
      email_verified: true,
      preferred_username: "Alice",
      name: "Alice A",
    });
    expect(id).toEqual({
      provider: "okta",
      subject: "s1",
      email: "a@b.co",
      emailVerified: true,
      username: "alice",
      displayName: "Alice A",
      claims: expect.any(Object),
    });
  });

  it("throws without sub", () => {
    expect(() =>
      normalizeOidcClaims("okta", { email: "x@y.z" } as never)
    ).toThrow();
  });
});

describe("applyClaimMapping", () => {
  it("maps userinfo fields per provider claim_mapping", () => {
    const id = applyClaimMapping(
      "github",
      { subject: "id", email: "email", username: "login" },
      { id: 12345, email: "Dev@Example.com", login: "DevUser", name: "Dev User" }
    );
    expect(id.subject).toBe("12345");
    expect(id.email).toBe("dev@example.com");
    expect(id.username).toBe("devuser");
    // plain OAuth2 has no email_verified assertion
    expect(id.emailVerified).toBe(false);
  });

  it("throws when mapped subject field is missing", () => {
    expect(() =>
      applyClaimMapping("github", { subject: "id" }, { login: "x" })
    ).toThrow(/subject/);
  });
});

describe("buildAuthorizationRedirect (oauth2, real openid-client)", () => {
  beforeEach(async () => {
    const { resetProviderConfigurationCache } = await import("./client");
    resetProviderConfigurationCache();
  });

  it("returns url with PKCE, state, redirect_uri and NO nonce for oauth2", async () => {
    const { buildAuthorizationRedirect } = await import("./client");

    const providerCfg = {
      id: "gh",
      type: "oauth2" as const,
      displayName: "GitHub",
      clientId: "client-id",
      clientSecret: "client-secret",
      scopes: "read:user user:email",
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      userinfoEndpoint: "https://api.github.com/user",
      claimMapping: { subject: "id", email: "email", username: "login" },
    };

    const result = await buildAuthorizationRedirect(
      providerCfg,
      "https://app.example.com/callback"
    );

    const url = new URL(result.url);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/callback"
    );
    expect(url.searchParams.get("scope")).toBe("read:user user:email");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // OAuth2 providers should NOT include nonce in the URL
    expect(url.searchParams.has("nonce")).toBe(false);
    // returned state must match url param
    expect(result.state).toBe(url.searchParams.get("state"));
    // codeVerifier is non-empty
    expect(result.codeVerifier.length).toBeGreaterThan(0);
  });
});

describe("buildAuthorizationRedirect (oidc, mocked discovery)", () => {
  it("includes nonce in URL for oidc provider", async () => {
    // Mock openid-client so discovery() does not hit the network.
    // We use a real Configuration with manually-supplied server metadata.
    const oidcReal = await import("openid-client");
    const fakeOidcCfg = new oidcReal.Configuration(
      {
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
      },
      "client-id",
      "client-secret"
    );

    mock.module("openid-client", () => ({
      ...oidcReal,
      discovery: async () => fakeOidcCfg,
    }));

    // Dynamic import so the mock is applied before the module runs.
    const { buildAuthorizationRedirect, resetProviderConfigurationCache } =
      await import("./client");
    resetProviderConfigurationCache();

    const oidcProvider = {
      id: "google",
      type: "oidc" as const,
      displayName: "Google",
      clientId: "client-id",
      clientSecret: "client-secret",
      scopes: "openid email profile",
      issuer: "https://accounts.google.com",
    };

    const result = await buildAuthorizationRedirect(
      oidcProvider,
      "https://app.example.com/callback"
    );
    const url = new URL(result.url);
    expect(url.searchParams.has("nonce")).toBe(true);
    expect(result.nonce).toBe(url.searchParams.get("nonce"));
    expect(url.searchParams.has("code_challenge")).toBe(true);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
