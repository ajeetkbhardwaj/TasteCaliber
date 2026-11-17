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
| TasteCaliber MCP Server (14 Tools · 3 Resources · 1 Prompt)       |
|  - taste_get_context (filePath + maxTokens + compact + microSkills)|
|  - taste_record_signal (+ failure-loop guard)                     |
|  - taste_record_micro_skill / taste_list_micro_skills             |
|  - taste_get_economics (token savings & MCP tool pruning advisor) |
+-------------------------------------------------------------------+
         |                                     |
         v                                     v
+-------------------------------+   +-------------------------------+
| Neuro-Symbolic + Economics    |   | Resilient Model Provider Chain|
|  - src/engine/taste1.ts       |   |  1. NVIDIA NIM Fast (8B/32B)  |
|  - src/engine/economics.ts    |   |  2. Local Engine (Ollama/LMS) |
|  - Sorensen-Dice dedup        |   |  3. OpenRouter (:free)        |
|  - Meta-RL KL update          |   |  4. Deterministic Fallback    |
+-------------------------------+   +-------------------------------+
         |
         v
+-------------------------------------------------------------------+
| Local SQLite (WAL Mode, data/taste.db) + .tastecaliber/taste/*.md |
|  - packages, learnings, signals, rl_episodes, providers, settings |
|  - micro_skills, economics_events, tool_usage, agent_connections  |
+-------------------------------------------------------------------+
```

---

## 3. Phased Delivery Roadmap

### Phase 1 — Core MCP Server, Dual Transport, SQLite & Neuro-Symbolic Pipeline (Complete)
- Local SQLite schema (`packages`, `learnings`, `signals`, `rl_episodes`, `providers`, `settings`, `agent_connections`) in WAL mode with parameterized queries.
- 4-step pipeline: Step 1 LLM/deterministic extraction -> Step 2 `taste-1` classifier & comparison-safe conflict lock -> Step 3 Markdown synthesis -> Step 4 SQLite persistence & `.tastecaliber/taste/taste.md` sync.
- Multi-provider fallback chain supporting NVIDIA NIM fast models (`meta/llama-3.1-8b-instruct`, `nvidia/llama-3.1-nemotron-nano-8b-v1`, `qwen/qwen2.5-coder-32b-instruct`), local Ollama/LM Studio, and OpenRouter free tiers.
- Streamable HTTP (`/mcp`) and Stdio (`mcp-stdio.ts`) verified concurrently with OpenCode and Claude Code.

### Phase 2 — TokenEconomizer Cost Control & Operational Memory (Implementing Now)
- **Token-Budgeted File-Aware Injection**: `taste_get_context` ranks learnings by relevance to `filePath`, trims within `maxTokens` (default `800`), supports `compact` output, and records baseline vs. injected token savings.
- **Repository Micro-Skills**: Captures compact repo facts (test commands, build flags, SQLite pragmas, env quirks), tracks cross-session corroboration (`corroborations >= 2` promotes `candidate -> verified`), and injects verified facts at turn 1.
- **Failure-Loop Guard**: Tracks repeated `reject` / `edit` churn on the same file or rule topic (3+ within rolling window) and emits concrete `loopGuard` intervention advice before the agent burns more tokens.
- **MCP Tool Usage & Pruning Telemetry**: Tracks invocation counts across all 14 MCP tools and recommends unused schemas to disable in `opencode.json` / IDE configs.
- **Economics Dashboard UI**: Dedicated **Economics** view showing tokens saved, compression %, loops prevented, verified micro-skills, tool pruning recommendations, and recent savings ledger.

### Phase 3 — Team Sync, CI Taste Gate & Commercial SaaS (Planned)
- Organization namespaces, PostgreSQL/Turso multi-tenant sync gateway, and Cloudflare Workers remote MCP edge deployment.
- Shared Team Meta-RL confidence aggregation with lead-engineer conflict resolution RBAC.
- Automated GitHub PR Review Bot & CLI CI gate validating diffs against team `taste.md` rules.
- Regulated compliance rule packs (FinTech, HIPAA, SOC2) and ROI billing analytics.
