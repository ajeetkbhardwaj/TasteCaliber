import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  corroborateMicroSkillById,
  getEconomicsSummary,
  getSettings,
  lintAllPackages,
  listDomainPacks,
  listLearnings,
  listMicroSkills,
  listPackages,
  listProviders,
  listRlEpisodes,
  recordAgentTouch,
  recordEconomicsEvent,
  recordToolUsage,
  retireMicroSkill,
  touchMicroSkills,
  upsertDomainPack,
  upsertOrCorroborateMicroSkill,
} from './db.ts';
import {
  applyLearningFeedback,
  archiveOrDeleteLearning,
  bootstrapTasteFromSnippets,
  editLearning,
  processTasteSignal,
  pushOrPullPackages,
  resolveLearningConflict,
  restoreLearning,
} from './pipeline.ts';
import { activateProviderRole } from './providers.ts';
import { estimateTokens, selectBudgetedLearnings } from '../src/engine/economics.ts';
import {
  compileTasteMarkdown,
  normalizeCategorySlug,
  verifyPatchAgainstTaste,
} from '../src/engine/taste1.ts';
import {
  NVIDIA_FAST_MODELS,
  OPENROUTER_FREE_MODELS,
  TASTE_CATEGORIES,
} from '../src/engine/types.ts';
import type { TasteScope } from '../src/engine/types.ts';

function mcpError(message: string, recoveryHint?: string) {
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: message,
            ...(recoveryHint ? { recoveryHint } : {}),
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function createTasteMcpServer(db: DatabaseSync, transportKind: 'http' | 'stdio' = 'http'): McpServer {
  const server = new McpServer({
    name: 'tastecaliber-mcp',
    version: '1.1.0',
  });

  // 1. taste_get_context — token-true, file & task-aware context + verified micro-skills
  server.registerTool(
    'taste_get_context',
    {
      title: 'Get Budgeted Taste Context',
      description:
        'Retrieve token-budgeted, file- and task-relevant preferences plus verified repository/workflow micro-skills without prompt bloat. Defaults to compact markdown output so token savings match budget exactly.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        scope: z
          .enum(['all', 'project', 'global', 'remote'])
          .optional()
          .default('all')
          .describe('Memory scope filter (default: all).'),
        categories: z
          .array(z.string())
          .optional()
          .describe('Optional category slugs (e.g. typescript, database, python, devops, writing, or custom domains).'),
        filePath: z
          .string()
          .optional()
          .describe('Active file path (e.g. server/db.ts, app.py, README.md) to boost matching domain rules and micro-skills.'),
        taskQuery: z
          .string()
          .optional()
          .describe('Short description of the current task (useful for non-file tasks like emails, PR reviews, or DevOps runs).'),
        maxTokens: z
          .number()
          .min(120)
          .max(4000)
          .optional()
          .default(800)
          .describe('Maximum prompt tokens to allocate (120..4000, default 800).'),
        compact: z
          .boolean()
          .optional()
          .default(true)
          .describe('Use dense single-line rule format (default: true).'),
        includeHints: z
          .boolean()
          .optional()
          .default(true)
          .describe('Include soft hint rules below the 0.72 enforced threshold.'),
        includeMicroSkills: z
          .boolean()
          .optional()
          .default(true)
          .describe('Reserve a compact slot for verified operational micro-skills.'),
        responseFormat: z
          .enum(['compact', 'json', 'both'])
          .optional()
          .default('compact')
          .describe('compact returns markdown + 1-line budget footer (lowest tokens); json returns structured data; both returns both.'),
        agentName: z
          .string()
          .optional()
          .default('MCP Coding Agent')
          .describe('Client agent name for telemetry tracking.'),
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
      recordAgentTouch(db, agentName, transportKind);
      const learnings = listLearnings(db);
      const microSkills = listMicroSkills(db);
      const customDomains = listDomainPacks(db);

      const budgeted = selectBudgetedLearnings({
        learnings,
        microSkills,
        scope: scope ?? 'all',
        categories,
        filePath,
        taskQuery,
        customDomains,
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

      const footer = `\n\n<!-- tastecaliber: injected=${budgeted.injectedTokens}t, baseline=${budgeted.baselineTokens}t, saved=${budgeted.tokensSaved}t (${budgeted.compressionRatioPct}% pruned), omitted=${budgeted.omittedCount} -->`;
      const compactText = `${budgeted.markdownText}${footer}`;

      const actualInjectedTokens =
        responseFormat === 'json'
          ? estimateTokens(structuredJson)
          : responseFormat === 'both'
            ? estimateTokens(compactText) + estimateTokens(structuredJson)
            : estimateTokens(compactText);
      const actualTokensSaved = Math.max(0, budgeted.baselineTokens - actualInjectedTokens);
      const actualCompressionPct =
        budgeted.baselineTokens > 0
          ? Math.round((actualTokensSaved / budgeted.baselineTokens) * 1000) / 10
          : 0;

      if (actualTokensSaved > 0) {
        recordEconomicsEvent(db, {
          eventType: 'context_pruned',
          agentName,
          filePath: filePath ?? null,
          baselineTokens: budgeted.baselineTokens,
          injectedTokens: actualInjectedTokens,
          tokensSaved: actualTokensSaved,
          details: `Budgeted context (${actualCompressionPct}% reduction, ${budgeted.omittedCount} low-priority rules omitted, format=${responseFormat})`,
        });
      }

      if (budgeted.injectedMicroSkills.length > 0) {
        touchMicroSkills(
          db,
          budgeted.injectedMicroSkills.map((ms) => ms.id),
        );
        const msSavings = budgeted.injectedMicroSkills.reduce((acc, m) => acc + m.estimatedTokensSaved, 0);
        recordEconomicsEvent(db, {
          eventType: 'micro_skill_hit',
          agentName,
          filePath: filePath ?? null,
          baselineTokens: msSavings + 60,
          injectedTokens: 60,
          tokensSaved: msSavings,
          details: `Injected ${budgeted.injectedMicroSkills.length} verified micro-skill(s)`,
        });
      }

      recordToolUsage(db, 'taste_get_context', actualInjectedTokens);

      if (responseFormat === 'json') {
        return { content: [{ type: 'text', text: structuredJson }] };
      }
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

  // 2. taste_record_signal — ingests prompt, accept, reject, or diff through the 4-step pipeline + loop guard
  server.registerTool(
    'taste_record_signal',
    {
      title: 'Record Preference Signal',
      description:
        'Run the 4-step TasteCaliber pipeline (1: Input extraction, 2: taste-1 classification & symbolic conflict lock, 3: Markdown sync, 4: WAL SQLite persistence) with failure-loop intervention.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        signalType: z
          .enum(['accept', 'reject', 'edit', 'diff', 'prompt'])
          .describe('Kind of developer/user interaction signal.'),
        rawInput: z.string().min(2).describe('Explicit instruction or concise summary of the preference/correction.'),
        diffBefore: z.string().optional().describe('Code or text before the correction.'),
        diffAfter: z.string().optional().describe('Code or text after the correction.'),
        filePath: z.string().optional().describe('Target file path if applicable.'),
        category: z
          .string()
          .optional()
          .describe('Optional category/domain slug override (e.g. python, devops, writing, typescript).'),
        tags: z.array(z.string()).optional().describe('Optional semantic tags for retrieval.'),
        scope: z.enum(['project', 'global', 'remote']).optional().default('project').describe('Target storage scope.'),
        agentName: z.string().optional().default('MCP Coding Agent').describe('Client agent name.'),
      },
    },
    async ({ signalType, rawInput, diffBefore, diffAfter, filePath, category, tags, scope, agentName }) => {
      try {
        const trace = await processTasteSignal(db, {
          sourceAgent: agentName,
          transport: transportKind,
          signalType,
          scope,
          filePath,
          category,
          tags,
          rawInput,
          diffBefore,
          diffAfter,
        });

        const payload = JSON.stringify(
          {
            dryRun: Boolean(trace.dryRun),
            learningId: trace.step4.learning.id,
            category: trace.step2.category,
            tags: trace.step4.learning.tags ?? [],
            confidence: trace.step4.learning.confidence,
            status: trace.step4.learning.status,
            contradictsId: trace.step2.contradictsId,
            contradictionReason: trace.step2.contradictionReason,
            loopGuard: trace.loopGuard,
            extractorMode: trace.step1.extractorMode,
            modelUsed: trace.step1.modelUsed,
            fallbackChainUsed: trace.step1.fallbackChainUsed,
            syncedFiles: trace.step4.syncedFiles,
          },
          null,
          2,
        );
        recordToolUsage(db, 'taste_record_signal', estimateTokens(payload));
        return { content: [{ type: 'text', text: payload }] };
      } catch (err) {
        return mcpError(err instanceof Error ? err.message : 'Failed to process taste signal');
      }
    },
  );

  // 3. taste_query_learnings — inspect or filter learnings
  server.registerTool(
    'taste_query_learnings',
    {
      title: 'Query Taste Learnings',
      description: 'Search and filter learned preferences stored in local SQLite by scope, category, status, tags, or minimum confidence.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
        category: z.string().optional().default('all').describe('Category slug or "all".'),
        status: z.enum(['all', 'enforced', 'hint', 'conflicted', 'archived']).optional().default('all'),
        search: z.string().optional().describe('Keyword search across rule text, rationale, category, and tags.'),
        minConfidence: z.number().min(0).max(1).optional().describe('Minimum calibrated confidence [0..1].'),
        agentName: z.string().optional().describe('Optional client agent name for telemetry.'),
      },
    },
    async ({ scope, category, status, search, minConfidence, agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      const items = listLearnings(db, { scope, category, status, search, minConfidence });
      const out = JSON.stringify({ count: items.length, learnings: items }, null, 2);
      recordToolUsage(db, 'taste_query_learnings', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 4. taste_reinforce — Meta-RL accept/reject feedback on an existing learning
  server.registerTool(
    'taste_reinforce',
    {
      title: 'Reinforce Learning (Meta-RL)',
      description: 'Apply explicit accept (+1) or reject (-1) RL reward feedback to recalibrate a learning confidence score.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        learningId: z.string().describe('Target learning ID (query via taste_query_learnings if unknown).'),
        feedback: z.enum(['accept', 'reject']).describe('Explicit positive or negative reinforcement signal.'),
        agentName: z.string().optional(),
      },
    },
    async ({ learningId, feedback, agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      try {
        const result = applyLearningFeedback(db, learningId, feedback);
        const out = JSON.stringify(result, null, 2);
        recordToolUsage(db, 'taste_reinforce', estimateTokens(out));
        return { content: [{ type: 'text', text: out }] };
      } catch (err) {
        return mcpError(
          err instanceof Error ? err.message : 'Reinforcement failed',
          'Call taste_query_learnings first to verify the target learningId.',
        );
      }
    },
  );

  // 5. taste_resolve_conflict — resolve flagged symbolic contradictions
  server.registerTool(
    'taste_resolve_conflict',
    {
      title: 'Resolve Symbolic Conflict',
      description: 'Resolve a flagged contradiction between two competing taste learnings.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        conflictedLearningId: z.string().describe('ID of the conflicted learning (status="conflicted").'),
        resolution: z
          .enum(['keep_existing', 'accept_new', 'keep_both'])
          .describe('keep_existing archives the new rule; accept_new replaces the older rule; keep_both keeps both as hints.'),
        agentName: z.string().optional(),
      },
    },
    async ({ conflictedLearningId, resolution, agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      try {
        const res = resolveLearningConflict(db, conflictedLearningId, resolution);
        const out = JSON.stringify(res, null, 2);
        recordToolUsage(db, 'taste_resolve_conflict', estimateTokens(out));
        return { content: [{ type: 'text', text: out }] };
      } catch (err) {
        return mcpError(
          err instanceof Error ? err.message : 'Conflict resolution failed',
          'Call taste_query_learnings with status="conflicted" to inspect valid conflictedLearningId values.',
        );
      }
    },
  );

  // 6. taste_lint — validate all taste.md packages
  server.registerTool(
    'taste_lint',
    {
      title: 'Lint Taste Packages',
      description: 'Validate markdown structure, confidence bounds [0,1], headers, and UTF-8 across taste.md files.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        agentName: z.string().optional(),
      },
    },
    async ({ agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      const results = lintAllPackages(db);
      const out = JSON.stringify({ results }, null, 2);
      recordToolUsage(db, 'taste_lint', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 7. taste_push_pull — sync between project, global, and remote scopes
  server.registerTool(
    'taste_push_pull',
    {
      title: 'Push or Pull Taste Packages',
      description: 'Intelligently merge or overwrite learnings between project, global, and remote scopes.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        action: z.enum(['push', 'pull']),
        fromScope: z.enum(['project', 'global', 'remote']),
        toScope: z.enum(['project', 'global', 'remote']),
        overwrite: z.boolean().optional().default(false),
        agentName: z.string().optional(),
      },
    },
    async ({ action, fromScope, toScope, overwrite, agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      const summary = pushOrPullPackages(db, action, fromScope as TasteScope, toScope as TasteScope, overwrite);
      const out = JSON.stringify(summary, null, 2);
      recordToolUsage(db, 'taste_push_pull', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 8. taste_list_providers — inspect active Step 1 & Step 3 models and fast NVIDIA NIM presets
  server.registerTool(
    'taste_list_providers',
    {
      title: 'List Model Providers & Fast Presets',
      description:
        'View all configured Local Inference, NVIDIA NIM fast models, and OpenRouter providers along with active Step 1 / Step 3 role assignments.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        agentName: z.string().optional(),
      },
    },
    async ({ agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      const providers = listProviders(db);
      const out = JSON.stringify(
        {
          providers,
          nvidiaFastModels: NVIDIA_FAST_MODELS,
          openRouterFreeModels: OPENROUTER_FREE_MODELS,
        },
        null,
        2,
      );
      recordToolUsage(db, 'taste_list_providers', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 9. taste_set_provider — let coding agents switch active provider or fast NVIDIA model directly
  server.registerTool(
    'taste_set_provider',
    {
      title: 'Switch Active Model Provider',
      description:
        'Assign a provider (e.g. prov-nvidia-fast, prov-nvidia-nim, prov-ollama-local, prov-openrouter-free) to Step 1 (input_extractor), Step 3 (output_writer), or both, optionally setting a fast modelId.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        providerId: z.string().describe('Provider ID from taste_list_providers.'),
        role: z.enum(['input_extractor', 'output_writer', 'both', 'standby']).default('both'),
        modelId: z.string().optional().describe('Optional model ID override (e.g. meta/llama-3.1-8b-instruct).'),
        agentName: z.string().optional(),
      },
    },
    async ({ providerId, role, modelId, agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      try {
        const updated = activateProviderRole(db, providerId, role, modelId);
        const out = JSON.stringify({ providers: updated }, null, 2);
        recordToolUsage(db, 'taste_set_provider', estimateTokens(out));
        return { content: [{ type: 'text', text: out }] };
      } catch (err) {
        return mcpError(
          err instanceof Error ? err.message : 'Failed to switch provider',
          'Call taste_list_providers first to see valid providerId values.',
        );
      }
    },
  );

  // 10. taste_configure_settings — enable/disable project or user taste learning via MCP
  server.registerTool(
    'taste_configure_settings',
    {
      title: 'Configure Taste Learning Settings',
      description: 'Enable or pause TasteCaliber learning at the project or user level (dry-run mode when paused).',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        tasteLearningProject: z.boolean().optional(),
        tasteLearningUser: z.boolean().optional(),
        agentName: z.string().optional(),
      },
    },
    async ({ tasteLearningProject, tasteLearningUser, agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      if (typeof tasteLearningProject === 'boolean') {
        stmt.run('tasteLearningProject', String(tasteLearningProject));
      }
      if (typeof tasteLearningUser === 'boolean') {
        stmt.run('tasteLearningUser', String(tasteLearningUser));
      }
      const out = JSON.stringify({ settings: getSettings(db) }, null, 2);
      recordToolUsage(db, 'taste_configure_settings', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 11. taste_bootstrap — batch extract initial coding preferences from code/guidelines (/learn-taste)
  server.registerTool(
    'taste_bootstrap',
    {
      title: 'Bootstrap Taste From Guidelines or Code',
      description: 'Extract and classify multiple preferences in batch from style notes, PR comments, SOPs, or config rules.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        text: z.string().min(10).describe('Multiline guidelines, bullets, or notes to ingest (max 12 rules per call).'),
        filePath: z.string().optional().describe('Optional representative file path for domain classification.'),
        scope: z.enum(['project', 'global', 'remote']).optional().default('project'),
        agentName: z.string().optional().default('MCP Bootstrap'),
      },
    },
    async ({ text, filePath, scope, agentName }) => {
      recordAgentTouch(db, agentName, transportKind);
      const res = await bootstrapTasteFromSnippets(db, {
        text,
        filePath,
        scope,
        sourceAgent: agentName,
      });
      const out = JSON.stringify(res, null, 2);
      recordToolUsage(db, 'taste_bootstrap', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 12. taste_record_micro_skill — capture or corroborate operational facts across code & daily workflows
  server.registerTool(
    'taste_record_micro_skill',
    {
      title: 'Record or Corroborate Operational Micro-Skill',
      description:
        'Store a compact repository or workflow operational fact (test, build, lint, env, db, deploy, pattern, workflow, ops, docs, tool, data, or custom). Repeated corroborations (>=2) promote it to verified for turn-1 token savings.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        category: z
          .string()
          .optional()
          .default('pattern')
          .describe('Micro-skill category (e.g. test, build, lint, env, db, deploy, pattern, workflow, ops, docs).'),
        triggerPattern: z.string().min(3).describe('Short trigger description, e.g. "running unit tests".'),
        factText: z.string().min(5).describe('Exact operational command or verified fact.'),
        scope: z.enum(['project', 'global', 'remote']).optional().default('project'),
        estimatedTokensSaved: z.number().min(50).max(2000).optional().default(240),
        agentName: z.string().optional().default('MCP Coding Agent'),
      },
    },
    async ({ category, triggerPattern, factText, scope, estimatedTokensSaved, agentName }) => {
      recordAgentTouch(db, agentName, transportKind);
      const result = upsertOrCorroborateMicroSkill(db, {
        category: normalizeCategorySlug(category),
        triggerPattern,
        factText,
        scope,
        estimatedTokensSaved,
      });
      const out = JSON.stringify(result, null, 2);
      recordToolUsage(db, 'taste_record_micro_skill', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 13. taste_list_micro_skills — query verified/candidate repo micro-skills
  server.registerTool(
    'taste_list_micro_skills',
    {
      title: 'List Repository & Workflow Micro-Skills',
      description: 'Inspect verified, candidate, or retired operational facts stored in SQLite.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
        status: z.enum(['all', 'verified', 'candidate', 'retired']).optional().default('all'),
        category: z.string().optional().default('all'),
        agentName: z.string().optional(),
      },
    },
    async ({ scope, status, category, agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      const microSkills = listMicroSkills(db, { scope, status, category });
      const out = JSON.stringify({ count: microSkills.length, microSkills }, null, 2);
      recordToolUsage(db, 'taste_list_micro_skills', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 14. taste_get_economics — inspect token savings, failure loops prevented, and MCP tool pruning tips
  server.registerTool(
    'taste_get_economics',
    {
      title: 'Get Token Economics & Tool Pruning Report',
      description:
        'Retrieve TokenEconomizer metrics: total tokens saved, context compression ratio, failure loops prevented, verified micro-skills, unused MCP tools recommended for pruning, and a copy-paste allowlist snippet.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        agentName: z.string().optional(),
      },
    },
    async ({ agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      const summary = getEconomicsSummary(db);
      const out = JSON.stringify(summary, null, 2);
      recordToolUsage(db, 'taste_get_economics', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 15. taste_manage_learning — edit, archive, or restore existing learnings directly from any agent
  server.registerTool(
    'taste_manage_learning',
    {
      title: 'Manage Taste Learning Lifecycle',
      description: 'Edit rule text, rationale, category, or tags; archive an obsolete preference; or restore an archived learning.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        learningId: z.string().describe('Target learning ID.'),
        action: z.enum(['edit', 'archive', 'restore']),
        ruleText: z.string().optional(),
        rationale: z.string().optional(),
        category: z.string().optional().describe('Optional custom or canonical category slug.'),
        tags: z.array(z.string()).optional().describe('Optional replacement semantic tags.'),
        hardDelete: z.boolean().optional().default(false).describe('Permanently delete instead of soft-archiving.'),
        agentName: z.string().optional(),
      },
    },
    async ({ learningId, action, ruleText, rationale, category, tags, hardDelete, agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      try {
        let result: unknown;
        if (action === 'edit') {
          result = editLearning(db, learningId, { ruleText, rationale, category, tags });
        } else if (action === 'archive') {
          result = archiveOrDeleteLearning(db, learningId, hardDelete);
        } else {
          result = restoreLearning(db, learningId);
        }
        const out = JSON.stringify(result, null, 2);
        recordToolUsage(db, 'taste_manage_learning', estimateTokens(out));
        return { content: [{ type: 'text', text: out }] };
      } catch (err) {
        return mcpError(
          err instanceof Error ? err.message : 'Learning update failed',
          'Call taste_query_learnings (with status="all") to locate a valid learningId.',
        );
      }
    },
  );

  // 16. taste_manage_micro_skill — corroborate or retire a repository micro-skill by ID
  server.registerTool(
    'taste_manage_micro_skill',
    {
      title: 'Manage Repository Micro-Skill Lifecycle',
      description: 'Corroborate a candidate micro-skill (promotes to verified at x2) or retire a stale micro-skill.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        microSkillId: z.string().describe('Target micro-skill ID.'),
        action: z.enum(['corroborate', 'retire']),
        agentName: z.string().optional(),
      },
    },
    async ({ microSkillId, action, agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      try {
        const result =
          action === 'corroborate'
            ? { microSkill: corroborateMicroSkillById(db, microSkillId) }
            : retireMicroSkill(db, microSkillId);
        const out = JSON.stringify(result, null, 2);
        recordToolUsage(db, 'taste_manage_micro_skill', estimateTokens(out));
        return { content: [{ type: 'text', text: out }] };
      } catch (err) {
        return mcpError(
          err instanceof Error ? err.message : 'Micro-skill operation failed',
          'Call taste_list_micro_skills to inspect valid microSkillId values.',
        );
      }
    },
  );

  // 17. taste_verify_patch — deterministic pre-flight compliance checker against enforced rules & micro-skills
  server.registerTool(
    'taste_verify_patch',
    {
      title: 'Verify Code or Patch Against Taste',
      description:
        'Run deterministic pre-flight validation on a proposed code snippet, diff, or text draft against active enforced/hint rules before writing files or responding to the user.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        code: z.string().min(1).describe('Proposed code snippet, unified diff, or text draft to verify.'),
        filePath: z.string().optional().describe('Target file path for context and micro-skill matching.'),
        taskQuery: z.string().optional().describe('Short description of the task being completed.'),
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
        agentName: z.string().optional().default('MCP Coding Agent'),
      },
    },
    async ({ code, filePath, taskQuery, scope, agentName }) => {
      recordAgentTouch(db, agentName, transportKind);
      const learnings = listLearnings(db, { scope });
      const microSkills = listMicroSkills(db, { scope });
      const report = verifyPatchAgainstTaste({
        code,
        filePath,
        taskQuery,
        learnings,
        microSkills,
      });
      const out = JSON.stringify(report, null, 2);
      recordToolUsage(db, 'taste_verify_patch', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // 18. taste_register_domain — add/extend custom domain packs for any language, stack, or daily workflow
  server.registerTool(
    'taste_register_domain',
    {
      title: 'Register or Extend Custom Domain Pack',
      description:
        'Register or update a custom category/domain pack (e.g. rust, kubernetes, legal-review, email, customer-support) with keywords and file extensions so taste-1 classifies and boosts any daily-task domain.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        slug: z.string().min(2).describe('Lowercase domain slug (e.g. rust, kubernetes, email-writing).'),
        label: z.string().min(2).describe('Human-readable domain label.'),
        description: z.string().optional().describe('Short description of rules covered by this domain.'),
        keywords: z.array(z.string()).optional().default([]).describe('Keywords that signal this domain.'),
        fileExtensions: z
          .array(z.string())
          .optional()
          .default([])
          .describe('Matching file extensions or path suffixes (e.g. [".rs", ".toml"]).'),
        agentName: z.string().optional(),
      },
    },
    async ({ slug, label, description, keywords, fileExtensions, agentName }) => {
      if (agentName) recordAgentTouch(db, agentName, transportKind);
      const res = upsertDomainPack(db, { slug, label, description, keywords, fileExtensions });
      const out = JSON.stringify(res, null, 2);
      recordToolUsage(db, 'taste_register_domain', estimateTokens(out));
      return { content: [{ type: 'text', text: out }] };
    },
  );

  // MCP Resources (Static + Dynamic Templates)
  server.registerResource(
    'project-taste-markdown',
    'taste://profile/project',
    {
      title: 'Project Taste Profile (taste.md)',
      description: 'Compiled markdown rules for the active project scope',
      mimeType: 'text/markdown',
    },
    async () => {
      const pkg = listPackages(db).find((p) => p.scope === 'project');
      return {
        contents: [
          {
            uri: 'taste://profile/project',
            mimeType: 'text/markdown',
            text: pkg?.markdownContent ?? '# TasteCaliber Profile\n\nNo learnings recorded.',
          },
        ],
      };
    },
  );

  server.registerResource(
    'global-taste-markdown',
    'taste://profile/global',
    {
      title: 'Global Personal Taste Profile',
      description: 'Personal taste shared across projects and workflows',
      mimeType: 'text/markdown',
    },
    async () => {
      const pkg = listPackages(db).find((p) => p.scope === 'global');
      return {
        contents: [
          {
            uri: 'taste://profile/global',
            mimeType: 'text/markdown',
            text: pkg?.markdownContent ?? '# Global TasteCaliber\n\nNo learnings recorded.',
          },
        ],
      };
    },
  );

  server.registerResource(
    'meta-rl-objective',
    'taste://objective/metrics',
    {
      title: 'Meta-NeuroSymbolic RL Telemetry',
      description: 'Recent RL episodes, KL penalties, and calibrated confidence trajectories',
      mimeType: 'application/json',
    },
    async () => {
      const episodes = listRlEpisodes(db, 20);
      return {
        contents: [
          {
            uri: 'taste://objective/metrics',
            mimeType: 'application/json',
            text: JSON.stringify({ episodes }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'taste-domains-index',
    'taste://domains',
    {
      title: 'Active Domains & Category Index',
      description: 'Discoverable index of canonical facets, registered domain packs, and active rule counts',
      mimeType: 'application/json',
    },
    async () => {
      const domainPacks = listDomainPacks(db);
      const activeLearnings = listLearnings(db).filter((l) => l.status !== 'archived');
      const counts: Record<string, number> = {};
      for (const l of activeLearnings) {
        counts[l.category] = (counts[l.category] ?? 0) + 1;
      }
      return {
        contents: [
          {
            uri: 'taste://domains',
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                canonicalFacets: TASTE_CATEGORIES,
                domainPacks,
                activeCategoryCounts: counts,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerResource(
    'taste-category-slice',
    new ResourceTemplate('taste://category/{category}', {
      list: async () => {
        const cats = new Set<string>([
          ...TASTE_CATEGORIES,
          ...listDomainPacks(db).map((d) => d.slug),
          ...listLearnings(db).filter((l) => l.status !== 'archived').map((l) => l.category),
        ]);
        return {
          resources: Array.from(cats)
            .sort()
            .map((cat) => ({
              uri: `taste://category/${cat}`,
              name: `Taste Slice: ${cat}`,
              mimeType: 'text/markdown',
            })),
        };
      },
      complete: {
        category: async (value) => {
          const cats = Array.from(
            new Set<string>([
              ...TASTE_CATEGORIES,
              ...listDomainPacks(db).map((d) => d.slug),
            ]),
          );
          return cats.filter((c) => c.startsWith(value.toLowerCase()));
        },
      },
    }),
    {
      title: 'Domain/Category Taste Slice',
      description: 'Compiled markdown rules scoped to a single canonical or custom category',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const cat = normalizeCategorySlug(String(variables.category ?? 'general'));
      const learnings = listLearnings(db, { category: cat });
      const md = compileTasteMarkdown({
        title: `tastecaliber / ${cat}`,
        scope: 'project',
        learnings,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: md,
          },
        ],
      };
    },
  );

  server.registerResource(
    'taste-micro-skills-slice',
    new ResourceTemplate('taste://micro-skills/{category}', {
      list: async () => {
        const cats = Array.from(new Set(['all', ...listMicroSkills(db).map((m) => m.category)]));
        return {
          resources: cats.map((cat) => ({
            uri: `taste://micro-skills/${cat}`,
            name: `Micro-Skills: ${cat}`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Operational Micro-Skills Slice',
      description: 'Verified and candidate operational facts filtered by category (or "all")',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const cat = String(variables.category ?? 'all').toLowerCase();
      const microSkills = listMicroSkills(db, { category: cat });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ category: cat, count: microSkills.length, microSkills }, null, 2),
          },
        ],
      };
    },
  );

  // MCP Prompts
  server.registerPrompt(
    'apply_coding_taste',
    {
      title: 'Apply Coding Taste',
      description: 'Inject enforced developer preferences before generating or reviewing code',
      argsSchema: {
        task: z.string().describe('The coding task you are about to perform'),
      },
    },
    async ({ task }) => {
      const enforced = listLearnings(db, { status: 'enforced' });
      const rules = enforced.map((l) => `- (${l.category}, ${l.confidence.toFixed(2)}) ${l.ruleText}`).join('\n');
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Before executing this task: "${task}", strictly obey these enforced preferences from taste-1:\n\n${rules}`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'apply_taste_for_domain',
    {
      title: 'Apply Domain & Daily-Task Taste',
      description: 'Inject budgeted rules and verified micro-skills tailored to any domain (coding, DevOps, writing, data, workflow)',
      argsSchema: {
        task: z.string().describe('Task description (coding, docs, review, ops, email, etc.)'),
        domain: z.string().optional().describe('Optional domain/category slug (e.g. python, writing, devops, typescript)'),
        filePath: z.string().optional().describe('Optional active file path'),
      },
    },
    async ({ task, domain, filePath }) => {
      const budgeted = selectBudgetedLearnings({
        learnings: listLearnings(db),
        microSkills: listMicroSkills(db),
        categories: domain ? [normalizeCategorySlug(domain)] : undefined,
        filePath,
        taskQuery: task,
        customDomains: listDomainPacks(db),
        maxTokens: 900,
        compact: true,
      });
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Task: "${task}"\n\nFollow these calibrated TasteCaliber preferences and verified facts:\n\n${budgeted.markdownText}`,
            },
          },
        ],
      };
    },
  );

  return server;
}
