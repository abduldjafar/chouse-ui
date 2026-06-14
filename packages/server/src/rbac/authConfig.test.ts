import { describe, it, expect } from 'bun:test';
import { isPasswordLoginConfigured, resolvePasswordLoginEnabled } from './authConfig';

describe('isPasswordLoginConfigured', () => {
  it('defaults to true when the env var is absent', () => {
    expect(isPasswordLoginConfigured({})).toBe(true);
  });

  it('is true for any value other than "false"', () => {
    expect(isPasswordLoginConfigured({ AUTH_PASSWORD_LOGIN_ENABLED: 'true' })).toBe(true);
    expect(isPasswordLoginConfigured({ AUTH_PASSWORD_LOGIN_ENABLED: 'yes' })).toBe(true);
    expect(isPasswordLoginConfigured({ AUTH_PASSWORD_LOGIN_ENABLED: '' })).toBe(true);
  });

  it('is false only for the literal "false" (case-insensitive)', () => {
    expect(isPasswordLoginConfigured({ AUTH_PASSWORD_LOGIN_ENABLED: 'false' })).toBe(false);
    expect(isPasswordLoginConfigured({ AUTH_PASSWORD_LOGIN_ENABLED: 'FALSE' })).toBe(false);
    expect(isPasswordLoginConfigured({ AUTH_PASSWORD_LOGIN_ENABLED: 'False' })).toBe(false);
  });
});

describe('resolvePasswordLoginEnabled', () => {
  it('keeps password login on when configured on (regardless of SSO)', () => {
    expect(
      resolvePasswordLoginEnabled({ configured: true, ssoEnabled: false, providerCount: 0 })
    ).toEqual({ enabled: true, forced: false });
    expect(
      resolvePasswordLoginEnabled({ configured: true, ssoEnabled: true, providerCount: 3 })
    ).toEqual({ enabled: true, forced: false });
  });

  it('disables password login when off AND a usable SSO provider exists', () => {
    expect(
      resolvePasswordLoginEnabled({ configured: false, ssoEnabled: true, providerCount: 1 })
    ).toEqual({ enabled: false, forced: false });
  });

  it('fail-safe: keeps password login on when off but SSO is disabled', () => {
    expect(
      resolvePasswordLoginEnabled({ configured: false, ssoEnabled: false, providerCount: 0 })
    ).toEqual({ enabled: true, forced: true });
  });

  it('fail-safe: keeps password login on when off and SSO enabled but no usable provider', () => {
    expect(
      resolvePasswordLoginEnabled({ configured: false, ssoEnabled: true, providerCount: 0 })
    ).toEqual({ enabled: true, forced: true });
  });
});
