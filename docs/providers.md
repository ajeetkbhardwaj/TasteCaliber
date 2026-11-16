# Model Providers & Local Inference Engines

TasteCaliber only uses LLMs at **Step 1** (converting raw edits/diffs into structured signals) and **Step 3** (markdown synthesis). **Step 2 (`taste-1`) is never swapped for an LLM**—it runs locally with zero token cost.

---

## 1. Supported OpenAI-Compatible Backends

TasteCaliber talks to any OpenAI-compatible `/v1/chat/completions` and `/v1/models` endpoint via `server/providers.ts`:

| Provider | Base URL | Default Model | API Key Required? |
| --- | --- | --- | --- |
| **Ollama (Local)** | `http://localhost:11434/v1` | `qwen2.5-coder:7b` | No |
| **LM Studio (Local)** | `http://localhost:1234/v1` | `qwen2.5-coder-7b-instruct` | No |
| **vLLM / llama.cpp (Local)** | `http://localhost:8000/v1` | `qwen2.5-coder-7b-instruct` | No |
| **NVIDIA NIM (Fast Step 1)** | `https://integrate.api.nvidia.com/v1` | `meta/llama-3.1-8b-instruct` | `NVIDIA_API_KEY` |
| **NVIDIA NIM (Nemotron Agentic)** | `https://integrate.api.nvidia.com/v1` | `nvidia/llama-3.1-nemotron-nano-8b-v1` | `NVIDIA_API_KEY` |
| **NVIDIA NIM (Code Diffs)** | `https://integrate.api.nvidia.com/v1` | `qwen/qwen2.5-coder-32b-instruct` | `NVIDIA_API_KEY` |
| **OpenRouter (Free Models)** | `https://openrouter.ai/api/v1` | `qwen/qwen-2.5-coder-32b-instruct:free` | `OPENROUTER_API_KEY` |

---

## 2. Setting Up Local Inference (Zero Cost, Private)

### Ollama
```bash
ollama pull qwen2.5-coder:7b
ollama serve
```
In `.env`:
```env
LOCAL_LLM_BASE_URL="http://localhost:11434/v1"
LOCAL_LLM_MODEL="qwen2.5-coder:7b"
```

### LM Studio
1. Download a coder model (e.g. `Qwen2.5-Coder-7B-Instruct-GGUF`).
2. Start the Local Server on port `1234`.
3. In the **Providers** tab of TasteCaliber, click **Test** on `LM Studio (Local Engine)` and assign **Step 1**, **Step 3**, or **Both**.

---

## 3. Setting Up Fast NVIDIA NIM & OpenRouter Endpoints

API keys are **never stored in browser state or entered into UI forms**. Set them in your server `.env` (or cloud deployment secrets):

```env
NVIDIA_API_KEY="nvapi-..."
OPENROUTER_API_KEY="sk-or-v1-..."
```

When `NVIDIA_API_KEY` is present on first boot, TasteCaliber automatically enables fast NVIDIA NIM extraction. You can switch between curated fast NVIDIA NIM presets (`meta/llama-3.1-8b-instruct`, `nvidia/llama-3.1-nemotron-nano-8b-v1`, `qwen/qwen2.5-coder-32b-instruct`, `mistralai/codestral-22b-instruct-v0.1`, `meta/llama-3.3-70b-instruct`, `deepseek-ai/deepseek-r1-distill-qwen-32b`) either:
- From the **Providers** UI tab in the workbench, or
- Directly from any coding agent via the `taste_list_providers` and `taste_set_provider` MCP tools.

---

## 4. Resilient Provider Fallback Chain

If your primary configured provider times out, rate-limits, or has no API key set, `server/providers.ts` walks through remaining configured local/ready providers before seamlessly falling back to `deterministicExtractSignal()` (`taste-structural-parser-v1`) so MCP clients continue operating with zero downtime and sub-5ms latency.
