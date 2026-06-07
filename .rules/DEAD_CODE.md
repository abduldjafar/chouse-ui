# Dead Code Rules

Guidelines for identifying and safely removing unused code — both proactively during scans and after making changes.

---

## What Counts as Dead Code

- **Unused imports** — imported but never referenced in the file
- **Unused variables/constants** — declared but never read
- **Unused functions/hooks** — defined but never called anywhere in the codebase
- **Unused components** — exported but never imported anywhere
- **Unused types/interfaces** — defined but not referenced
- **Unreachable code** — code after an unconditional `return`/`throw`, or in a branch that can never be true
- **Commented-out code** — code left behind "just in case"
- **Unused exports** — exported symbols with no external consumer in this monorepo
- **Unused dependencies** — packages in `package.json` not imported anywhere
- **Stale feature flags** — conditional blocks for a flag that is always true/false

---

## How to Identify Dead Code

### Automated (run these first)

```bash
# TypeScript catches unused locals and parameters (strict mode)
bun run typecheck

# ESLint catches no-unused-vars, no-unused-imports
bun run lint

# Find all exports of a symbol and check if anything imports it
grep -rn "import.*<SymbolName>" src/ packages/
```

### Manual scan checklist

When reviewing a file or after making changes:

1. Scan imports at the top — delete any that TypeScript/ESLint didn't flag but are visibly unused
2. Check if removed functions/components are still exported from `index.ts` barrel files
3. Search for the symbol name across the whole monorepo before deleting:
   ```bash
   grep -rn "SymbolName" src/ packages/ --include="*.ts" --include="*.tsx"
   ```
4. Check for dynamic usage: string-keyed registries, `React.lazy(() => import('./Component'))`, route configs
5. For removed API endpoints, verify no client-side `api/*.ts` module still calls them

---

## Safe Removal Process

### Step 1 — Confirm it is truly unused
- Global search (`grep -rn`) across `src/` and `packages/` for the exact symbol name
- Check barrel `index.ts` files — a symbol may look unused locally but be re-exported
- Check test files — something used only in tests is NOT dead code
- Check dynamic patterns: string keys (`'MyComponent'`), registry objects, lazy imports

### Step 2 — Remove in the right order
1. Remove the usage sites first (if any remain), then the definition
2. Remove from barrel `index.ts` exports before deleting the file
3. Delete the file only after all import paths resolve cleanly

### Step 3 — Verify
```bash
bun run typecheck   # Must pass with no new errors
bun run lint        # Must pass
bunx vitest run     # Must pass — dead code removal should never break tests
```

---

## What NOT to Remove

| Pattern | Reason |
|---------|--------|
| Code used only in `*.test.ts` files | Test-only usage is valid usage |
| Symbols exported from `src/` that `packages/server/` consumes | Cross-package usage via monorepo |
| Types used only in JSDoc/comments | Valid type documentation |
| `// eslint-disable` comments on intentional patterns | May suppress valid warnings |
| Polyfills or compatibility shims | May be needed at runtime without an explicit import |
| Functions registered as string keys in a map | Dynamic dispatch, not traceable by grep alone |

---

## After Making Changes

After any non-trivial change, scan the files you touched:

- [ ] Are all imports at the top of each modified file still used?
- [ ] Did removing a function/component leave its export in an `index.ts` barrel?
- [ ] Did a removed route/endpoint leave a dead client-side API call in `src/api/`?
- [ ] Did a renamed variable leave the old name unreferenced somewhere?
- [ ] Are there now any unreachable `else` branches or `catch` blocks?

---

## Proactive Scanning

When doing a general codebase scan (not tied to a specific change):

1. Run `bun run typecheck` and `bun run lint` — fix all flagged unused symbols first
2. Look for files with no inbound imports:
   ```bash
   # Find .ts/.tsx files not imported anywhere (approximate)
   for f in $(find src -name "*.ts" -o -name "*.tsx" | grep -v ".test." | grep -v "index.ts"); do
     name=$(basename "$f" | sed 's/\.[^.]*$//'); 
     count=$(grep -rl "$name" src packages --include="*.ts" --include="*.tsx" | grep -v "$f" | wc -l);
     [ "$count" -eq 0 ] && echo "Possibly unreferenced: $f";
   done
   ```
3. Check `package.json` dependencies — if a package is not imported in any source file, flag it for removal
4. Do not bulk-delete — investigate each candidate individually before removing

---

## Reporting Without Removing

If dead code is found during a task that is unrelated to cleanup:

- Do not silently delete it — it may affect the current change's scope
- Flag it to the user with the file path and symbol name
- Offer to clean it up as a follow-up, not inline with unrelated work
