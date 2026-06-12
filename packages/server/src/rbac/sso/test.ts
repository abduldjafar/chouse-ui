/**
 * SSO Provider Test — live validation before save. OIDC attempts discovery;
 * oauth2 validates endpoint URLs and a reachability probe. Never persists.
 */

import * as oidc from 'openid-client';
import { describeSsoError } from './errors';

export interface TestCandidate {
  type: 'oidc' | 'oauth2';
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  clientId: string;
  clientSecret: string;
}

export type TestResult = { ok: true } | ({ ok: false } & Record<string, unknown>);

export async function testProviderConfig(c: TestCandidate): Promise<TestResult> {
  try {
    if (c.type === 'oidc') {
      if (!c.issuer) return { ok: false, err: 'issuer is required for oidc' };
      await oidc.discovery(new URL(c.issuer), c.clientId, c.clientSecret);
      return { ok: true };
    }
    for (const [name, url] of [
      ['authorization_endpoint', c.authorizationEndpoint],
      ['token_endpoint', c.tokenEndpoint],
      ['userinfo_endpoint', c.userinfoEndpoint],
    ] as const) {
      if (!url) return { ok: false, err: `${name} is required for oauth2` };
      new URL(url); // throws on invalid
    }
    // Reachability probe of the userinfo endpoint (unauthenticated 401 is fine — it's up).
    const res = await fetch(c.userinfoEndpoint as string, { method: 'GET' });
    if (res.status >= 500) return { ok: false, err: `userinfo_endpoint returned ${res.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, ...describeSsoError(error) };
  }
}
