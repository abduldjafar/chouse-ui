type: major

### Added
- **Data Access Policies** — database/table access is now defined as named, reusable policies managed under a new **Admin → Data Access** tab. A policy is a set of rules; each rule is scoped to a specific connection and grants/denies database/table patterns there. Policies are attached to roles many-to-many via a new `/rbac/data-access-policies` API and the new `data_access:view/create/update/delete/assign` permissions.
- **Roles carry data access** — the role form now requires at least one data access policy for custom (non-system) roles, making roles the primary access-control mechanism.
- **Policy wizard with table picker** — a 3-step wizard (Connections → Access → Details & Review): pick one or more connections (or "select all"), then for each connection independently browse its real databases and tables (auto-listed; tables lazy-loaded on expand) and tick the ones to grant — with whole-database (`*`) selection, wildcard/regex pattern rules, and allow/deny per connection — then name and review.

### Changed
- **One role per user** — each user now has exactly one role (enforced in the API and by a `UNIQUE(user_id)` index on `rbac_user_roles`). A user's effective data access is the union of the rules in the policies attached to their role; deny rules still take precedence by priority.
- **Connection access comes from data access policies** — whether a user can open a connection is derived from their role's policies: a rule scoped to a connection grants access to that connection. (Super admins still see all connections.)
- **Migration** — on upgrade, each user's *effective* legacy access is snapshotted into the new model: their connection grants and connection-scoped rules determine which connections they can reach, and global (all-connection) rules are expanded onto exactly those connections — so no access is lost and none is over-granted. Users with multiple roles or per-user rules are collapsed onto a single (de-duplicated) generated role; `super_admin`/`admin` users keep their privileged role.

### Removed
- **User-level data access rules** — per-user database/table rules and their UI (the data access section in user create/edit) have been removed. Data access is granted through the role's policies only. The `/rbac/data-access/user/*` endpoints, the `bulkSetForUser` client method, and the per-rule `accessType` field are gone (access type is determined by role permissions).
- **Per-user connection access** — the "Manage Access" UI on connections and the `rbac_user_connections` table are removed; connection access is now derived from data access policies (see above).

> **Note for operators:** after upgrading, non-admin users see no databases until an admin attaches a data access policy to their role (this matches prior secure-by-default behaviour; existing users' access is preserved by the migration).
