# CLAUDE.md

Project-level instructions for AI agents working on CHouse UI.

## Project Overview

CHouse UI is a web interface for ClickHouse with built-in RBAC, fleet monitoring, and an AI SRE. Apache 2.0 licensed.

**Monorepo layout:**
- `src/` — Frontend (React 19 + Vite 7 SPA)
- `packages/server/` — Backend (Bun + Hono v4 API server)
- `docs/portfolio/` — Marketing/docs website (separate Vite app)

## Quick Reference

### Commands

```bash
bun install                    # Install dependencies
bun run dev                    # Start frontend (:5173) + backend (:5521)
bun run dev:web                # Frontend only
bun run dev:server             # Backend only
bun run build                  # Build both frontend and server
bun run lint                   # ESLint
bun run typecheck              # TypeScript check (tsc --noEmit)
bunx vitest run                # Frontend tests
./scripts/test-isolated-server.sh  # Server tests
```

### Default Login

- Email: `admin@localhost` / Username: `admin` / Password: `admin123!`

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | React 19, Vite 7, React Router v7, Zustand 5, TanStack Query v5, shadcn/ui, Tailwind CSS 4, Monaco Editor, AG Grid |
| **Backend** | Bun, Hono v4, Drizzle ORM (SQLite / PostgreSQL), Pino logger |
| **AI** | Vercel AI SDK v6, multi-provider (OpenAI, Anthropic, Google, etc.) |
| **ClickHouse** | `@clickhouse/client` (server), `@clickhouse/client-web` (frontend) |
| **Testing** | Vitest + jsdom + MSW (frontend), Bun Test (server) |

## Architecture

**Key patterns:**
- Frontend uses feature-based organization under `src/features/`
- State: Zustand stores in `src/stores/`, data fetching via TanStack Query
- API client modules in `src/api/`
- Server routes in `packages/server/src/routes/`, services in `packages/server/src/services/`
- RBAC subsystem in `packages/server/src/rbac/`

## Code Standards

### TypeScript
- Strict mode enabled, never use `any` (use `unknown` + type guards)
- Explicit return types on functions
- Avoid `as` type assertions; prefer type narrowing
- Import order: React > third-party > internal (`@/`) > types
- Use `import type` for type-only imports

### React
- Functional components only, props typed via interfaces
- Zustand for global state, `useState` for local state
- `useMemo`/`useCallback` for expensive computations and child callbacks
- Always return cleanup functions from `useEffect` (timers, controllers, subscriptions)
- Use `React.lazy` + `Suspense` for code splitting

### Logging
- **Client** (`src/`): Use `import { log } from '@/lib/log'` — never raw `console.*`
- **Server** (`packages/server/`): Use `logger` from `utils/logger.ts` (Pino) or `requestLogger(c.get('requestId'))` in route handlers — never raw `console.*`
- Never log passwords, tokens, or PII

### Error Handling
- **Client**: try-catch with `toast.error()` for user-facing messages, `log.error()` for logging
- **Server**: Use `AppError` class (`AppError.notFound()`, `AppError.internal()`, etc.) with proper HTTP status codes
- Always clean up resources (connections, timers, AbortControllers)

### Security
- Passwords: Argon2id via `Bun.password.hash` (NOT bcrypt)
- JWT: `jose` library (NOT jsonwebtoken)
- Connection password encryption: AES-256-GCM
- Validation: Zod v4 (frontend), Zod v3 (server)
- Server routes: `rbacAuthMiddleware` + `requirePermission` middleware
- Client: `PermissionGuard` component for UI gating
- SQL injection prevention via `node-sql-parser` middleware
- Never use `dangerouslySetInnerHTML` without DOMPurify

### Testing
- Test files co-located with source: `file.ts` -> `file.test.ts`
- **Required for**: `src/api/*`, `src/hooks/*`, `src/lib/*`, `src/helpers/*`, `src/stores/*`, `src/utils/*`
- **Optional for**: pure UI components without complex logic
- Frontend: Vitest + jsdom, MSW for API mocking, React Testing Library for hooks
- Server: Bun Test + Hono test utilities
- Zustand store tests must use dynamic imports to avoid persist initialization issues
- Coverage goal: 80%+ on utilities and API modules

### Code Organization
- Feature-based structure (not file-type-based)
- Named exports for utilities/components; default exports only for page components
- Barrel exports via `index.ts`
- Naming: PascalCase (components/types), camelCase (hooks/utils), UPPER_SNAKE_CASE (constants)

### Style
- 2-space indentation, trailing commas, double quotes, semicolons
- Comments explain *why*, not *what* — no commented-out code
- JSDoc only for complex functions

## When to Apply Each Rule

| Situation | Rule file to follow |
|-----------|-------------------|
| Writing or modifying any code | **[.rules/CODE_CHANGES.md](.rules/CODE_CHANGES.md)** — standards, patterns, pre-commit checklist |
| Reviewing a PR or diff, or self-checking before marking a task done | **[.rules/CODE_REVIEWER.md](.rules/CODE_REVIEWER.md)** — review checklist, approval criteria, common issues |
| After finishing a task — scan files you touched | **[.rules/DEAD_CODE.md](.rules/DEAD_CODE.md)** — remove unused imports, symbols, exports left behind |
| Proactively scanning the codebase for cleanup | **[.rules/DEAD_CODE.md](.rules/DEAD_CODE.md)** — full scan process including dependency and barrel-export checks |
| A change is user-visible (new feature, bug fix, removal) | Update `## [Unreleased]` in `CHANGELOG.md` using `Added / Changed / Fixed / Removed` categories |
