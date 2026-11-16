# Taste Profile: tastecaliber-core / api

> Scope: project
> Engine: taste-1 (Meta Neuro-Symbolic)
> Learnings: 1

## api

- [confidence: 0.86] [enforced] Prefer async/await with explicit try/catch over chained .then() promises
  - Rationale: Keeps stack traces clear in Express and MCP transport handlers.
