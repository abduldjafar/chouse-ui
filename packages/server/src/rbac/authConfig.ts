/**
 * Authentication Configuration
 *
 * Controls whether password ("basic auth") login is offered, alongside the SSO
 * config. Password login is ON by default; an operator can turn it off (env
 * AUTH_PASSWORD_LOGIN_ENABLED=false, or YAML auth.password_login.enabled: false
 * which the loader flattens to the same env var) to force all sign-ins through
 * an identity provider.
 *
 * Fail-safe: password login may only actually be disabled when there is at least
 * one *usable* SSO provider. If it is requested off but no valid provider is
 * configured, we keep it ENABLED so admins are never locked out. Provider
 * validity is already guaranteed by the SSO config layer — invalid providers are
 * dropped by Zod in loadSsoConfig/buildSsoConfig, so a non-empty providers map
 * means ≥1 valid, brand-resolvable provider.
 */

import { logger } from '../utils/logger';
import { getSsoConfig } from './sso/config';

/**
 * Whether the operator has asked for password login to be ON. Defaults to true;
 * only the literal "false" disables it. This is the *requested* state, before
 * the fail-safe SSO check is applied.
 */
export function isPasswordLoginConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (env.AUTH_PASSWORD_LOGIN_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export interface PasswordLoginResolution {
  /** Effective state actually enforced. */
  enabled: boolean;
  /**
   * True when the operator requested password login OFF but we kept it ON
   * anyway because no usable SSO provider exists (lockout prevention).
   */
  forced: boolean;
}

/**
 * Resolve the effective password-login state from the requested config and the
 * current SSO posture. Pure and synchronous so it is trivially testable.
 */
export function resolvePasswordLoginEnabled(input: {
  configured: boolean;
  ssoEnabled: boolean;
  providerCount: number;
}): PasswordLoginResolution {
  if (input.configured) {
    return { enabled: true, forced: false };
  }
  const hasUsableSso = input.ssoEnabled && input.providerCount > 0;
  if (hasUsableSso) {
    return { enabled: false, forced: false };
  }
  return { enabled: true, forced: true };
}

// Effective state cached for the hot path (the login route + the public config
// endpoint). Mirrors getSsoConfig()'s lazy-until-first-refresh pattern.
let cache: PasswordLoginResolution | null = null;

/** Sync accessor on the hot path. Falls back to a live computation until the first refresh. */
export function getPasswordLoginEnabled(): boolean {
  if (cache) return cache.enabled;
  const sso = getSsoConfig();
  return resolvePasswordLoginEnabled({
    configured: isPasswordLoginConfigured(),
    ssoEnabled: sso.enabled,
    providerCount: sso.providers.size,
  }).enabled;
}

/**
 * Recompute the effective state against the current SSO config and cache it.
 * Call at boot after refreshSsoConfig(), and after any SSO admin mutation that
 * changes the usable-provider count. Logs a loud error on the fail-safe override.
 */
export function refreshPasswordLoginState(): PasswordLoginResolution {
  const sso = getSsoConfig();
  const resolution = resolvePasswordLoginEnabled({
    configured: isPasswordLoginConfigured(),
    ssoEnabled: sso.enabled,
    providerCount: sso.providers.size,
  });
  cache = resolution;

  if (resolution.forced) {
    logger.error(
      { module: 'Auth', ssoEnabled: sso.enabled, providerCount: sso.providers.size },
      'Password login was requested OFF but no usable SSO provider is configured — keeping password login ENABLED to avoid lockout'
    );
  } else {
    logger.info(
      { module: 'Auth', passwordLoginEnabled: resolution.enabled },
      `Password login ${resolution.enabled ? 'enabled' : 'disabled (SSO required)'}`
    );
  }

  return resolution;
}

/** Test-only: clear the cache. */
export function resetPasswordLoginCache(): void {
  cache = null;
}
