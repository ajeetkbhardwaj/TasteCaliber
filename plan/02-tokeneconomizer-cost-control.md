# Plan 02 — TokenEconomizer Cost Control & Micro-Skills Architecture

> Informed by findings from **Microsoft Research & UC Berkeley's `TokenEconomizer`** (18.4%–30.9% coding agent token cost reduction via repository micro-skills, MCP tool pruning, and failure-loop intervention).

---

## 1. Problem Statement
Even with strong coding preferences, coding agents waste massive token budgets in four predictable ways:
1. **Unbounded System Context**: Injecting every stored rule across all 11 categories on every turn inflates input tokens and dilutes attention.
2. **Cold-Start Repo Discovery**: Agents repeatedly burn 3–6 file-read / shell turns rediscovering how to run tests, lint, or connect to SQLite.
3. **Failure Loops**: When an agent hits an unfamiliar API or rule violation, it often repeats similar failing edits (`edit -> reject -> edit`) without changing strategy.
4. **Bloated MCP Tool Definitions**: Passing unused tool JSON schemas into every LLM call adds 2k–4k static system tokens per turn.

---

## 2. Phase 2 Implemented Features

### Feature A — File-Aware & Token-Budgeted Context Injection (`taste_get_context`)
- **New Input Parameters**:
  - `filePath?: string` — Active file being edited (e.g., `server/db.ts` boosts `database`, `security`, `typescript` rules; `src/components/Button.tsx` boosts `react`, `formatting`, `typescript`).
  - `maxTokens?: number` (default `800`, clamped `[120, 4000]`) — Hard prompt token budget for injected context.
  - `compact?: boolean` (default `true`) — Concise single-line formatting vs. verbose metadata block.
  - `includeMicroSkills?: boolean` (default `true`) — Appends top verified repo micro-skills within budget.
- **Deterministic Budgeting (`src/engine/economics.ts`)**:
  - `estimateTokens(text)` uses standard `Math.ceil(text.length / 4)` approximation.
  - Scores each active rule by `(scopePriority + filePathCategoryMatch * 0.45 + confidence * 0.55)` and packs greedily until `maxTokens` is reached.
  - Computes `baselineTokens` (full unfiltered context) vs. `injectedTokens` and persists `context_pruned` savings to `economics_events`.

### Feature B — Corroborated Repository Micro-Skills (`micro_skills` SQLite table)
- **Schema**:
  - `id`, `scope`, `trigger_pattern` (e.g., `"running unit tests"`, `"building production bundle"`), `fact_text` (e.g., `"Run npx tsx --test src/engine/taste1.test.ts; avoid vitest/jest"`), `category` (`test | build | lint | env | db | deploy | pattern`), `corroborations` (integer), `status` (`candidate | verified | retired`), `estimated_tokens_saved` (integer), `last_used_at`, `created_at`, `updated_at`.
- **Promotion Rule**:
  - First observation starts as `candidate` (`corroborations = 1`).
  - Second corroborating signal across sessions (`corroborations >= 2`) automatically promotes the micro-skill to `verified`.
  - Only `verified` micro-skills are auto-injected into `taste_get_context` to prevent stale/hallucinated repo trivia from entering prompts.
- **New MCP Tools**:
  - `taste_record_micro_skill` — Record or corroborate a repository operational fact.
  - `taste_list_micro_skills` — Filter and inspect `verified`, `candidate`, or `retired` micro-skills.

### Feature C — Failure-Loop Guard (`detectFailureLoop`)
- Integrated directly into `processTasteSignal`:
  - Scans recent `signals` (e.g., last 12 signals) matching the same `filePath` or overlapping `ruleKey`/category where `signalType` is `'reject'`, `'edit'`, or `'diff'`.
  - When **3+ repeated negative/corrective signals** occur on the same target in recent history, emits `loopGuard: { loopDetected: true, repeatCount, triggerKey, interventionAdvice }`.
  - Records a `loop_prevented` event in `economics_events` (`tokens_saved` credit = `1200` tokens per intercepted spiral).
  - Rendered prominently in Signal Lab UI and returned inside `taste_record_signal` MCP JSON output so coding agents pause and switch strategy.

### Feature D — MCP Tool Usage & Pruning Advisor (`tool_usage` + `taste_get_economics`)
- Every MCP tool call increments `tool_usage (tool_name, call_count, avg_response_tokens, last_called_at)`.
- `recommendUnusedTools()` identifies MCP tools with `0` (or very low) invocations across the workspace and quantifies the system-prompt token overhead saved (~165 tokens per pruned tool schema).
- Exposed via:
  - MCP tool `taste_get_economics`
  - REST endpoints `GET /api/economics`, `GET/POST /api/micro-skills`, `POST /api/micro-skills/:id/corroborate`, `DELETE /api/micro-skills/:id`
  - Workbench UI **Economics** tab (`EconomicsView.tsx`).
