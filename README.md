# TasteCaliber

**TasteCaliber** is a universal Model Context Protocol (MCP) server and developer workbench powered by the **`taste-1` Meta Neuro-Symbolic engine**. It observes how you write, accept, reject, and edit code across AI coding agents (Claude Code, Cursor, Windsurf, Cline, Zed), builds a calibrated profile of your coding preferences in **local SQLite**, and injects those preferences back into every coding turn.

---

## Key Capabilities

- **Universal MCP Server**: Exposes **Streamable HTTP** (`POST /mcp`) and **Local Stdio** (`npx tsx mcp-stdio.ts`) transports backed by a single SQLite store.
- **4-Step Neuro-Symbolic Pipeline**:
  1. **Input Extraction (Configurable LLM + Fallback Chain)**: Converts raw prompts, accepts, rejects, and `before`/`after` diffs into structured candidate signals using Local Inference Engines (Ollama, LM Studio, vLLM), **NVIDIA NIM Fast Models** (`meta/llama-3.1-8b-instruct`, `nvidia/llama-3.1-nemotron-nano-8b-v1`, `qwen/qwen2.5-coder-32b-instruct`, `mistralai/codestral-22b-instruct-v0.1`), OpenRouter, or automatic built-in deterministic fallback.
  2. **`taste-1` Decision Classifier (Non-Generative)**: Evaluates salience, classifies into an 11-category symbolic taxonomy, prevents duplicate paraphrased rules via semantic similarity checks, flags contradictions instead of silently overwriting rules, and updates confidence via a KL-regularized **Meta-RL Objective**.
  3. **Markdown Compiler & Linter**: Generates readable, lint-validated `.tastecaliber/taste/**/taste.md` files (with optional LLM synthesis gated by strict structural validation).
  4. **Local SQLite Storage (`data/taste.db`)**: Powered by Node 22's built-in `node:sqlite` in WAL mode with `busy_timeout=5000` and indexed queries for multi-agent concurrency.
- **Zero-Cost & Agent-Managed Models**: Connects to local engines or free-tier APIs (NVIDIA NIM, OpenRouter), switchable at any time directly from any coding agent via `taste_list_providers` and `taste_set_provider`.
- **TokenEconomizer Cost Control (`src/engine/economics.ts`)**:
  - **File-Aware Token-Budgeted Injection**: `taste_get_context` scores rules against `filePath`, trims to `maxTokens` (default `800`), reserves space for verified repo micro-skills, and logs baseline vs. injected token savings.
  - **Corroborated Repository Micro-Skills**: Captures compact repo operational facts (`candidate -> verified` at `>= 2` corroborations) to skip cold-start exploration turns.
  - **Failure-Loop Guard & Tool Pruning**: Detects `3+` consecutive corrective/reject signals on the same file or rule (`loopGuard`), resets on `'accept'`, and tracks per-tool usage to flag unused MCP schemas.

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

- **[Architecture & `taste-1` Engine](docs/architecture.md)** — 4-step pipeline, Meta-RL objective math, contradiction detection, SQLite schema (including `micro_skills`, `economics_events`, `tool_usage`), and `.tastecaliber/taste/` sync.
- **[MCP Protocol & Client Setup](docs/mcp-protocol.md)** — Required MCP server specifications, all 16 tools, 3 resources, prompt templates, and agent integration configs.
- **[LLM Providers & Local Engines](docs/providers.md)** — Configuring Ollama, LM Studio, vLLM, NVIDIA NIM, and OpenRouter free models.
- **[Deployment Guide](docs/deployment.md)** — Deploying TasteCaliber via `worker.ts` + `wrangler.toml` (Cloudflare Workers), Vercel Functions, `Dockerfile`, and local stdio.
