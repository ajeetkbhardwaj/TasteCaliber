# Taste Profile: tastecaliber-core / architecture

> Scope: project
> Engine: taste-1 (Meta Neuro-Symbolic)
> Learnings: 1

## architecture

- [confidence: 0.78] [enforced] Prefer named exports over default exports in engine and service modules
  - Rationale: Enables reliable IDE refactoring and deterministic tree-shaking.
