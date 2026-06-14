type: minor

### Added
- **Disable password login** — A new `auth.password_login.enabled` setting (env `AUTH_PASSWORD_LOGIN_ENABLED`) lets operators turn off username/password sign-in to require SSO. Enabled by default. Fail-safe: it is ignored unless at least one usable SSO provider is configured, so a misconfiguration can never lock everyone out. The login page hides the password form and `POST /rbac/auth/login` returns `403` when disabled.
- **SSO setup guide** — New on-page SSO section on the docs site plus a full [`docs/sso.md`](docs/sso.md) reference covering OIDC / OAuth2 / SAML setup, config vs. UI precedence, role mapping, and security notes.
