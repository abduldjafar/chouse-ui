import { describe, it, expect, mock } from 'bun:test';
mock.module('openid-client', () => ({
  discovery: async (url: URL) => {
    if (url.href.includes('bad')) throw Object.assign(new Error('discovery failed'), { code: 'OAUTH_X', cause: 'ENOTFOUND' });
    return {};
  },
}));
import { testProviderConfig } from './test';

describe('testProviderConfig', () => {
  it('returns ok for a reachable oidc issuer', async () => {
    const r = await testProviderConfig({ type: 'oidc', issuer: 'https://good.example.com', clientId: 'c', clientSecret: 's' });
    expect(r.ok).toBe(true);
  });
  it('returns error detail for a bad oidc issuer', async () => {
    const r = await testProviderConfig({ type: 'oidc', issuer: 'https://bad.example.com', clientId: 'c', clientSecret: 's' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe('ENOTFOUND');
  });
  it('returns error when oidc issuer is missing', async () => {
    const r = await testProviderConfig({ type: 'oidc', clientId: 'c', clientSecret: 's' });
    expect(r.ok).toBe(false);
  });
  it('returns error when oauth2 has invalid url', async () => {
    const r = await testProviderConfig({
      type: 'oauth2',
      authorizationEndpoint: 'not-a-url',
      tokenEndpoint: 'https://x.example.com/token',
      userinfoEndpoint: 'https://x.example.com/userinfo',
      clientId: 'c',
      clientSecret: 's',
    });
    expect(r.ok).toBe(false);
  });
  it('returns error when oauth2 is missing required endpoint', async () => {
    const r = await testProviderConfig({
      type: 'oauth2',
      authorizationEndpoint: 'https://x.example.com/auth',
      tokenEndpoint: 'https://x.example.com/token',
      // missing userinfoEndpoint
      clientId: 'c',
      clientSecret: 's',
    });
    expect(r.ok).toBe(false);
  });
});
