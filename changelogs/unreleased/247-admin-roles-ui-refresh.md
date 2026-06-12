type: minor

### Added
- **Role wizard** — Creating or editing a role is now a guided 3-step wizard (Details → Permissions → Data Access & Review), matching the Data Access Policies flow.
- **Data Access on role cards** — Each role card surfaces its assigned data access policies: a count badge in the stat row and named policy chips in the expanded view.
- **Roles in Identity & access** — The Preferences Identity & access card now lists the signed-in user's roles.

### Changed
- **Admin navigation** — The Admin header is now a two-tier nav: grouped section chips on top with the active group's sections shown below as sub-tabs.
- **Data Access section header** — Now uses the standard icon + title + count header to match the other admin sections.
- **Preferences cards** — Row-one cards are equal height; the ClickHouse node rows align the card with Identity & access. Monitoring's title and refresh controls gained breathing room from the header divider.

### Fixed
- **"Other" permission label** — `data_access` permissions now display as "Data Access" instead of "Other" on role cards.
- **Inconsistent role labels** — User-list cards always show a readable role display name instead of occasionally leaking the raw role key.
