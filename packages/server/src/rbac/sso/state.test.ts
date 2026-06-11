import { describe, it, expect } from 'bun:test';
import { signStatePayload, verifyStatePayload, SSO_STATE_COOKIE } from './state';
import { getJwtSecretKey } from '../services/jwt';

describe('SSO state cookie payload', () => {
  const payload = { provider: 'okta', state: 'st1', nonce: 'n1', codeVerifier: 'cv1', redirect: '/fleet' };

  it('round-trips a signed payload', async () => {
    const jwt = await signStatePayload(payload);
    expect(typeof jwt).toBe('string');
    const back = await verifyStatePayload(jwt);
    expect(back).toMatchObject(payload);
  });

  it('rejects tampered tokens', async () => {
    const jwt = await signStatePayload(payload);
    await expect(verifyStatePayload(jwt.slice(0, -2) + 'xx')).rejects.toThrow();
  });

  it('rejects structurally valid JWTs missing required fields', async () => {
    // sign a JWT with the same secret and correct audience but wrong shape
    const { SignJWT } = await import('jose');
    const bad = await new SignJWT({ provider: 'okta' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('10m')
      .setAudience('chouse-sso-state')
      .sign(getJwtSecretKey());
    await expect(verifyStatePayload(bad)).rejects.toThrow(/Malformed/);
  });

  it('rejects a JWT signed with the right key but missing the state audience', async () => {
    // A token with the right key + right shape but no audience claim must be
    // rejected — ensuring state tokens are cryptographically disjoint from
    // access/refresh tokens which carry a different aud.
    const { SignJWT } = await import('jose');
    const wrongAud = await new SignJWT({ ...payload })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('10m')
      // deliberately omit setAudience
      .sign(getJwtSecretKey());
    await expect(verifyStatePayload(wrongAud)).rejects.toThrow();
  });

  it('exports a cookie name', () => {
    expect(SSO_STATE_COOKIE).toBe('chouse_sso_state');
  });
});
