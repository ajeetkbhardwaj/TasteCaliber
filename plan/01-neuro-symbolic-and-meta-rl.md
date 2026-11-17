# Plan 01 — Neuro-Symbolic `taste-1` Engine & Meta-RL Calibration

## 1. Architectural Separation of Concerns
Rather than relying on an uncalibrated black-box LLM prompt to store coding preferences, TasteCaliber splits ingestion into two distinct layers:

1. **Step 1 — Neural/Structural Signal Extractor (`server/providers.ts`)**:
   - Converts noisy developer text, accept/reject notes, or before/after code diffs into a normalized `{ candidateRule, rationale, ruleKey, diffSummary }`.
   - Uses ultra-fast models (e.g., `meta/llama-3.1-8b-instruct` or local Ollama `qwen2.5-coder:7b`) with automatic fallback to `deterministicExtractSignal()` so latency stays predictable and offline mode always works.

2. **Step 2 — Deterministic `taste-1` Neuro-Symbolic Classifier (`src/engine/taste1.ts`)**:
   - **Noise Filter**: Rejects non-preference chatter (`"looks good"`, `"thanks"`, `"ok"`) before polluting memory.
   - **11-Category Taxonomy**: `typescript`, `architecture`, `cli`, `react`, `testing`, `database`, `error-handling`, `formatting`, `security`, `api`, `performance`. Weighted keyword + file-extension heuristics yield calibrated category probabilities.
   - **Symbolic Polarity & Comparison-Safe Conflict Detection**:
     - Strips comparative clauses (`over ...`, `instead of ...`, `rather than ...`, `versus ...`) prior to checking mutually exclusive style axes (e.g., `use semicolons` vs `omit semicolons`, `named exports` vs `default exports`, `tabs` vs `spaces`).
     - Ensures `"Prefer named exports over default exports"` reinforces rather than falsely conflicts with `"Prefer named exports"`.
     - When a real contradiction occurs, flags the new rule as `conflicted` (`conflicts_with_id` pointing to the existing rule) rather than silently overwriting established preferences.
   - **Paraphrase Deduplication (Sorensen-Dice)**:
     - Normalizes domain tokens and computes bigram/token Sorensen-Dice similarity (`>= 0.58`) within the same category & scope to merge paraphrased repeats into evidence updates on existing learnings.

---

## 2. Meta-NeuroSymbolic RL Objective

Each learning tracks `(confidence, rewardSum, acceptCount, rejectCount, klDivergence, evidenceCount)` and updates via:

$$\text{Meta-NeuroSymbolic Objective}(\phi) = \mathbb{E}\left[ R_{NS}(x, y) - \beta_{NS} \log \frac{\pi_\phi(y \mid x)}{\pi_{SFT}(y \mid x)} \right] + \gamma_{NS} \mathbb{E}[\log \pi_\phi(x)]$$

- **Hyperparameters**: `betaNS = 0.12`, `gammaNS = 0.05`, `learningRate = 0.18`.
- **KL Divergence Regularizer**: Prevents a single noisy `reject` signal from collapsing an established high-evidence rule to zero, while still allowing steady decay if rejections persist.
- **Status Lifecycle**:
  - `enforced`: `confidence >= 0.72` (injected as strict mandates)
  - `hint`: `0.48 <= confidence < 0.72` (injected as soft suggestions)
  - `conflicted`: Symbolic axis clash detected; awaits explicit resolution (`keep_existing`, `accept_new`, `keep_both`)
  - `archived`: `confidence < 0.30` or explicitly retired/rejected

---

## 3. Step 3 & Step 4 — Deterministic Markdown & Atomic SQLite Sync
- Compiles rules grouped by category into `.tastecaliber/taste/taste.md` and `.tastecaliber/taste/<category>/taste.md`.
- Validates output with `lintTasteMarkdown()` (checking required headers, valid `[confidence: x.xx]` bounds in `[0, 1]`, valid status labels, and UTF-8 safety).
- Runs SQLite in `WAL` mode (`busy_timeout = 5000`, `foreign_keys = ON`) so concurrent HTTP and Stdio agents share consistent state without SQLITE_BUSY locks.
