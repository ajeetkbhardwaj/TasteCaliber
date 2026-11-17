# Taste Profile: tastecaliber-core / typescript

> Scope: project
> Engine: taste-1 (Meta Neuro-Symbolic)
> Learnings: 1

## typescript

- [confidence: 0.91] [enforced] Avoid explicit any in TypeScript; use unknown with narrow type guards or zod schemas
  - Rationale: Preserves end-to-end static safety across MCP tool boundaries.
