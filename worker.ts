import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  buildPrunedAllowlistConfig,
  detectFailureLoop,
  estimateTokens,
  recommendUnusedTools,
  selectBudgetedLearnings,
} from './src/engine/economics.ts';
import {
  classifyWithTaste1,
  compileTasteMarkdown,
  deterministicExtractSignal,
  extractTagsFromRule,
  findSimilarLearning,
  lintTasteMarkdown,
  normalizeCategorySlug,
  normalizeRuleKey,
  updateMetaRL,
  verifyPatchAgainstTaste,
} from './src/engine/taste1.ts';
import {
  NVIDIA_FAST_MODELS,
  OPENROUTER_FREE_MODELS,
  TASTE_CATEGORIES,
} from './src/engine/types.ts';
import type {
  DomainPack,
  EconomicsEvent,
  EconomicsEventType,
  MicroSkill,
  MicroSkillStatus,
  ProviderConfig,
  RlEpisode,
  SignalType,
  TasteLearning,
  TasteScope,
  TasteSignalRecord,
  ToolUsageStat,
} from './src/engine/types.ts';

interface D1Prepared {
  bind(...values: unknown[]): D1Prepared;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface D1DatabaseLike {
  prepare(query: string): D1Prepared;
}

export interface WorkerEnv {
  DB: D1DatabaseLike;
  TASTE_API_TOKEN?: string;
  NVIDIA_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

const EDGE_TOOL_NAMES = [
  'taste_get_context',
  'taste_record_signal',
  'taste_query_learnings',
  'taste_reinforce',
  'taste_resolve_conflict',
  'taste_lint',
  'taste_push_pull',
  'taste_list_providers',
  'taste_set_provider',
  'taste_configure_settings',
  'taste_bootstrap',
  'taste_record_micro_skill',
  'taste_list_micro_skills',
  'taste_get_economics',
  'taste_manage_learning',
  'taste_manage_micro_skill',
  'taste_verify_patch',
  'taste_register_domain',
];

function mcpError(message: string, recoveryHint?: string) {
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: message, ...(recoveryHint ? { recoveryHint } : {}) }, null, 2),
      },
    ],
  };
}

function parseJsonStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function mapLearning(r: Record<string, unknown>): TasteLearning {
  return {
    id: String(r.id),
    packageId: String(r.package_id),
    scope: r.scope as TasteScope,
    category: String(r.category),
    ruleKey: String(r.rule_key),
    ruleText: String(r.rule_text),
    rationale: String(r.rationale),
    confidence: Number(r.confidence),
    status: r.status as TasteLearning['status'],
    rewardSum: Number(r.reward_sum ?? 0),
    acceptCount: Number(r.accept_count ?? 0),
    rejectCount: Number(r.reject_count ?? 0),
    klDivergence: Number(r.kl_divergence ?? 0),
    evidenceCount: Number(r.evidence_count ?? 1),
    conflictsWithId: r.conflicts_with_id ? String(r.conflicts_with_id) : null,
    tags: parseJsonStringArray(r.tags),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapMicroSkill(r: Record<string, unknown>): MicroSkill {
  return {
    id: String(r.id),
    scope: r.scope as TasteScope,
    category: String(r.category),
    triggerPattern: String(r.trigger_pattern),
    factText: String(r.fact_text),
    corroborations: Number(r.corroborations),
    status: r.status as MicroSkill['status'],
    estimatedTokensSaved: Number(r.estimated_tokens_saved ?? 220),
    lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapDomainPack(r: Record<string, unknown>): DomainPack {
  return {
    id: String(r.id),
    slug: String(r.slug),
    label: String(r.label),
    description: String(r.description),
    keywords: parseJsonStringArray(r.keywords_json),
    fileExtensions: parseJsonStringArray(r.file_extensions_json),
    isBuiltin: Boolean(r.is_builtin),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

async function d1RecordToolUsage(db: D1DatabaseLike, toolName: string, responseTokens: number): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db
    .prepare('SELECT call_count, avg_response_tokens FROM tool_usage WHERE tool_name = ?')
    .bind(toolName)
    .first<{ call_count: number; avg_response_tokens: number }>();

  if (existing) {
    const nextCount = Number(existing.call_count) + 1;
    const nextAvg = Math.round(
      (Number(existing.avg_response_tokens) * Number(existing.call_count) + responseTokens) / nextCount,
    );
    await db
      .prepare('UPDATE tool_usage SET call_count = ?, avg_response_tokens = ?, last_called_at = ? WHERE tool_name = ?')
      .bind(nextCount, nextAvg, now, toolName)
      .run();
  } else {
    await db
      .prepare('INSERT INTO tool_usage (tool_name, call_count, avg_response_tokens, last_called_at) VALUES (?, 1, ?, ?)')
      .bind(toolName, Math.max(1, Math.round(responseTokens)), now)
      .run();
  }
}

async function d1RecordSignal(
  db: D1DatabaseLike,
  params: {
    signalType: SignalType;
    rawInput: string;
    diffBefore?: string;
    diffAfter?: string;
    filePath?: string;
    category?: string;
    tags?: string[];
    scope: TasteScope;
    agentName: string;
  },
) {
  const extracted = deterministicExtractSignal({
    rawInput: params.rawInput,
    diffBefore: params.diffBefore,
    diffAfter: params.diffAfter,
    filePath: params.filePath,
    signalType: params.signalType,
  });

  const [existingRows, domainRows, recentSigRows] = await Promise.all([
    db.prepare('SELECT * FROM learnings').all(),
    db.prepare('SELECT * FROM domain_packs').all(),
    db.prepare('SELECT file_path, signal_type, taste1_decision_json FROM signals ORDER BY created_at DESC LIMIT 12').all(),
  ]);

  const existingLearnings = existingRows.results.map(mapLearning);
  const customDomains = domainRows.results.map(mapDomainPack);
  const recentSignals = recentSigRows.results.map((r) => ({
    filePath: r.file_path ? String(r.file_path) : null,
    signalType: r.signal_type as SignalType,
    taste1Decision: JSON.parse(String(r.taste1_decision_json)) as TasteSignalRecord['taste1Decision'],
  }));

  const decision = classifyWithTaste1({
    extracted,
    signalType: params.signalType,
    filePath: params.filePath,
    diffBefore: params.diffBefore,
    diffAfter: params.diffAfter,
    existingLearnings,
    customDomains,
    preferredCategory: params.category,
  });

  const loopGuard = detectFailureLoop({
    filePath: params.filePath,
    ruleKey: decision.ruleKey,
    signalType: params.signalType,
    recentSignals,
  });

  const reward =
    params.signalType === 'accept'
      ? 1.0
      : params.signalType === 'edit' || params.signalType === 'diff'
        ? 0.75
        : params.signalType === 'reject'
          ? -0.8
          : 0.4;

  const similar = findSimilarLearning({
    candidateRule: extracted.candidateRule,
    ruleKey: decision.ruleKey,
    category: decision.category,
    scope: params.scope,
    existingLearnings,
    contradictsId: decision.contradictsId,
  });

  const now = new Date().toISOString();
  let learningId: string;
  let finalConfidence = decision.initialConfidence;
  let finalStatus = decision.isPreference ? decision.recommendedStatus : 'archived';

  if (similar) {
    learningId = similar.id;
    const rl = updateMetaRL({
      confidenceBefore: similar.confidence,
      reward,
      evidenceCount: similar.evidenceCount + 1,
      hasConflict: Boolean(similar.conflictsWithId),
    });
    finalConfidence = rl.confidenceAfter;
    finalStatus = rl.statusAfter;
    await db
      .prepare(
        `UPDATE learnings SET confidence = ?, status = ?, reward_sum = reward_sum + ?, accept_count = accept_count + ?, reject_count = reject_count + ?, kl_divergence = ?, evidence_count = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        rl.confidenceAfter,
        rl.statusAfter,
        reward,
        reward > 0 ? 1 : 0,
        reward < 0 ? 1 : 0,
        rl.klPenalty,
        similar.evidenceCount + 1,
        now,
        similar.id,
      )
      .run();
  } else {
    learningId = `lrn-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const derivedTags = Array.from(
      new Set([
        ...(params.tags ?? []).map((t) => normalizeCategorySlug(t)),
        ...extractTagsFromRule(extracted.candidateRule, params.filePath, decision.category),
      ]),
    );
    await db
      .prepare(
        `INSERT INTO learnings (id, package_id, scope, category, rule_key, rule_text, rationale, confidence, status, reward_sum, accept_count, reject_count, kl_divergence, evidence_count, conflicts_with_id, tags, created_at, updated_at)
         VALUES (?, 'pkg-project-main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?)`,
      )
      .bind(
        learningId,
        params.scope,
        decision.category,
        decision.ruleKey,
        extracted.candidateRule,
        extracted.rationale,
        finalConfidence,
        finalStatus,
        reward,
        reward > 0 ? 1 : 0,
        reward < 0 ? 1 : 0,
        decision.contradictsId,
        JSON.stringify(derivedTags),
        now,
        now,
      )
      .run();
  }

  await db
    .prepare(
      `INSERT INTO signals (id, source_agent, signal_type, file_path, raw_input, diff_before, diff_after, extracted_signal_json, taste1_decision_json, reward_delta, learning_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `sig-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      params.agentName,
      params.signalType,
      params.filePath ?? null,
      params.rawInput,
      params.diffBefore ?? null,
      params.diffAfter ?? null,
      JSON.stringify(extracted),
      JSON.stringify(decision),
      reward,
      learningId,
      now,
    )
    .run();

  if (loopGuard.loopDetected) {
    await db
      .prepare(
        `INSERT INTO economics_events (id, event_type, agent_name, file_path, baseline_tokens, injected_tokens, tokens_saved, details, created_at)
         VALUES (?, 'loop_prevented', ?, ?, 1450, 250, 1200, ?, ?)`,
      )
      .bind(
        `econ-loop-${Date.now()}`,
        params.agentName,
        params.filePath ?? null,
        loopGuard.interventionAdvice ?? 'Failure-loop detected',
        now,
      )
      .run();
  }

  return {
    learningId,
    category: decision.category,
    confidence: finalConfidence,
    status: finalStatus,
    contradictsId: decision.contradictsId,
    contradictionReason: decision.contradictionReason,
    loopGuard,
    decision,
    extracted,
  };
}

function buildEdgeMcpServer(env: WorkerEnv): McpServer {
  const server = new McpServer({
    name: 'tastecaliber-mcp-edge',
    version: '1.1.0',
  });

  // 1. taste_get_context
  server.registerTool(
    'taste_get_context',
    {
      title: 'Get Budgeted Taste Context',
      description:
        'Retrieve token-budgeted, file- and task-relevant rules and verified micro-skills from Cloudflare D1.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
        categories: z.array(z.string()).optional(),
        filePath: z.string().optional(),
        taskQuery: z.string().optional(),
        maxTokens: z.number().min(120).max(4000).optional().default(800),
        compact: z.boolean().optional().default(true),
        includeHints: z.boolean().optional().default(true),
        includeMicroSkills: z.boolean().optional().default(true),
        responseFormat: z.enum(['compact', 'json', 'both']).optional().default('compact'),
        agentName: z.string().optional().default('Edge MCP Agent'),
      },
    },
    async ({
      scope,
      categories,
      filePath,
      taskQuery,
      maxTokens,
      compact,
      includeHints,
      includeMicroSkills,
      responseFormat,
      agentName,
    }) => {
      const [lrnRows, msRows, domRows] = await Promise.all([
        env.DB.prepare('SELECT * FROM learnings ORDER BY confidence DESC').all(),
        env.DB.prepare('SELECT * FROM micro_skills ORDER BY corroborations DESC').all(),
        env.DB.prepare('SELECT * FROM domain_packs').all(),
      ]);

      const budgeted = selectBudgetedLearnings({
        learnings: lrnRows.results.map(mapLearning),
        microSkills: msRows.results.map(mapMicroSkill),
        customDomains: domRows.results.map(mapDomainPack),
        scope,
        categories,
        filePath,
        taskQuery,
        maxTokens,
        compact,
        includeHints,
        includeMicroSkills,
      });

      const structuredJson = JSON.stringify(
        {
          enforced: budgeted.enforced,
          hints: budgeted.hints,
          conflicted: budgeted.conflicted,
          injectedMicroSkills: budgeted.injectedMicroSkills,
          economics: {
            baselineTokens: budgeted.baselineTokens,
            injectedTokens: budgeted.injectedTokens,
            tokensSaved: budgeted.tokensSaved,
            compressionRatioPct: budgeted.compressionRatioPct,
            omittedCount: budgeted.omittedCount,
            matchedCategories: budgeted.matchedCategories,
          },
        },
        null,
        2,
      );
      const compactText = `${budgeted.markdownText}\n\n<!-- tastecaliber: injected=${budgeted.injectedTokens}t, baseline=${budgeted.baselineTokens}t, saved=${budgeted.tokensSaved}t (${budgeted.compressionRatioPct}% pruned), omitted=${budgeted.omittedCount} -->`;
      const actualInjectedTokens =
        responseFormat === 'json'
          ? estimateTokens(structuredJson)
          : responseFormat === 'both'
            ? estimateTokens(compactText) + estimateTokens(structuredJson)
            : estimateTokens(compactText);
      const actualTokensSaved = Math.max(0, budgeted.baselineTokens - actualInjectedTokens);

      if (actualTokensSaved > 0) {
        await env.DB.prepare(
          `INSERT INTO economics_events (id, event_type, agent_name, file_path, baseline_tokens, injected_tokens, tokens_saved, details, created_at)
           VALUES (?, 'context_pruned', ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            `econ-${Date.now()}`,
            agentName,
            filePath ?? null,
            budgeted.baselineTokens,
            actualInjectedTokens,
            actualTokensSaved,
            `Edge budgeted context (${budgeted.compressionRatioPct}% saved)`,
            new Date().toISOString(),
          )
          .run();
      }

      await d1RecordToolUsage(env.DB, 'taste_get_context', actualInjectedTokens);

      if (responseFormat === 'json') return { content: [{ type: 'text', text: structuredJson }] };
      if (responseFormat === 'both') {
        return {
          content: [
            { type: 'text', text: compactText },
            { type: 'text', text: structuredJson },
          ],
        };
      }
      return { content: [{ type: 'text', text: compactText }] };
    },
  );

  // 2. taste_record_signal
  server.registerTool(
    'taste_record_signal',
    {
      title: 'Record Preference Signal',
      description: 'Classify and persist a coding/workflow preference signal through taste-1 on Cloudflare D1.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        signalType: z.enum(['accept', 'reject', 'edit', 'diff', 'prompt']),
        rawInput: z.string().min(2),
        diffBefore: z.string().optional(),
        diffAfter: z.string().optional(),
        filePath: z.string().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        scope: z.enum(['project', 'global', 'remote']).optional().default('project'),
        agentName: z.string().optional().default('Edge MCP Agent'),
      },
    },
    async (args) => {
      const res = await d1RecordSignal(env.DB, args);
      const payload = JSON.stringify(res, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_record_signal', estimateTokens(payload));
      return { content: [{ type: 'text', text: payload }] };
    },
  );

  // 3. taste_query_learnings
  server.registerTool(
    'taste_query_learnings',
    {
      title: 'Query Taste Learnings',
      description: 'Search and filter learned preferences stored in Cloudflare D1.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
        category: z.string().optional().default('all'),
        status: z.enum(['all', 'enforced', 'hint', 'conflicted', 'archived']).optional().default('all'),
        search: z.string().optional(),
        minConfidence: z.number().min(0).max(1).optional(),
      },
    },
    async ({ scope, category, status, search, minConfidence }) => {
      const rows = await env.DB.prepare('SELECT * FROM learnings ORDER BY confidence DESC, updated_at DESC').all();
      const q = search?.trim().toLowerCase();
      const filtered = rows.results.map(mapLearning).filter((l) => {
        if (scope !== 'all' && l.scope !== scope) return false;
        if (category !== 'all' && l.category.toLowerCase() !== category.toLowerCase()) return false;
        if (status !== 'all' && l.status !== status) return false;
        if (typeof minConfidence === 'number' && l.confidence < minConfidence) return false;
        if (
          q &&
          !`${l.ruleText} ${l.rationale} ${l.category} ${(l.tags ?? []).join(' ')}`.toLowerCase().includes(q)
        ) {
          return false;
        }
        return true;
      });
      const out = JSON.stringify({ count: filtered.length, learnings: filtered }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_query_learnings', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 4. taste_reinforce
  server.registerTool(
    'taste_reinforce',
    {
      title: 'Reinforce Learning (Meta-RL)',
      description: 'Apply explicit accept (+1) or reject (-1) RL reward feedback to recalibrate confidence.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        learningId: z.string(),
        feedback: z.enum(['accept', 'reject']),
      },
    },
    async ({ learningId, feedback }) => {
      const row = await env.DB.prepare('SELECT * FROM learnings WHERE id = ?').bind(learningId).first();
      if (!row) return mcpError(`Learning ${learningId} not found`, 'Call taste_query_learnings to inspect valid IDs.');
      const existing = mapLearning(row);
      const reward = feedback === 'accept' ? 1.0 : -1.0;
      const rl = updateMetaRL({
        confidenceBefore: existing.confidence,
        reward,
        evidenceCount: existing.evidenceCount + 1,
        hasConflict: Boolean(existing.conflictsWithId),
      });
      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE learnings SET confidence = ?, status = ?, reward_sum = reward_sum + ?, accept_count = accept_count + ?, reject_count = reject_count + ?, kl_divergence = ?, evidence_count = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(
          rl.confidenceAfter,
          rl.statusAfter,
          reward,
          feedback === 'accept' ? 1 : 0,
          feedback === 'reject' ? 1 : 0,
          rl.klPenalty,
          existing.evidenceCount + 1,
          now,
          learningId,
        )
        .run();
      const updated = await env.DB.prepare('SELECT * FROM learnings WHERE id = ?').bind(learningId).first();
      const out = JSON.stringify({ learning: updated ? mapLearning(updated) : existing, episode: rl }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_reinforce', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 5. taste_resolve_conflict
  server.registerTool(
    'taste_resolve_conflict',
    {
      title: 'Resolve Symbolic Conflict',
      description: 'Resolve a flagged contradiction between two competing taste learnings.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        conflictedLearningId: z.string(),
        resolution: z.enum(['keep_existing', 'accept_new', 'keep_both']),
      },
    },
    async ({ conflictedLearningId, resolution }) => {
      const row = await env.DB.prepare('SELECT * FROM learnings WHERE id = ?').bind(conflictedLearningId).first();
      if (!row) return mcpError(`Learning ${conflictedLearningId} not found`);
      const conflicted = mapLearning(row);
      const now = new Date().toISOString();
      if (resolution === 'keep_existing') {
        await env.DB.prepare(`UPDATE learnings SET status = 'archived', conflicts_with_id = NULL, updated_at = ? WHERE id = ?`)
          .bind(now, conflicted.id)
          .run();
      } else if (resolution === 'accept_new') {
        if (conflicted.conflictsWithId) {
          await env.DB.prepare(`UPDATE learnings SET status = 'archived', updated_at = ? WHERE id = ?`)
            .bind(now, conflicted.conflictsWithId)
            .run();
        }
        await env.DB.prepare(
          `UPDATE learnings SET status = 'enforced', confidence = ?, conflicts_with_id = NULL, updated_at = ? WHERE id = ?`,
        )
          .bind(Math.max(conflicted.confidence, 0.76), now, conflicted.id)
          .run();
      } else {
        await env.DB.prepare(`UPDATE learnings SET status = 'hint', conflicts_with_id = NULL, updated_at = ? WHERE id = ?`)
          .bind(now, conflicted.id)
          .run();
      }
      const updated = await env.DB.prepare('SELECT * FROM learnings WHERE id = ?').bind(conflicted.id).first();
      const out = JSON.stringify({ resolved: updated ? mapLearning(updated) : conflicted }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_resolve_conflict', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 6. taste_lint
  server.registerTool(
    'taste_lint',
    {
      title: 'Lint Taste Packages',
      description: 'Compile and validate all stored learnings in taste.md format.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const rows = await env.DB.prepare('SELECT * FROM learnings ORDER BY confidence DESC').all();
      const md = compileTasteMarkdown({
        title: 'tastecaliber-edge',
        scope: 'project',
        learnings: rows.results.map(mapLearning),
      });
      const result = lintTasteMarkdown('.tastecaliber/taste/taste.md', md);
      const out = JSON.stringify({ results: [result] }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_lint', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 7. taste_push_pull
  server.registerTool(
    'taste_push_pull',
    {
      title: 'Push or Pull Taste Packages',
      description: 'Merge or overwrite learnings between project, global, and remote scopes.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        action: z.enum(['push', 'pull']),
        fromScope: z.enum(['project', 'global', 'remote']),
        toScope: z.enum(['project', 'global', 'remote']),
        overwrite: z.boolean().optional().default(false),
      },
    },
    async ({ fromScope, toScope, overwrite }) => {
      const allRows = await env.DB.prepare('SELECT * FROM learnings').all();
      const all = allRows.results.map(mapLearning);
      const src = all.filter((l) => l.scope === fromScope && l.status !== 'archived');
      const target = all.filter((l) => l.scope === toScope);
      const now = new Date().toISOString();
      let added = 0;
      if (overwrite) {
        await env.DB.prepare('DELETE FROM learnings WHERE scope = ?').bind(toScope).run();
      }
      for (const s of src) {
        const match = !overwrite && target.find((t) => t.ruleKey === s.ruleKey && t.category === s.category);
        if (!match) {
          await env.DB.prepare(
            `INSERT INTO learnings (id, package_id, scope, category, rule_key, rule_text, rationale, confidence, status, reward_sum, accept_count, reject_count, kl_divergence, evidence_count, conflicts_with_id, tags, created_at, updated_at)
             VALUES (?, 'pkg-project-main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
          )
            .bind(
              `lrn-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
              toScope,
              s.category,
              s.ruleKey,
              s.ruleText,
              s.rationale,
              s.confidence,
              s.status === 'conflicted' ? 'hint' : s.status,
              s.rewardSum,
              s.acceptCount,
              s.rejectCount,
              s.klDivergence,
              s.evidenceCount,
              JSON.stringify(s.tags ?? []),
              now,
              now,
            )
            .run();
          added++;
        }
      }
      const out = JSON.stringify({ added, fromScope, toScope }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_push_pull', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 8. taste_list_providers
  server.registerTool(
    'taste_list_providers',
    {
      title: 'List Model Providers & Fast Presets',
      description: 'View configured providers and curated NVIDIA NIM / OpenRouter model presets.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const rows = await env.DB.prepare('SELECT * FROM providers ORDER BY is_active DESC, name ASC').all();
      const providers: ProviderConfig[] = rows.results.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        kind: r.kind as ProviderConfig['kind'],
        baseUrl: String(r.base_url),
        envVarName: String(r.env_var_name || ''),
        modelId: String(r.model_id),
        role: r.role as ProviderConfig['role'],
        isActive: Boolean(r.is_active),
        hasKeyConfigured: r.kind === 'local' ? true : Boolean(r.env_var_name),
        lastStatus: (r.last_status as ProviderConfig['lastStatus']) || 'unknown',
        lastLatencyMs: r.last_latency_ms ? Number(r.last_latency_ms) : null,
        lastError: r.last_error ? String(r.last_error) : null,
      }));
      const out = JSON.stringify({ providers, nvidiaFastModels: NVIDIA_FAST_MODELS, openRouterFreeModels: OPENROUTER_FREE_MODELS }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_list_providers', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 9. taste_set_provider
  server.registerTool(
    'taste_set_provider',
    {
      title: 'Switch Active Model Provider',
      description: 'Assign a provider and optional modelId to Step 1, Step 3, or both.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        providerId: z.string(),
        role: z.enum(['input_extractor', 'output_writer', 'both', 'standby']).default('both'),
        modelId: z.string().optional(),
      },
    },
    async ({ providerId, role, modelId }) => {
      const existing = await env.DB.prepare('SELECT id FROM providers WHERE id = ?').bind(providerId).first();
      if (!existing) return mcpError(`Provider ${providerId} not found`, 'Call taste_list_providers first.');
      if (modelId?.trim()) {
        await env.DB.prepare('UPDATE providers SET role = ?, is_active = ?, model_id = ? WHERE id = ?')
          .bind(role, role === 'standby' ? 0 : 1, modelId.trim(), providerId)
          .run();
      } else {
        await env.DB.prepare('UPDATE providers SET role = ?, is_active = ? WHERE id = ?')
          .bind(role, role === 'standby' ? 0 : 1, providerId)
          .run();
      }
      const rows = await env.DB.prepare('SELECT * FROM providers').all();
      const out = JSON.stringify({ providers: rows.results }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_set_provider', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 10. taste_configure_settings
  server.registerTool(
    'taste_configure_settings',
    {
      title: 'Configure Taste Learning Settings',
      description: 'Enable or pause TasteCaliber learning at project or user scope.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        tasteLearningProject: z.boolean().optional(),
        tasteLearningUser: z.boolean().optional(),
      },
    },
    async ({ tasteLearningProject, tasteLearningUser }) => {
      if (typeof tasteLearningProject === 'boolean') {
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
          .bind('tasteLearningProject', String(tasteLearningProject))
          .run();
      }
      if (typeof tasteLearningUser === 'boolean') {
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
          .bind('tasteLearningUser', String(tasteLearningUser))
          .run();
      }
      const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
      const out = JSON.stringify({ settings: rows.results }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_configure_settings', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 11. taste_bootstrap
  server.registerTool(
    'taste_bootstrap',
    {
      title: 'Bootstrap Taste From Guidelines',
      description: 'Batch extract and classify multiple preferences from pasted bullet lists or guidelines.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        text: z.string().min(10),
        filePath: z.string().optional(),
        scope: z.enum(['project', 'global', 'remote']).optional().default('project'),
        agentName: z.string().optional().default('Edge Bootstrap'),
      },
    },
    async ({ text, filePath, scope, agentName }) => {
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim())
        .filter((l) => l.length >= 10)
        .slice(0, 12);
      const learned: unknown[] = [];
      let skippedNoise = 0;
      for (const line of lines) {
        const res = await d1RecordSignal(env.DB, {
          signalType: 'prompt',
          rawInput: line,
          filePath,
          scope,
          agentName,
        });
        if (res.decision.isPreference) learned.push(res);
        else skippedNoise++;
      }
      const out = JSON.stringify({ processedCount: lines.length, learnedCount: learned.length, skippedNoise, learned }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_bootstrap', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 12. taste_record_micro_skill
  server.registerTool(
    'taste_record_micro_skill',
    {
      title: 'Record or Corroborate Operational Micro-Skill',
      description: 'Store or corroborate an operational repository/workflow fact (promotes to verified at >=2).',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        category: z.string().optional().default('pattern'),
        triggerPattern: z.string().min(3),
        factText: z.string().min(5),
        scope: z.enum(['project', 'global', 'remote']).optional().default('project'),
        estimatedTokensSaved: z.number().min(50).max(2000).optional().default(240),
      },
    },
    async ({ category, triggerPattern, factText, scope, estimatedTokensSaved }) => {
      const now = new Date().toISOString();
      const cat = normalizeCategorySlug(category);
      const existing = await env.DB.prepare(
        `SELECT * FROM micro_skills WHERE scope = ? AND status != 'retired' AND (LOWER(trigger_pattern) = LOWER(?) OR LOWER(fact_text) = LOWER(?))`,
      )
        .bind(scope, triggerPattern.trim(), factText.trim())
        .first();
      if (existing) {
        const nextCorr = Number(existing.corroborations) + 1;
        const nextStatus: MicroSkillStatus = nextCorr >= 2 ? 'verified' : 'candidate';
        await env.DB.prepare('UPDATE micro_skills SET corroborations = ?, status = ?, fact_text = ?, updated_at = ? WHERE id = ?')
          .bind(nextCorr, nextStatus, factText.trim(), now, String(existing.id))
          .run();
        const updated = await env.DB.prepare('SELECT * FROM micro_skills WHERE id = ?').bind(String(existing.id)).first();
        const out = JSON.stringify({ microSkill: updated ? mapMicroSkill(updated) : null, corroborated: true }, null, 2);
        await d1RecordToolUsage(env.DB, 'taste_record_micro_skill', estimateTokens(out));
        return { content: [{ type: 'text', text: out }] };
      }
      const id = `ms-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      await env.DB.prepare(
        `INSERT INTO micro_skills (id, scope, category, trigger_pattern, fact_text, corroborations, status, estimated_tokens_saved, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'candidate', ?, NULL, ?, ?)`,
      )
        .bind(id, scope, cat, triggerPattern.trim(), factText.trim(), Math.round(estimatedTokensSaved), now, now)
        .run();
      const created = await env.DB.prepare('SELECT * FROM micro_skills WHERE id = ?').bind(id).first();
      const out = JSON.stringify({ microSkill: created ? mapMicroSkill(created) : null, corroborated: false }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_record_micro_skill', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 13. taste_list_micro_skills
  server.registerTool(
    'taste_list_micro_skills',
    {
      title: 'List Repository & Workflow Micro-Skills',
      description: 'Inspect verified, candidate, or retired micro-skills in Cloudflare D1.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
        status: z.enum(['all', 'verified', 'candidate', 'retired']).optional().default('all'),
        category: z.string().optional().default('all'),
      },
    },
    async ({ scope, status, category }) => {
      const rows = await env.DB.prepare('SELECT * FROM micro_skills ORDER BY corroborations DESC').all();
      const microSkills = rows.results.map(mapMicroSkill).filter((m) => {
        if (scope !== 'all' && m.scope !== scope) return false;
        if (status !== 'all' && m.status !== status) return false;
        if (category !== 'all' && m.category.toLowerCase() !== category.toLowerCase()) return false;
        return true;
      });
      const out = JSON.stringify({ count: microSkills.length, microSkills }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_list_micro_skills', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 14. taste_get_economics
  server.registerTool(
    'taste_get_economics',
    {
      title: 'Get Token Economics & Tool Pruning Report',
      description: 'Retrieve TokenEconomizer savings, loops prevented, and tool pruning advice.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {},
    },
    async () => {
      const [evRows, msRows, toolRows] = await Promise.all([
        env.DB.prepare('SELECT * FROM economics_events ORDER BY created_at DESC LIMIT 25').all(),
        env.DB.prepare('SELECT status FROM micro_skills').all(),
        env.DB.prepare('SELECT * FROM tool_usage ORDER BY call_count DESC').all(),
      ]);
      const recentEvents: EconomicsEvent[] = evRows.results.map((r) => ({
        id: String(r.id),
        eventType: r.event_type as EconomicsEventType,
        agentName: String(r.agent_name),
        filePath: r.file_path ? String(r.file_path) : null,
        baselineTokens: Number(r.baseline_tokens),
        injectedTokens: Number(r.injected_tokens),
        tokensSaved: Number(r.tokens_saved),
        details: String(r.details),
        createdAt: String(r.created_at),
      }));
      const totalBaselineTokens = recentEvents.reduce((s, e) => s + e.baselineTokens, 0);
      const totalTokensSaved = recentEvents.reduce((s, e) => s + e.tokensSaved, 0);
      const totalInjectedTokens = recentEvents.reduce((s, e) => s + e.injectedTokens, 0);
      const toolUsage: ToolUsageStat[] = toolRows.results.map((r) => ({
        toolName: String(r.tool_name),
        callCount: Number(r.call_count),
        avgResponseTokens: Number(r.avg_response_tokens),
        lastCalledAt: r.last_called_at ? String(r.last_called_at) : null,
      }));
      const unusedToolRecommendations = recommendUnusedTools(EDGE_TOOL_NAMES, toolUsage);
      const out = JSON.stringify(
        {
          totalTokensSaved,
          totalBaselineTokens,
          totalInjectedTokens,
          compressionRatioPct:
            totalBaselineTokens > 0 ? Math.round((totalTokensSaved / totalBaselineTokens) * 1000) / 10 : 0,
          loopsPrevented: recentEvents.filter((e) => e.eventType === 'loop_prevented').length,
          verifiedMicroSkills: msRows.results.filter((m) => m.status === 'verified').length,
          candidateMicroSkills: msRows.results.filter((m) => m.status === 'candidate').length,
          toolUsage,
          unusedToolRecommendations,
          prunedAllowlistSnippet: buildPrunedAllowlistConfig(unusedToolRecommendations),
          recentEvents,
        },
        null,
        2,
      );
      await d1RecordToolUsage(env.DB, 'taste_get_economics', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 15. taste_manage_learning
  server.registerTool(
    'taste_manage_learning',
    {
      title: 'Manage Taste Learning Lifecycle',
      description: 'Edit, archive, or restore an existing taste learning by ID.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        learningId: z.string(),
        action: z.enum(['edit', 'archive', 'restore']),
        ruleText: z.string().optional(),
        rationale: z.string().optional(),
        category: z.string().optional(),
        tags: z.array(z.string()).optional(),
        hardDelete: z.boolean().optional().default(false),
      },
    },
    async ({ learningId, action, ruleText, rationale, category, tags, hardDelete }) => {
      const row = await env.DB.prepare('SELECT * FROM learnings WHERE id = ?').bind(learningId).first();
      if (!row) return mcpError(`Learning ${learningId} not found`, 'Call taste_query_learnings first.');
      const existing = mapLearning(row);
      const now = new Date().toISOString();
      if (action === 'archive') {
        if (hardDelete) await env.DB.prepare('DELETE FROM learnings WHERE id = ?').bind(learningId).run();
        else await env.DB.prepare(`UPDATE learnings SET status = 'archived', updated_at = ? WHERE id = ?`).bind(now, learningId).run();
      } else if (action === 'restore') {
        const st = existing.confidence >= 0.72 ? 'enforced' : 'hint';
        await env.DB.prepare('UPDATE learnings SET status = ?, updated_at = ? WHERE id = ?').bind(st, now, learningId).run();
      } else {
        const nextRule = ruleText?.trim() || existing.ruleText;
        const nextRat = rationale !== undefined ? rationale.trim() : existing.rationale;
        const nextCat = category?.trim() ? normalizeCategorySlug(category) : existing.category;
        const nextTags = tags ? tags.map((t) => normalizeCategorySlug(t)) : existing.tags ?? [];
        await env.DB.prepare(
          'UPDATE learnings SET rule_text = ?, rationale = ?, category = ?, rule_key = ?, tags = ?, updated_at = ? WHERE id = ?',
        )
          .bind(nextRule, nextRat, nextCat, normalizeRuleKey(nextRule), JSON.stringify(nextTags), now, learningId)
          .run();
      }
      const updated = await env.DB.prepare('SELECT * FROM learnings WHERE id = ?').bind(learningId).first();
      const out = JSON.stringify({ learning: updated ? mapLearning(updated) : null, action }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_manage_learning', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 16. taste_manage_micro_skill
  server.registerTool(
    'taste_manage_micro_skill',
    {
      title: 'Manage Repository Micro-Skill Lifecycle',
      description: 'Corroborate or retire a micro-skill by ID.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        microSkillId: z.string(),
        action: z.enum(['corroborate', 'retire']),
      },
    },
    async ({ microSkillId, action }) => {
      const row = await env.DB.prepare('SELECT * FROM micro_skills WHERE id = ?').bind(microSkillId).first();
      if (!row) return mcpError(`Micro-skill ${microSkillId} not found`);
      const now = new Date().toISOString();
      if (action === 'retire') {
        await env.DB.prepare(`UPDATE micro_skills SET status = 'retired', updated_at = ? WHERE id = ?`).bind(now, microSkillId).run();
      } else {
        const nextCorr = Number(row.corroborations) + 1;
        await env.DB.prepare('UPDATE micro_skills SET corroborations = ?, status = ?, updated_at = ? WHERE id = ?')
          .bind(nextCorr, nextCorr >= 2 ? 'verified' : 'candidate', now, microSkillId)
          .run();
      }
      const updated = await env.DB.prepare('SELECT * FROM micro_skills WHERE id = ?').bind(microSkillId).first();
      const out = JSON.stringify({ microSkill: updated ? mapMicroSkill(updated) : null }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_manage_micro_skill', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 17. taste_verify_patch
  server.registerTool(
    'taste_verify_patch',
    {
      title: 'Verify Code or Patch Against Taste',
      description: 'Run deterministic pre-flight validation on proposed code, diffs, or drafts against enforced rules.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        code: z.string().min(1),
        filePath: z.string().optional(),
        taskQuery: z.string().optional(),
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
      },
    },
    async ({ code, filePath, taskQuery, scope }) => {
      const [lrnRows, msRows] = await Promise.all([
        env.DB.prepare('SELECT * FROM learnings').all(),
        env.DB.prepare('SELECT * FROM micro_skills').all(),
      ]);
      const learnings = lrnRows.results.map(mapLearning).filter((l) => scope === 'all' || l.scope === scope);
      const microSkills = msRows.results.map(mapMicroSkill).filter((m) => scope === 'all' || m.scope === scope);
      const report = verifyPatchAgainstTaste({ code, filePath, taskQuery, learnings, microSkills });
      const out = JSON.stringify(report, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_verify_patch', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 18. taste_register_domain
  server.registerTool(
    'taste_register_domain',
    {
      title: 'Register or Extend Custom Domain Pack',
      description: 'Register or update a custom domain/category pack in Cloudflare D1.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        slug: z.string().min(2),
        label: z.string().min(2),
        description: z.string().optional(),
        keywords: z.array(z.string()).optional().default([]),
        fileExtensions: z.array(z.string()).optional().default([]),
      },
    },
    async ({ slug, label, description, keywords, fileExtensions }) => {
      const cleanSlug = normalizeCategorySlug(slug);
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT OR REPLACE INTO domain_packs (id, slug, label, description, keywords_json, file_extensions_json, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
        .bind(
          `dom-${cleanSlug}`,
          cleanSlug,
          label.trim(),
          description?.trim() || `Custom domain pack for ${cleanSlug}`,
          JSON.stringify(keywords),
          JSON.stringify(fileExtensions),
          now,
          now,
        )
        .run();
      const out = JSON.stringify({ slug: cleanSlug, label: label.trim(), keywords, fileExtensions }, null, 2);
      await d1RecordToolUsage(env.DB, 'taste_register_domain', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // Resources
  server.registerResource(
    'project-taste-markdown',
    'taste://profile/project',
    { title: 'Project Taste Profile (taste.md)', description: 'Compiled project rules', mimeType: 'text/markdown' },
    async () => {
      const rows = await env.DB.prepare(`SELECT * FROM learnings WHERE scope = 'project'`).all();
      return {
        contents: [
          {
            uri: 'taste://profile/project',
            mimeType: 'text/markdown',
            text: compileTasteMarkdown({ title: 'tastecaliber-edge', scope: 'project', learnings: rows.results.map(mapLearning) }),
          },
        ],
      };
    },
  );

  server.registerResource(
    'global-taste-markdown',
    'taste://profile/global',
    { title: 'Global Personal Taste Profile', description: 'Compiled global rules', mimeType: 'text/markdown' },
    async () => {
      const rows = await env.DB.prepare(`SELECT * FROM learnings WHERE scope = 'global'`).all();
      return {
        contents: [
          {
            uri: 'taste://profile/global',
            mimeType: 'text/markdown',
            text: compileTasteMarkdown({ title: 'global', scope: 'global', learnings: rows.results.map(mapLearning) }),
          },
        ],
      };
    },
  );

  server.registerResource(
    'meta-rl-objective',
    'taste://objective/metrics',
    { title: 'Meta-NeuroSymbolic RL Telemetry', description: 'Recent RL episodes', mimeType: 'application/json' },
    async () => {
      const rows = await env.DB.prepare('SELECT * FROM rl_episodes ORDER BY created_at DESC LIMIT 20').all();
      return {
        contents: [
          {
            uri: 'taste://objective/metrics',
            mimeType: 'application/json',
            text: JSON.stringify({ episodes: rows.results as unknown as RlEpisode[] }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'taste-domains-index',
    'taste://domains',
    { title: 'Active Domains & Category Index', description: 'Canonical & custom domains', mimeType: 'application/json' },
    async () => {
      const domRows = await env.DB.prepare('SELECT * FROM domain_packs').all();
      return {
        contents: [
          {
            uri: 'taste://domains',
            mimeType: 'application/json',
            text: JSON.stringify({ canonicalFacets: TASTE_CATEGORIES, domainPacks: domRows.results.map(mapDomainPack) }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'taste-category-slice',
    new ResourceTemplate('taste://category/{category}', {
      list: async () => ({
        resources: TASTE_CATEGORIES.map((c) => ({
          uri: `taste://category/${c}`,
          name: `Taste Slice: ${c}`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    { title: 'Domain/Category Taste Slice', description: 'Compiled rules for a single category', mimeType: 'text/markdown' },
    async (uri, variables) => {
      const cat = normalizeCategorySlug(String(variables.category ?? 'general'));
      const rows = await env.DB.prepare('SELECT * FROM learnings WHERE category = ?').bind(cat).all();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: compileTasteMarkdown({ title: `edge / ${cat}`, scope: 'project', learnings: rows.results.map(mapLearning) }),
          },
        ],
      };
    },
  );

  // Prompts
  server.registerPrompt(
    'apply_coding_taste',
    {
      title: 'Apply Coding Taste',
      description: 'Inject enforced developer preferences before generating or reviewing code',
      argsSchema: { task: z.string() },
    },
    async ({ task }) => {
      const rows = await env.DB.prepare(`SELECT * FROM learnings WHERE status = 'enforced' ORDER BY confidence DESC`).all();
      const rules = rows.results.map(mapLearning).map((l) => `- (${l.category}, ${l.confidence.toFixed(2)}) ${l.ruleText}`).join('\n');
      return {
        messages: [
          { role: 'user', content: { type: 'text', text: `Task: "${task}"\n\nFollow these enforced TasteCaliber rules:\n\n${rules}` } },
        ],
      };
    },
  );

  server.registerPrompt(
    'apply_taste_for_domain',
    {
      title: 'Apply Domain & Daily-Task Taste',
      description: 'Inject budgeted rules and verified micro-skills tailored to any domain',
      argsSchema: {
        task: z.string(),
        domain: z.string().optional(),
        filePath: z.string().optional(),
      },
    },
    async ({ task, domain, filePath }) => {
      const [lrnRows, msRows] = await Promise.all([
        env.DB.prepare('SELECT * FROM learnings').all(),
        env.DB.prepare('SELECT * FROM micro_skills').all(),
      ]);
      const budgeted = selectBudgetedLearnings({
        learnings: lrnRows.results.map(mapLearning),
        microSkills: msRows.results.map(mapMicroSkill),
        categories: domain ? [normalizeCategorySlug(domain)] : undefined,
        filePath,
        taskQuery: task,
        maxTokens: 900,
        compact: true,
      });
      return {
        messages: [
          { role: 'user', content: { type: 'text', text: `Task: "${task}"\n\n${budgeted.markdownText}` } },
        ],
      };
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Authorization, X-API-Key',
        },
      });
    }

    if (url.pathname === '/api/health') {
      return new Response(
        JSON.stringify({
          ok: true,
          brand: 'TasteCaliber',
          runtime: 'cloudflare-workers',
          engine: 'taste-1',
          authProtected: Boolean(env.TASTE_API_TOKEN?.trim()),
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.pathname !== '/mcp') {
      return new Response(
        JSON.stringify({ name: 'tastecaliber-mcp-edge', version: '1.1.0', endpoint: '/mcp', health: '/api/health', tools: EDGE_TOOL_NAMES }),
        { headers: { 'content-type': 'application/json' } },
      );
    }

    const expectedToken = env.TASTE_API_TOKEN?.trim();
    if (expectedToken) {
      const auth = request.headers.get('authorization') || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const apiKey = (request.headers.get('x-api-key') || '').trim();
      if (bearer !== expectedToken && apiKey !== expectedToken) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: Bearer TASTE_API_TOKEN required' }, id: null }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
    }

    const server = buildEdgeMcpServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
