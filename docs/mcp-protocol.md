# TasteCaliber MCP Protocol & Client Integration

TasteCaliber implements the **Model Context Protocol (MCP)** specification using `@modelcontextprotocol/sdk` and `zod` schema validation, supporting both **Streamable HTTP** and **Stdio** transports.

---

## 1. What an MCP Server Requires

To interoperate reliably with any coding agent, TasteCaliber adheres to all core MCP server requirements:

1. **Standard Transport Support**:
   - **Streamable HTTP (`/mcp`)**: Accepts JSON-RPC 2.0 `POST` requests with `Accept: application/json, text/event-stream` and supports serverless/edge and persistent HTTP clients.
   - **Stdio (`mcp-stdio.ts`)**: Reads newline-delimited JSON-RPC 2.0 from `stdin` and writes responses strictly to `stdout`. All diagnostic logs must go to `stderr` so `stdout` stays valid JSON-RPC.
2. **Capability Negotiation (`initialize`)**: Declares server name (`tastecaliber-mcp`), version (`1.0.0`), and active capabilities (`tools`, `resources`, `prompts`).
3. **Typed Tool Input Validation**: Every tool defines a strict JSON Schema (generated from `zod`) so coding agents know exact enum values, required fields, and constraints before invoking.
4. **Deterministic Structured Outputs**: Tools return standard MCP `{ content: [{ type: 'text', text: ... }] }` payloads with clear machine-parseable JSON alongside human-readable summaries.
5. **Resource & Prompt Exposure**: Exposes read-only markdown profiles (`taste://profile/project`) and reusable prompt templates (`apply_coding_taste`) in addition to imperative tools.
6. **Concurrent Safe Storage**: Uses SQLite WAL mode so multiple agent sessions (e.g., Cursor over HTTP + Claude Code over stdio) can read and record signals simultaneously without database lock errors.

---

## 2. Exposed MCP Tools

### `taste_get_context`
Call before generating or reviewing code to load token-budgeted, file-relevant developer preferences and verified repository micro-skills.
- **Arguments**:
  - `scope`: `'all' | 'project' | 'global' | 'remote'` (default `'all'`)
  - `categories`: optional array of canonical `taste-1` categories
  - `filePath`: optional active file path (boosts relevant categories such as `database` or `react`)
  - `maxTokens`: `number` in `[120, 4000]` (default `800`)
  - `compact`: `boolean` (default `true`)
  - `includeHints`: `boolean` (default `true`)
  - `includeMicroSkills`: `boolean` (default `true`)
  - `agentName`: `string` (default `'MCP Coding Agent'`)

### `taste_record_signal`
Ingests an accept, reject, edit, code diff, or explicit instruction through the 4-step pipeline and returns `loopGuard` if 3+ consecutive corrective/reject signals occur on the same target (reset automatically when an `accept` signal succeeds).
- **Arguments**:
  - `signalType`: `'accept' | 'reject' | 'edit' | 'diff' | 'prompt'` *(required)*
  - `rawInput`: `string` *(required, min 2 chars)*
  - `diffBefore`: `string` *(optional)*
  - `diffAfter`: `string` *(optional)*
  - `filePath`: `string` *(optional)*
  - `scope`: `'project' | 'global' | 'remote'` (default `'project'`)
  - `agentName`: `string`

### `taste_query_learnings`
Filters stored learnings in SQLite by scope, category, status, search text, or minimum confidence.

### `taste_reinforce`
Applies explicit Meta-RL reward feedback (`accept` = `+1.0`, `reject` = `-1.0`) to a learning ID.

### `taste_resolve_conflict`
Resolves a flagged contradiction (`keep_existing`, `accept_new`, or `keep_both`).

### `taste_lint`
Validates all compiled `taste.md` files for structural headers, UTF-8, and `[0, 1]` confidence bounds.

### `taste_push_pull`
Intelligently merges or overwrites learnings across `project`, `global`, and `remote` scopes.

### `taste_list_providers`
Returns all configured Local Inference, NVIDIA NIM fast models, and OpenRouter providers, their Step 1 / Step 3 active role assignments, and curated fast model presets (`NVIDIA_FAST_MODELS`, `OPENROUTER_FREE_MODELS`).

### `taste_set_provider`
Allows any connected coding agent or user prompt to switch the active Step 1 (`input_extractor`), Step 3 (`output_writer`), or `both` model provider and optionally set a specific `modelId` (e.g., `meta/llama-3.1-8b-instruct` or `nvidia/llama-3.1-nemotron-nano-8b-v1`).

### `taste_configure_settings`
Enables or pauses TasteCaliber learning at the project (`tasteLearningProject`) or user (`tasteLearningUser`) scope. When paused, `taste_record_signal` operates in dry-run diagnostic mode.

### `taste_bootstrap`
Batch extracts and classifies multiple initial coding preferences from style notes, PR comments, or ESLint guidelines (`/learn-taste` workflow).

### `taste_record_micro_skill`
Records or corroborates a compact operational repository fact (`test`, `build`, `lint`, `env`, `db`, `deploy`, `pattern`). Reaching `>= 2` corroborations promotes it from `candidate` to `verified` for automatic turn-1 injection.

### `taste_list_micro_skills`
Lists `verified`, `candidate`, or `retired` repository micro-skills filtered by scope or category.

### `taste_get_economics`
Returns total tokens saved, baseline vs. injected compression percentage, failure loops prevented, verified micro-skill count, and unused MCP tools recommended for schema pruning.

### `taste_manage_learning`
Edits rule text/rationale/category, archives an obsolete preference, or restores an archived learning by `learningId`.

### `taste_manage_micro_skill`
Explicitly corroborates or retires a repository micro-skill by `microSkillId`.

---

## 3. MCP Resources & Prompts

| Type | URI / Name | Description |
| --- | --- | --- |
| Resource | `taste://profile/project` | Compiled project `taste.md` markdown |
| Resource | `taste://profile/global` | Compiled personal global `taste.md` markdown |
| Resource | `taste://objective/metrics` | Recent Meta-RL episodes and KL penalties (JSON) |
| Prompt | `apply_coding_taste` | Injects all enforced rules for a specified `task` |

---

## 4. Testing `/mcp` with `curl`

List tools over Streamable HTTP:

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }' | jq
```

Fetch active coding taste context:

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "taste_get_context",
      "arguments": { "scope": "all", "agentName": "CLI Test" }
    }
  }' | jq
```

Test Stdio transport directly:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | npx tsx mcp-stdio.ts
```

---

## 5. Connecting Coding Agents

### OpenCode (`opencode.json`)
- **Remote Streamable HTTP**:
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
- **Local Stdio**:
  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "tastecaliber": {
        "type": "local",
        "command": ["npx", "tsx", "/absolute/path/to/mcp-stdio.ts"],
        "environment": {
          "TASTE_DB_PATH": "/absolute/path/to/data/taste.db"
        },
        "enabled": true
      }
    }
  }
  ```

### Claude Code
- **HTTP**:
  ```bash
  claude mcp add --transport http tastecaliber http://localhost:3000/mcp
  ```
- **Stdio**:
  ```bash
  claude mcp add tastecaliber -- npx tsx /absolute/path/to/mcp-stdio.ts
  ```

### Cursor (`.cursor/mcp.json`) / Windsurf / Cline
```json
{
  "mcpServers": {
    "tastecaliber": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### Zed (`settings.json`)
```json
{
  "context_servers": {
    "tastecaliber": {
      "command": {
        "path": "npx",
        "args": ["tsx", "/absolute/path/to/mcp-stdio.ts"]
      }
    }
  }
}
```
