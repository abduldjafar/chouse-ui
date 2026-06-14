type: patch

### Fixed
- **Admin page hidden despite having access** — The Admin page, its nav entry, and the default-landing redirect were gated on an incomplete permission list (only users/roles/audit), so a user holding only another admin permission (SSO, connections, ClickHouse users/roles, data access, or AI models) was bounced from `/admin` even though they had a tab to see. All access checks now derive from a single source of truth, so any one admin-tab permission reveals the page and that tab.
