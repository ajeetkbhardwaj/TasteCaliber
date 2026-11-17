# TasteCaliber — Master Architecture & Implementation Plan

> **Brand:** TasteCaliber (`tastecaliber-mcp`)  
> **Core Mission:** Turn coding agents (OpenCode, Claude Code, Cursor, Windsurf, Cline, Zed) from stateless, repetitive, token-heavy code generators into persistent, taste-aligned, cost-aware senior engineering partners.

---

## 1. Executive Summary

TasteCaliber combines two complementary disciplines into a single Model Context Protocol (MCP) server backed by local WAL-mode SQLite (`data/taste.db`) and `.tastecaliber/taste/` markdown artifacts:

1. **Persistent Coding Taste & Meta-NeuroSymbolic Calibration (`taste-1`)**:
   - Captures explicit developer instructions, accept/reject feedback, and code diffs.
   - Separates LLM phrasing extraction (via local Ollama/LM Studio, NVIDIA NIM ultra-fast endpoints, or OpenRouter free models) from deterministic symbolic safety checks and Meta-RL confidence updates.
2. **Token Economics & Failure-Loop Control (Inspired by `microsoft/TokenEconomizer`)**:
   - Reduces agent prompt overhead and wasteful edit-test retries through **token-budgeted, file-aware context injection**, **corroborated repository micro-skills**, **failure-loop detection**, and **MCP tool-surface pruning telemetry**.

---

## 2. System Topology

```text
+-------------------------------------------------------------------+
| Coding Agents (OpenCode, Claude Code, Cursor, Windsurf, Cline, Zed)|
+-------------------------------------------------------------------+
         |  Streamable HTTP (POST /mcp)        |  Stdio (mcp-stdio.ts)
         v                                     v
+-------------------------------------------------------------------+
| TasteCaliber MCP Server (18 Annotated Tools · 6 Resources · 2 Prompts) |
|  - taste_get_context (filePath + taskQuery + maxTokens + responseFormat) |
|  - taste_verify_patch (deterministic pre-flight code/diff validator)    |
|  - taste_record_signal (+ loop guard) & taste_register_domain         |
|  - taste_record_micro_skill / taste_get_economics (pruning snippet)    |
+-------------------------------------------------------------------+
         |                                     |
         v                                     v
+-------------------------------+   +-------------------------------+
| Neuro-Symbolic + Economics    |   | Resilient Model Provider Chain|
|  - src/engine/taste1.ts       |   |  1. NVIDIA NIM Fast (8B/32B)  |
|  - src/engine/economics.ts    |   |  2. Local Engine (Ollama/LMS) |
|  - Extensible domain_packs    |   |  3. OpenRouter (:free)        |
|  - Meta-RL KL update          |   |  4. Deterministic Fallback    |
+-------------------------------+   +-------------------------------+
         |
         v
+-------------------------------------------------------------------+
| Local SQLite (WAL Mode, data/taste.db) + .tastecaliber/taste/*.md |
|  - packages, learnings (+tags), signals, rl_episodes, domain_packs |
|  - micro_skills, economics_events, tool_usage, agent_connections  |
+-------------------------------------------------------------------+
```

---

## 3. Phased Delivery Roadmap

### Phase 1 — Core MCP Server, Dual Transport, SQLite & Neuro-Symbolic Pipeline (Complete)
- Local SQLite schema (`packages`, `learnings`, `signals`, `rl_episodes`, `providers`, `settings`, `agent_connections`) in WAL mode with parameterized queries.
- 4-step pipeline: Step 1 LLM/deterministic extraction -> Step 2 `taste-1` classifier & comparison-safe conflict lock -> Step 3 Markdown synthesis -> Step 4 `.tastecaliber/taste/taste.md` sync.
- Multi-provider fallback chain supporting NVIDIA NIM fast models (`meta/llama-3.1-8b-instruct`, `nvidia/llama-3.1-nemotron-nano-8b-v1`, `qwen/qwen2.5-coder-32b-instruct`), local Ollama/LM Studio, and OpenRouter free tiers.
- Streamable HTTP (`/mcp`) and Stdio (`mcp-stdio.ts`) verified concurrently with OpenCode and Claude Code.

### Phase 2 — TokenEconomizer, Open Domains & Agent Ergonomics (Complete)
- **Token-True Budgeted Context**: `taste_get_context` ranks rules & verified micro-skills by `filePath` + `taskQuery` relevance, defaults to `'compact'` responseFormat (eliminating double JSON bloat), trims within `maxTokens` (default `800`), and logs savings.
- **Repository & Workflow Micro-Skills**: Captures operational facts (`corroborations >= 2` promotes `candidate -> verified`) across coding and daily workflows for turn-1 token savings.
- **Failure-Loop Guard & Pre-Flight Patch Verifier**: Detects `3+` corrective churn signals (`detectFailureLoop`) and exposes `taste_verify_patch` so agents validate code/diffs before writing.
- **Extensible Taxonomy & Domain Packs**: Opens `TasteCategory` beyond the 11 canonical starter facets to custom slugs + semantic `tags` + `domain_packs` (`taste_register_domain`) + universal behavioral conflict axes (`verbosity`, `autonomy`, `output-format`).
- **MCP Ergonomics & Edge Parity**: Adds `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) across all 18 tools, `isError` recovery guidance, dynamic `ResourceTemplate`s (`taste://category/{category}`, `taste://micro-skills/{category}`), optional `TASTE_API_TOKEN` Bearer auth, and full 18-tool parity in `worker.ts`.

### Phase 3 — Team Sync, CI Taste Gate & Commercial SaaS (Planned)
- Organization namespaces, PostgreSQL/Turso multi-tenant sync gateway, and hosted SaaS workspace management.
- Shared Team Meta-RL confidence aggregation with lead-engineer conflict resolution RBAC.
- Automated GitHub PR Review Bot & CLI CI gate validating diffs against team `taste.md` rules.
- Regulated compliance rule packs (FinTech, HIPAA, SOC2) and ROI billing analytics.
