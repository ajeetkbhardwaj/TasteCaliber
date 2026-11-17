# TasteCaliber
<img width="120" height="42" alt="image" src="https://github.com/user-attachments/assets/87587036-431b-4c95-8e86-cb1a55261467" />

**TasteCaliber** is a universal Model Context Protocol (MCP) server and developer workbench powered by the **`taste-1` Meta Neuro-Symbolic engine**. It observes how you write, accept, reject, and edit code across AI coding agents (Claude Code, Cursor, Windsurf, Cline, Zed), builds a calibrated profile of your coding preferences in **local SQLite**, and injects those preferences back into every coding turn.

---

## Key Capabilities

- **Universal MCP Server (`v1.1.0`)**: Exposes **Streamable HTTP** (`POST /mcp`, optional `TASTE_API_TOKEN` Bearer protection) and **Local Stdio** (`npx tsx mcp-stdio.ts`) transports backed by a single SQLite store, plus edge parity on Cloudflare Workers D1 (`worker.ts`), with MCP `ToolAnnotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) and recovery-friendly `isError: true` hints.
- **4-Step Neuro-Symbolic Pipeline**:
  1. **Input Extraction (Configurable LLM + Fallback Chain)**: Converts raw prompts, accepts, rejects, and `before`/`after` diffs into structured candidate signals using Local Inference Engines (Ollama, LM Studio, vLLM), **NVIDIA NIM Fast Models** (`meta/llama-3.1-8b-instruct`, `nvidia/llama-3.1-nemotron-nano-8b-v1`, `qwen/qwen2.5-coder-32b-instruct`, `mistralai/codestral-22b-instruct-v0.1`), OpenRouter, or automatic built-in deterministic fallback.
  2. **`taste-1` Decision Classifier (Non-Generative & Extensible)**: Evaluates salience, classifies across **11 core engineering categories + 5 daily-agent domain packs** (`python`, `devops`, `writing`, `workflow`, `data`) and **custom domains** (`taste_register_domain`) + extracted `tags`, prevents duplicate paraphrased rules via semantic similarity checks, flags contradictions across code & behavioral axes (`verbosity`, `autonomy`, `output-format`), and updates confidence via a KL-regularized **Meta-RL Objective**.
  3. **Markdown Compiler, Linter & Pre-Flight Patch Verifier**: Generates lint-validated `.tastecaliber/taste/**/taste.md` files (with optional LLM synthesis gated by strict structural validation) and runs deterministic `taste_verify_patch` checks on proposed code/diffs before edits land.
  4. **Local SQLite Storage (`data/taste.db`)**: Powered by Node 22's built-in `node:sqlite` in WAL mode with `busy_timeout=5000` and indexed queries for multi-agent concurrency.
- **Zero-Cost & Agent-Managed Models**: Connects to local engines or free-tier APIs (NVIDIA NIM, OpenRouter), switchable at any time directly from any coding agent via `taste_list_providers` and `taste_set_provider`.
- **TokenEconomizer Cost Control (`src/engine/economics.ts`)**:
  - **File- & Task-Aware Token-True Context**: `taste_get_context` scores rules and verified micro-skills against `filePath` + `taskQuery`, defaults to `'compact'` formatting without double-JSON bloat, trims to `maxTokens` (default `800`), and logs accurate baseline vs. injected token savings.
  - **Corroborated Repository Micro-Skills**: Captures compact operational facts (`candidate -> verified` at `>= 2` corroborations) across code and daily workflows to skip cold-start exploration turns.
  - **Failure-Loop Guard & Tool Pruning**: Detects `3+` consecutive corrective/reject signals (`loopGuard`), resets on `'accept'`, tracks per-tool usage across all **18 MCP tools**, and emits a copy-ready `prunedAllowlistSnippet`.

---

## Quick Start

### Prerequisites
- **Node.js `>= 22.14`** (uses built-in `node:sqlite`)
- Optional: Ollama / LM Studio running locally, or free API keys for NVIDIA NIM / OpenRouter.

### 1. Install & Configure

```bash
npm install
cp .env.example .env
```

Edit `.env` to point at your local inference engine or free-tier API secrets:

```env
TASTE_DB_PATH="./data/taste.db"
TASTE_API_TOKEN=""
LOCAL_LLM_BASE_URL="http://localhost:11434/v1"
LOCAL_LLM_MODEL="qwen2.5-coder:7b"
NVIDIA_API_KEY=""
OPENROUTER_API_KEY=""
```

### 2. Run the MCP Server & Workbench

```bash
npm run dev
```

- **TasteCaliber Workbench**: `http://localhost:3000`
- **MCP Streamable HTTP Endpoint**: `http://localhost:3000/mcp`
- **MCP Stdio Entrypoint**: `npm run mcp:stdio` (`npx tsx mcp-stdio.ts`)

### 3. Run Tests & Type Check

```bash
npm test          # Runs node:test suite for taste-1 neuro-symbolic & RL logic
npm run lint      # Runs tsc --noEmit
npm run build     # Builds production frontend bundle
```

---

## Connect Any Coding Agent

### OpenCode (`opencode.json`)
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "tastecaliber": {
      "type": "remote",
      "url": "http://localhost:3000/mcp",
      "enabled": true
    }
  }
}
```

### Claude Code (HTTP)
```bash
claude mcp add --transport http tastecaliber http://localhost:3000/mcp
```

### Cursor / Windsurf / Cline (Local Stdio)
```json
{
  "mcpServers": {
    "tastecaliber": {
      "command": "npx",
      "args": ["tsx", "mcp-stdio.ts"],
      "env": {
        "TASTE_DB_PATH": "./data/taste.db"
      }
    }
  }
}
```

See [docs/mcp-protocol.md](docs/mcp-protocol.md) for Zed, HTTP JSON configurations, and raw JSON-RPC 2.0 tool schemas.

---

## Recommended Free Deployment

| Deployment Option | Free Tier | Cold Start | Best For |
| --- | --- | --- | --- |
| **Cloudflare Workers** *(Recommended)* | **100,000 requests/day** | Near-zero (V8 isolates) | Best free global edge option for TypeScript MCP servers |
| **Vercel Functions** *(Alternative)* | Free Hobby tier | Fast serverless | Teams already building with Next.js needing instant rollbacks |
| **Docker / Fly.io / Railway** | Free / low-cost tiers | Always-on | Hosting full Express UI + local `data/taste.db` volume together |
| **Local Stdio (`mcp-stdio.ts`)** | Unlimited (local) | Instant | Private single-machine coding agent workflows |

Read the step-by-step setup in [docs/deployment.md](docs/deployment.md).

---

## Documentation Index

- **[Architecture & `taste-1` Engine](docs/architecture.md)** — 4-step pipeline, Meta-RL objective math, extensible domains & behavioral conflict axes, SQLite schema (including `domain_packs`, `micro_skills`, `economics_events`, `tool_usage`), and `.tastecaliber/taste/` sync.
- **[MCP Protocol & Client Setup](docs/mcp-protocol.md)** — Required MCP server specifications, all **18 tools** (with `annotations`), **6 resources/templates**, **2 prompt templates**, optional Bearer auth, and agent integration configs.
- **[LLM Providers & Local Engines](docs/providers.md)** — Configuring Ollama, LM Studio, vLLM, NVIDIA NIM, and OpenRouter free models.
- **[Deployment Guide](docs/deployment.md)** — Deploying TasteCaliber via `worker.ts` + `wrangler.toml` (Cloudflare Workers D1), Vercel Functions, `Dockerfile`, and local stdio.
