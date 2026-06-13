import { describe, it, expect } from "bun:test";
import { makeSignedSamlResponse } from "../testFixtures/samlFixtures";
import {
  validateSamlResponse,
  buildSamlAuthnRequest,
  resolveSamlProviderByIssuer,
  type SamlProviderConfig,
} from "./client";

function provider(overrides: Partial<SamlProviderConfig> = {}): SamlProviderConfig {
  return {
    id: "okta",
    type: "saml",
    source: "database",
    displayName: "Okta",
    samlIdpEntityId: "https://idp.test/entity",
    samlIdpSsoUrl: "https://idp.test/sso",
    samlIdpCertificate: overrides.samlIdpCertificate ?? "",
    samlSpEntityId: "https://app.test/sp",
    samlNameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    samlAllowIdpInitiated: true,
    claimMapping: undefined,
    roleMappingClaim: "groups",
    roleMapping: undefined,
    ...overrides,
  };
}
const ACS = "https://app.test/auth/sso/saml/acs";

describe("validateSamlResponse", () => {
  it("verifies a signed assertion and maps NameID + attributes to SsoIdentity", async () => {
    const { samlResponseB64, idpCertPem } = await makeSignedSamlResponse({
      attributes: { groups: ["ch-dev", "all"] },
    });
    const id = await validateSamlResponse(
      provider({ samlIdpCertificate: idpCertPem }),
      { SAMLResponse: samlResponseB64 },
      ACS
    );
    expect(id.subject).toBe("alice@corp.test");
    expect(id.email).toBe("alice@corp.test");
    expect(id.emailVerified).toBe(true);
    expect(id.claims.groups).toEqual(["ch-dev", "all"]);
  });

  it("rejects a tampered assertion", async () => {
    const { samlResponseB64, idpCertPem } = await makeSignedSamlResponse({ tamperAfterSign: true });
    await expect(
      validateSamlResponse(
        provider({ samlIdpCertificate: idpCertPem }),
        { SAMLResponse: samlResponseB64 },
        ACS
      )
    ).rejects.toThrow();
  });

  it("rejects an unsigned assertion", async () => {
    const { samlResponseB64, idpCertPem } = await makeSignedSamlResponse({ sign: false });
    await expect(
      validateSamlResponse(
        provider({ samlIdpCertificate: idpCertPem }),
        { SAMLResponse: samlResponseB64 },
        ACS
      )
    ).rejects.toThrow();
  });

  it("rejects wrong audience", async () => {
    const { samlResponseB64, idpCertPem } = await makeSignedSamlResponse({ audience: "https://evil/sp" });
    await expect(
      validateSamlResponse(
        provider({ samlIdpCertificate: idpCertPem }),
        { SAMLResponse: samlResponseB64 },
        ACS
      )
    ).rejects.toThrow();
  });

  it("rejects an expired assertion", async () => {
    const { samlResponseB64, idpCertPem } = await makeSignedSamlResponse({
      notBefore: new Date(Date.now() - 2 * 3600_000).toISOString(),
      notOnOrAfter: new Date(Date.now() - 3600_000).toISOString(), // expired 1h ago
    });
    await expect(
      validateSamlResponse(
        provider({ samlIdpCertificate: idpCertPem }),
        { SAMLResponse: samlResponseB64 },
        ACS
      )
    ).rejects.toThrow();
  });

  it("rejects a provider with no IdP certificate configured (fail-closed, clear error)", async () => {
    const { samlResponseB64 } = await makeSignedSamlResponse({});
    await expect(
      validateSamlResponse(provider({ samlIdpCertificate: "" }), { SAMLResponse: samlResponseB64 }, ACS),
    ).rejects.toThrow(/no IdP certificate/i);
  });

  it("applies claimMapping to override email/username source", async () => {
    const { samlResponseB64, idpCertPem } = await makeSignedSamlResponse({
      attributes: { mail: "a@b.co", uid: "alice", groups: "ch-dev" },
    });
    const id = await validateSamlResponse(
      provider({
        samlIdpCertificate: idpCertPem,
        claimMapping: { email: "mail", username: "uid" },
      }),
      { SAMLResponse: samlResponseB64 },
      ACS
    );
    expect(id.email).toBe("a@b.co");
    expect(id.username).toBe("alice");
  });
});

describe("buildSamlAuthnRequest", () => {
  it("returns a redirect URL to the IdP SSO endpoint carrying RelayState + SAMLRequest", async () => {
    const { url } = await buildSamlAuthnRequest(provider(), ACS, "relay-xyz");
    expect(url.startsWith("https://idp.test/sso")).toBe(true);
    expect(url).toContain("RelayState=relay-xyz");
    expect(url).toContain("SAMLRequest=");
  });
});

describe("resolveSamlProviderByIssuer", () => {
  it("matches a saml provider by its IdP entityID; ignores non-saml", () => {
    const list = [
      { id: "o", type: "oidc" },
      { id: "s", type: "saml", samlIdpEntityId: "https://idp.test/entity" },
    ] as never[];
    expect(resolveSamlProviderByIssuer(list, "https://idp.test/entity")?.id).toBe("s");
    expect(resolveSamlProviderByIssuer(list, "https://other")).toBeUndefined();
  });
});
