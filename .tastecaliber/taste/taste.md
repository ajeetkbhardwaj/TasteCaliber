# Taste Profile: tastecaliber-core

> Scope: project
> Engine: taste-1 (Meta Neuro-Symbolic)
> Learnings: 8

## typescript

- [confidence: 0.94] [enforced] Prefer named exports and strict TypeScript return types on exported helpers
  - Rationale: Prefer named exports and strict TypeScript return types on exported helpers (1 line(s) replaced by 1 line(s))
- [confidence: 0.91] [enforced] Avoid explicit any in TypeScript; use unknown with narrow type guards or zod schemas
  - Rationale: Preserves end-to-end static safety across MCP tool boundaries.

## database

- [confidence: 0.89] [enforced] Always use parameterized prepared SQLite statements with WAL mode enabled
  - Rationale: Prevents SQL injection and keeps concurrent MCP reads lock-free.

## api

- [confidence: 0.86] [enforced] Prefer async/await with explicit try/catch over chained .then() promises
  - Rationale: Keeps stack traces clear in Express and MCP transport handlers.

## error-handling

- [confidence: 0.84] [enforced] Prefer early guard returns over deeply nested conditional blocks
  - Rationale: Improves readability and isolates error paths at the top of handlers.

## formatting

- [confidence: 0.79] [enforced] Always use semicolons at statement boundaries across TypeScript files
  - Rationale: Consistent ASI safety across multi-file edits.
- [confidence: 0.54] [conflicted] Omit semicolons in frontend JSX components for cleaner diffs
  - Rationale: Observed in manual edit to JSX component return blocks.

## architecture

- [confidence: 0.78] [enforced] Prefer named exports over default exports in engine and service modules
  - Rationale: Enables reliable IDE refactoring and deterministic tree-shaking.
