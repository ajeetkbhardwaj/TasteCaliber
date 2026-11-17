# TasteCaliber Architecture & `taste-1` Engine

TasteCaliber separates **text processing** (Steps 1 and 3, handled by swappable LLMs or deterministic parsers) from **preference decision-making** (Step 2, handled exclusively by `taste-1`).

---

## 1. The Four-Step Pipeline

```text
  Coding Agent (accepts · rejects · edits · diffs · prompts)
                             │
                             ▼
  ┌──────────────────────────────────────────────────────────┐
  │ 1. INPUT EXTRACTOR (Configurable LLM / Offline Parser)   │
  │    Extracts { candidateRule, rationale, diffSummary }    │
  └──────────────────────────┬───────────────────────────────┘
                             │
                             ▼
  ╔══════════════════════════════════════════════════════════╗
  ║ 2. taste-1 (Meta Neuro-Symbolic Decision Classifier)     ║
  ║    • Neural: salience & category affinity scoring        ║
  ║    • Symbolic: fixed taxonomy + contradiction detection  ║
  ║    • Meta-RL: calibrated confidence & status updates     ║
  ╚══════════════════════════┬───────────────────────────────╝
                             │
                             ▼
  ┌──────────────────────────────────────────────────────────┐
  │ 3. OUTPUT COMPILER (Markdown Synthesizer & Linter)       │
  │    Formats calibrated learnings into taste.md sections   │
  └──────────────────────────┬───────────────────────────────┘
                             │
                             ▼
  ┌──────────────────────────────────────────────────────────┐
  │ 4. LOCAL STORAGE (SQLite WAL + .tastecaliber/taste/)     │
  │    Persists learnings, signals, RL episodes & markdown   │
  └──────────────────────────────────────────────────────────┘
```

---

## 2. Why `taste-1` Is Not an LLM

Using a generative LLM to directly judge coding preferences causes four failure modes:
1. **Gap-filling**: LLMs invent preferences when diff evidence is thin.
2. **Non-determinism**: Re-evaluating the same diff yields different rules across runs.
3. **Uncalibrated probabilities**: LLM confidence numbers are generated tokens, not calibrated empirical reliability.
4. **Statelessness**: LLMs forget prior decisions and silently overwrite conflicting rules.

`taste-1` returns **typed decisions and calibrated probabilities** (`src/engine/taste1.ts`):
- **Deterministic**: Identical input signals always yield identical category and salience decisions.
- **Fixed Symbolic Taxonomy**: Learnings map strictly to 11 canonical categories:
  `typescript`, `architecture`, `cli`, `react`, `testing`, `database`, `error-handling`, `formatting`, `security`, `api`, `performance`.
- **Contradiction Protection**: Evaluates incoming rules against symbolic conflict axes (e.g., `use semicolons` vs `omit semicolons`, `tabs` vs `spaces`, `async/await` vs `.then()`, `named exports` vs `default exports`, `avoid any` vs `allow any`). Conflicts are flagged (`status = 'conflicted'`) until explicitly resolved.

---

## 3. Meta-NeuroSymbolic RL Objective

Every accept, reject, edit, or explicit reinforcement feedback triggers a policy update using:

$$\text{Meta-NeuroSymbolic Objective}(\phi) = \mathbb{E}_{x\sim D_{RL}}\mathbb{E}_{y\sim LLM_{\phi}^{NS}(x)}\left[ RM_{NS}(x,y) - \beta_{NS} \log \frac{LLM_{\phi}^{NS}(y|x)}{LLM^{SFT}(y|x)} \right] + \gamma_{NS}\mathbb{E}_{x\sim D_{pretrain}} \log LLM_{\phi}^{NS}(x)$$

Default calibration constants in `META_RL_CONFIG`:
- $\beta_{NS} = 0.18$ (KL-divergence dampening against baseline policy so one noisy edit cannot overturn an established rule)
- $\gamma_{NS} = 0.08$ (retention term)
- **Status thresholds**:
  - `enforced`: confidence $\ge 0.72$ (actively injected as strict rule to coding agents)
  - `hint`: $0.40 \le \text{confidence} < 0.72$ (injected as soft suggestion)
  - `conflicted`: flagged symbolic contradiction awaiting human resolution
  - `archived`: noise ($< 0.32$) or rejected below hint threshold

---

## 4. Local SQLite Storage Schema (`server/db.ts`)

TasteCaliber uses Node 22's built-in `node:sqlite` (`DatabaseSync`) with `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.

| Table | Purpose |
| --- | --- |
| `packages` | Project, global, and remote taste packages with compiled `taste.md` content |
| `learnings` | Individual calibrated rules, confidence, accept/reject counts, KL divergence, and `conflicts_with_id` |
| `signals` | Raw agent events (`accept`, `reject`, `edit`, `diff`, `prompt`), Step 1 extraction JSON, Step 2 `taste-1` decision JSON |
| `rl_episodes` | Audit log of every Meta-RL reward, KL penalty, objective score, and confidence delta |
| `providers` | Configured Local / NVIDIA NIM / OpenRouter inference endpoints and active Step 1/3 roles |
| `settings` | Project/user `tasteLearning` toggles and namespace preferences |
| `agent_connections` | Connected MCP clients (`http` / `stdio`), call counts, and last seen timestamps |
| `micro_skills` | Corroborated repository operational facts (`candidate`, `verified`, `retired`) for turn-1 token savings |
| `economics_events` | Telemetry ledger of context pruning, micro-skill hits, and failure-loop preventions |
| `tool_usage` | Invocation counts and average response token footprints per MCP tool for pruning advice |

### Disk Markdown Sync (`.tastecaliber/taste/`)

Whenever a learning changes, TasteCaliber syncs human-readable markdown files to disk:

```text
.tastecaliber/
└── taste/
    ├── taste.md
    ├── typescript/
    │   └── taste.md
    ├── database/
    │   └── taste.md
    └── error-handling/
        └── taste.md
```

Every generated file is validated by `lintTasteMarkdown()` (`taste_lint`) to verify H1/H2 headers, `[confidence: 0.xx]` bounds in `[0, 1]`, and valid UTF-8 encoding.
