import { describe, it, expect } from 'bun:test';
import { loadSsoConfig } from './config';

function baseEnv(): Record<string, string> {
  return {
    AUTH_SSO_ENABLED: 'true',
    AUTH_SSO_BASE_URL: 'https://chouse.example.com',
    AUTH_SSO_DEFAULT_ROLE: 'viewer',
    AUTH_SSO_AUTO_LINK_BY_EMAIL: 'true',
    AUTH_SSO_PROVIDERS_OKTA_TYPE: 'oidc',
    AUTH_SSO_PROVIDERS_OKTA_DISPLAY_NAME: 'Okta',
    AUTH_SSO_PROVIDERS_OKTA_ISSUER: 'https://corp.okta.com',
    AUTH_SSO_PROVIDERS_OKTA_CLIENT_ID: 'cid',
    AUTH_SSO_PROVIDERS_OKTA_CLIENT_SECRET: 'csecret',
    AUTH_SSO_PROVIDERS_OKTA_SCOPES: 'openid profile email',
  };
}

describe('loadSsoConfig', () => {
  it('returns disabled config when AUTH_SSO_ENABLED is not true', () => {
    const cfg = loadSsoConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.providers.size).toBe(0);
  });

  it('parses an oidc provider', () => {
    const cfg = loadSsoConfig(baseEnv());
    expect(cfg.enabled).toBe(true);
    expect(cfg.baseUrl).toBe('https://chouse.example.com');
    expect(cfg.defaultRole).toBe('viewer');
    expect(cfg.autoLinkByEmail).toBe(true);
    const okta = cfg.providers.get('okta');
    expect(okta).toBeDefined();
    expect(okta!.type).toBe('oidc');
    expect(okta!.displayName).toBe('Okta');
    if (okta!.type === 'oidc') expect(okta!.issuer).toBe('https://corp.okta.com');
  });

  it('parses an oauth2 provider with claim mapping', () => {
    const env = {
      ...baseEnv(),
      AUTH_SSO_PROVIDERS_GITHUB_TYPE: 'oauth2',
      AUTH_SSO_PROVIDERS_GITHUB_DISPLAY_NAME: 'GitHub',
      AUTH_SSO_PROVIDERS_GITHUB_AUTHORIZATION_ENDPOINT: 'https://github.com/login/oauth/authorize',
      AUTH_SSO_PROVIDERS_GITHUB_TOKEN_ENDPOINT: 'https://github.com/login/oauth/access_token',
      AUTH_SSO_PROVIDERS_GITHUB_USERINFO_ENDPOINT: 'https://api.github.com/user',
      AUTH_SSO_PROVIDERS_GITHUB_CLIENT_ID: 'gid',
      AUTH_SSO_PROVIDERS_GITHUB_CLIENT_SECRET: 'gsecret',
      AUTH_SSO_PROVIDERS_GITHUB_SCOPES: 'read:user user:email',
      AUTH_SSO_PROVIDERS_GITHUB_CLAIM_MAPPING: 'subject:id,email:email,username:login',
    };
    const cfg = loadSsoConfig(env);
    const gh = cfg.providers.get('github');
    expect(gh).toBeDefined();
    expect(gh!.type).toBe('oauth2');
    if (gh!.type === 'oauth2') {
      expect(gh!.claimMapping).toEqual({ subject: 'id', email: 'email', username: 'login' });
    }
  });

  it('parses role mapping into a record', () => {
    const env = {
      ...baseEnv(),
      AUTH_SSO_PROVIDERS_OKTA_ROLE_MAPPING_CLAIM: 'groups',
      AUTH_SSO_PROVIDERS_OKTA_ROLE_MAPPING: 'ch-admins:admin,ch-devs:developer',
    };
    const okta = loadSsoConfig(env).providers.get('okta')!;
    expect(okta.roleMappingClaim).toBe('groups');
    expect(okta.roleMapping).toEqual({ 'ch-admins': 'admin', 'ch-devs': 'developer' });
  });

  it('skips an invalid provider but keeps valid ones', () => {
    const env = { ...baseEnv(), AUTH_SSO_PROVIDERS_BROKEN_TYPE: 'oidc' }; // missing everything else
    const cfg = loadSsoConfig(env);
    expect(cfg.providers.has('okta')).toBe(true);
    expect(cfg.providers.has('broken')).toBe(false);
  });

  it('throws when enabled without base_url', () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).AUTH_SSO_BASE_URL;
    expect(() => loadSsoConfig(env)).toThrow(/base_url/i);
  });

  it('supports provider ids containing underscores', () => {
    const env = {
      ...baseEnv(),
      AUTH_SSO_PROVIDERS_MY_IDP_TYPE: 'oidc',
      AUTH_SSO_PROVIDERS_MY_IDP_DISPLAY_NAME: 'My IdP',
      AUTH_SSO_PROVIDERS_MY_IDP_ISSUER: 'https://idp.example.com',
      AUTH_SSO_PROVIDERS_MY_IDP_CLIENT_ID: 'x',
      AUTH_SSO_PROVIDERS_MY_IDP_CLIENT_SECRET: 'y',
      AUTH_SSO_PROVIDERS_MY_IDP_SCOPES: 'openid',
    };
    expect(loadSsoConfig(env).providers.has('my_idp')).toBe(true);
  });

  it('defaults autoLinkByEmail to true when unset', () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).AUTH_SSO_AUTO_LINK_BY_EMAIL;
    expect(loadSsoConfig(env).autoLinkByEmail).toBe(true);
  });

  it('accepts uppercase provider type values', () => {
    const env = { ...baseEnv(), AUTH_SSO_PROVIDERS_OKTA_TYPE: 'OIDC' };
    expect(loadSsoConfig(env).providers.get('okta')!.type).toBe('oidc');
  });
});
