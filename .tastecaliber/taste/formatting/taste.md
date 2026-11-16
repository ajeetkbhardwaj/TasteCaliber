# Taste Profile: tastecaliber-core / formatting

> Scope: project
> Engine: taste-1 (Meta Neuro-Symbolic)
> Learnings: 2

## formatting

- [confidence: 0.79] [enforced] Always use semicolons at statement boundaries across TypeScript files
  - Rationale: Consistent ASI safety across multi-file edits.
- [confidence: 0.54] [conflicted] Omit semicolons in frontend JSX components for cleaner diffs
  - Rationale: Observed in manual edit to JSX component return blocks.
