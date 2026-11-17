import type { DatabaseSync } from 'node:sqlite';
import type {
  ExtractedSignal,
  ProviderConfig,
  ProviderRole,
  SignalType,
  TasteLearning,
} from '../src/engine/types.ts';
import {
  compileTasteMarkdown,
  deterministicExtractSignal,
  lintTasteMarkdown,
  normalizeRuleKey,
} from '../src/engine/taste1.ts';
import { listProviders } from './db.ts';

function buildHeaders(provider: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (provider.envVarName && process.env[provider.envVarName]) {
    headers.Authorization = `Bearer ${process.env[provider.envVarName]}`;
  }
  if (provider.kind === 'openrouter') {
    headers['HTTP-Referer'] = process.env.APP_URL || 'http://localhost:3000';
    headers['X-Title'] = 'TasteCaliber MCP Server';
  }
  return headers;
}

export async function testProviderConnectivity(
  db: DatabaseSync,
  providerId: string,
): Promise<{
  ok: boolean;
  status: ProviderConfig['lastStatus'];
  latencyMs: number;
  message: string;
  availableModels?: string[];
}> {
  const providers = listProviders(db);
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    return { ok: false, status: 'unreachable', latencyMs: 0, message: 'Provider not found' };
  }

  if (provider.kind !== 'local' && !provider.hasKeyConfigured) {
    const msg = `Environment secret ${provider.envVarName || 'API_KEY'} is not configured on the server.`;
    db.prepare('UPDATE providers SET last_status = ?, last_latency_ms = ?, last_error = ? WHERE id = ?').run(
      'missing_key',
      null,
      msg,
      provider.id,
    );
    return { ok: false, status: 'missing_key', latencyMs: 0, message: msg };
  }

  const started = Date.now();
  const base = provider.baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5500);

  try {
    const res = await fetch(`${base}/models`, {
      method: 'GET',
      headers: buildHeaders(provider),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Math.max(1, Date.now() - started);

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      const msg = `HTTP ${res.status}: ${errText.slice(0, 140)}`;
      db.prepare('UPDATE providers SET last_status = ?, last_latency_ms = ?, last_error = ? WHERE id = ?').run(
        'unreachable',
        latencyMs,
        msg,
        provider.id,
      );
      return { ok: false, status: 'unreachable', latencyMs, message: msg };
    }

    const payload = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
    const availableModels = Array.isArray(payload.data)
      ? payload.data.slice(0, 16).map((m) => String(m.id || '')).filter(Boolean)
      : [];

    db.prepare('UPDATE providers SET last_status = ?, last_latency_ms = ?, last_error = ? WHERE id = ?').run(
      'ready',
      latencyMs,
      null,
      provider.id,
    );

    return {
      ok: true,
      status: 'ready',
      latencyMs,
      message: `Connected to ${provider.name} (${latencyMs}ms)`,
      availableModels,
    };
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Math.max(1, Date.now() - started);
    const msg = err instanceof Error ? err.message : 'Connection failed';
    db.prepare('UPDATE providers SET last_status = ?, last_latency_ms = ?, last_error = ? WHERE id = ?').run(
      'unreachable',
      latencyMs,
      msg,
      provider.id,
    );
    return {
      ok: false,
      status: 'unreachable',
      latencyMs,
      message: `Endpoint unreachable (${msg}). Offline structural fallback remains active.`,
    };
  }
}

export function activateProviderRole(
  db: DatabaseSync,
  providerId: string,
  role: ProviderRole,
  modelId?: string,
): ProviderConfig[] {
  const providers = listProviders(db);
  const target = providers.find((p) => p.id === providerId);
  if (!target) {
    throw new Error(`Provider "${providerId}" not found`);
  }

  if (modelId && modelId.trim()) {
    db.prepare('UPDATE providers SET model_id = ? WHERE id = ?').run(modelId.trim(), target.id);
  }

  if (role === 'both') {
    db.prepare(`UPDATE providers SET is_active = 0, role = 'standby'`).run();
  } else if (role === 'input_extractor' || role === 'output_writer') {
    // If another provider currently holds 'both', downgrade its remaining role to the opposite step
    const otherRole = role === 'input_extractor' ? 'output_writer' : 'input_extractor';
    db.prepare(`UPDATE providers SET role = ? WHERE role = 'both' AND id != ?`).run(otherRole, target.id);
    db.prepare(`UPDATE providers SET is_active = 0, role = 'standby' WHERE role = ? AND id != ?`).run(role, target.id);
  }

  db.prepare(`UPDATE providers SET is_active = ?, role = ? WHERE id = ?`).run(
    role === 'standby' ? 0 : 1,
    role,
    target.id,
  );

  return listProviders(db);
}

export function updateProviderSettings(
  db: DatabaseSync,
  providerId: string,
  updates: { name?: string; baseUrl?: string; modelId?: string; envVarName?: string },
): ProviderConfig[] {
  const providers = listProviders(db);
  const target = providers.find((p) => p.id === providerId);
  if (!target) {
    throw new Error(`Provider "${providerId}" not found`);
  }

  db.prepare(
    `UPDATE providers SET name = ?, base_url = ?, model_id = ?, env_var_name = ? WHERE id = ?`,
  ).run(
    updates.name?.trim() || target.name,
    updates.baseUrl?.trim() || target.baseUrl,
    updates.modelId?.trim() || target.modelId,
    updates.envVarName !== undefined ? updates.envVarName.trim() : target.envVarName,
    target.id,
  );

  return listProviders(db);
}

/**
 * Returns an ordered candidate list for resilient fallback:
 * 1. Explicit active provider for this step
 * 2. Other ready/key-configured fast providers (NVIDIA NIM -> OpenRouter -> Local)
 */
export function buildProviderFallbackChain(
  db: DatabaseSync,
  step: 'input_extractor' | 'output_writer',
): ProviderConfig[] {
  const all = listProviders(db);
  const primary = all.find((p) => p.isActive && (p.role === step || p.role === 'both'));
  const secondary = all.filter(
    (p) =>
      p.id !== primary?.id &&
      (p.kind === 'local' ? p.lastStatus === 'ready' : p.hasKeyConfigured),
  );

  const ordered = primary ? [primary, ...secondary] : secondary;
  return ordered.filter((p) => p.kind === 'local' || p.hasKeyConfigured);
}

/**
 * Step 1: Extract structured coding preference signal using active Local/NVIDIA/OpenRouter chain,
 * falling back cleanly across ready providers and then to deterministic structural parser.
 */
export async function runStep1InputExtraction(
  db: DatabaseSync,
  input: {
    rawInput: string;
    diffBefore?: string | null;
    diffAfter?: string | null;
    filePath?: string | null;
    signalType: SignalType;
  },
): Promise<ExtractedSignal> {
  const chain = buildProviderFallbackChain(db, 'input_extractor');
  const tried: string[] = [];

  for (const provider of chain) {
    tried.push(`${provider.name}:${provider.modelId}`);
    const started = Date.now();
    const base = provider.baseUrl.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);

    try {
      const prompt = [
        'You are Step 1 of the TasteCaliber pipeline. Convert the raw coding feedback and diff into a concise JSON object.',
        'Do NOT invent preferences not supported by the input. Return JSON only with keys: candidateRule, rationale, diffSummary.',
        `SignalType: ${input.signalType}`,
        `FilePath: ${input.filePath || 'unspecified'}`,
        `RawInput: ${input.rawInput}`,
        input.diffBefore ? `DiffBefore:\n${input.diffBefore}` : '',
        input.diffAfter ? `DiffAfter:\n${input.diffAfter}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(provider),
        signal: controller.signal,
        body: JSON.stringify({
          model: provider.modelId,
          temperature: 0,
          max_tokens: 240,
          messages: [
            {
              role: 'system',
              content: 'Return strict JSON: {"candidateRule":"...","rationale":"...","diffSummary":"..."}',
            },
            { role: 'user', content: prompt },
          ],
        }),
      });
      clearTimeout(timer);

      if (!res.ok) continue;

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const rawContent = data.choices?.[0]?.message?.content?.trim() ?? '';
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]) as {
        candidateRule?: string;
        rationale?: string;
        diffSummary?: string;
      };

      if (!parsed.candidateRule || parsed.candidateRule.trim().length < 6) continue;

      const latencyMs = Math.max(1, Date.now() - started);
      db.prepare('UPDATE providers SET last_status = ?, last_latency_ms = ?, last_error = ? WHERE id = ?').run(
        'ready',
        latencyMs,
        null,
        provider.id,
      );

      return {
        candidateRule: parsed.candidateRule.trim().slice(0, 220),
        rationale: (parsed.rationale || `Extracted by ${provider.modelId}`).trim().slice(0, 320),
        ruleKey: normalizeRuleKey(parsed.candidateRule),
        diffSummary: (parsed.diffSummary || 'Extracted via LLM diff analysis').trim().slice(0, 140),
        extractorMode: 'llm',
        modelUsed: `${provider.name} (${provider.modelId})`,
        latencyMs,
        fallbackChainUsed: tried,
      };
    } catch {
      clearTimeout(timer);
    }
  }

  const fallback = deterministicExtractSignal(input);
  return {
    ...fallback,
    fallbackChainUsed: [...tried, 'taste-structural-parser-v1'],
  };
}

/**
 * Step 3: Output Markdown compilation.
 * Uses deterministic compiler first, and if an active Output Writer LLM is ready,
 * optionally refines prose while strictly enforcing lintTasteMarkdown() invariants.
 */
export async function runStep3OutputWriter(
  db: DatabaseSync,
  params: {
    title: string;
    scope: 'project' | 'global' | 'remote';
    learnings: TasteLearning[];
  },
): Promise<{
  markdownPreview: string;
  writerMode: 'llm' | 'deterministic';
  modelUsed: string;
  latencyMs: number;
}> {
  const started = Date.now();
  const baseMarkdown = compileTasteMarkdown(params);
  const chain = buildProviderFallbackChain(db, 'output_writer');
  const primary = chain[0];

  if (!primary || (primary.kind === 'local' && primary.lastStatus !== 'ready')) {
    return {
      markdownPreview: baseMarkdown,
      writerMode: 'deterministic',
      modelUsed: 'taste-markdown-compiler-v1',
      latencyMs: Math.max(1, Date.now() - started),
    };
  }

  // Attempt concise LLM markdown merge/polish, strictly gated by lintTasteMarkdown
  const base = primary.baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(primary),
      signal: controller.signal,
      body: JSON.stringify({
        model: primary.modelId,
        temperature: 0,
        max_tokens: 900,
        messages: [
          {
            role: 'system',
            content:
              'You format TasteCaliber taste.md files. Preserve every # header, > Scope header, ## category header, and exact [confidence: 0.xx] [status] values verbatim. Return only markdown.',
          },
          {
            role: 'user',
            content: `Clean up spacing and ensure crisp developer prose without changing any rules or confidence numbers:\n\n${baseMarkdown}`,
          },
        ],
      }),
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const candidateMd = data.choices?.[0]?.message?.content?.trim() ?? '';
      const lint = lintTasteMarkdown('taste.md', candidateMd);
      if (candidateMd.length > 40 && lint.valid) {
        const latencyMs = Math.max(1, Date.now() - started);
        db.prepare('UPDATE providers SET last_status = ?, last_latency_ms = ?, last_error = ? WHERE id = ?').run(
          'ready',
          latencyMs,
          null,
          primary.id,
        );
        return {
          markdownPreview: candidateMd,
          writerMode: 'llm',
          modelUsed: `${primary.name} (${primary.modelId})`,
          latencyMs,
        };
      }
    }
  } catch {
    clearTimeout(timer);
  }

  return {
    markdownPreview: baseMarkdown,
    writerMode: 'deterministic',
    modelUsed: 'taste-markdown-compiler-v1',
    latencyMs: Math.max(1, Date.now() - started),
  };
}
