# Taste Profile: tastecaliber-core / database

> Scope: project
> Engine: taste-1 (Meta Neuro-Symbolic)
> Learnings: 1

## database

- [confidence: 0.89] [enforced] Always use parameterized prepared SQLite statements with WAL mode enabled
  - Rationale: Prevents SQL injection and keeps concurrent MCP reads lock-free.
