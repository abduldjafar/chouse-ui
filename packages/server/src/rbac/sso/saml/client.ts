/**
 * SAML client — wraps @node-saml/node-saml. Builds AuthnRequests (SP-initiated)
 * and validates SAMLResponses (both flows), producing the shared SsoIdentity.
 * Signature verification is mandatory (wantAssertionsSigned) and delegated to
 * node-saml's vetted XML-DSig — never bypassed.
 */
import { SAML, type SamlConfig } from "@node-saml/node-saml";
import type { SsoIdentity } from "../client";

export interface SamlProviderConfig {
  id: string;
  type: "saml";
  source: "config" | "database";
  displayName: string;
  samlIdpEntityId: string;
  samlIdpSsoUrl: string;
  samlIdpCertificate: string;
  samlSpEntityId: string;
  samlNameIdFormat?: string;
  samlAllowIdpInitiated?: boolean;
  claimMapping?: Record<string, string>;
  roleMappingClaim?: string;
  roleMapping?: Record<string, string>;
}

// node-saml asserts idpCert is present at construction time, even for building
// an AuthnRequest (which needs no IdP trust anchor). Supply a harmless empty-PEM
// placeholder so SP-initiated requests can be built without a configured cert.
// This placeholder can never validate a real signed response — any tampered or
// genuinely-signed assertion fails verification against it, which is the desired
// fail-closed behaviour.
const NO_VERIFY_CERT_PLACEHOLDER =
  "-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----";

function instance(p: SamlProviderConfig, acsUrl: string): SAML {
  const cfg: SamlConfig = {
    issuer: p.samlSpEntityId,
    callbackUrl: acsUrl,
    entryPoint: p.samlIdpSsoUrl,
    idpCert: p.samlIdpCertificate || NO_VERIFY_CERT_PLACEHOLDER,
    audience: p.samlSpEntityId,
    identifierFormat: p.samlNameIdFormat ?? null,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 5000,
  };
  return new SAML(cfg);
}

export async function buildSamlAuthnRequest(
  p: SamlProviderConfig,
  acsUrl: string,
  relayState: string
): Promise<{ url: string }> {
  const url = await instance(p, acsUrl).getAuthorizeUrlAsync(relayState, undefined, {});
  return { url };
}

export async function validateSamlResponse(
  p: SamlProviderConfig,
  body: { SAMLResponse: string; RelayState?: string },
  acsUrl: string
): Promise<SsoIdentity> {
  if (!p.samlIdpCertificate || !p.samlIdpCertificate.trim()) {
    throw new Error(`[SAML] Provider ${p.id} has no IdP certificate configured; cannot validate assertions`);
  }
  const { profile } = await instance(p, acsUrl).validatePostResponseAsync(body);
  if (!profile) throw new Error("[SAML] No profile in validated response");

  const attributes =
    profile.attributes && typeof profile.attributes === "object"
      ? (profile.attributes as Record<string, unknown>)
      : {};
  const claims: Record<string, unknown> = { ...attributes };

  const pick = (key: string | undefined): string | null => {
    if (!key) return null;
    const v = claims[key];
    if (Array.isArray(v)) return v.length ? String(v[0]) : null;
    return v == null ? null : String(v);
  };

  const m = p.claimMapping ?? {};
  const nameID = typeof profile.nameID === "string" ? profile.nameID : String(profile.nameID ?? "");
  const subject = pick(m.subject) ?? nameID;
  if (!subject) throw new Error("[SAML] Assertion has no usable subject");
  const mappedEmail = pick(m.email);
  const email = mappedEmail ?? (nameID.includes("@") ? nameID : null);
  const username = pick(m.username);
  return {
    provider: p.id,
    subject,
    email: email ? email.toLowerCase() : null,
    emailVerified: true, // signed assertion from a trusted IdP — see design
    username: username ? username.toLowerCase() : null,
    displayName: pick(m.displayName),
    claims: { ...claims, nameID },
  };
}

export function resolveSamlProviderByIssuer<
  T extends { samlIdpEntityId?: string | null; type: string }
>(providers: Iterable<T>, issuer: string): T | undefined {
  for (const p of providers) {
    if (p.type === "saml" && p.samlIdpEntityId === issuer) return p;
  }
  return undefined;
}
