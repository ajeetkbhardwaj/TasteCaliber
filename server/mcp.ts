import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import {
  corroborateMicroSkillById,
  getEconomicsSummary,
  getSettings,
  lintAllPackages,
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
  NVIDIA_FAST_MODELS,
  OPENROUTER_FREE_MODELS,
  TASTE_CATEGORIES,
} from '../src/engine/types.ts';
import type { TasteCategory, TasteScope } from '../src/engine/types.ts';

export function createTasteMcpServer(db: DatabaseSync, transportKind: 'http' | 'stdio' = 'http'): McpServer {
  const server = new McpServer({
    name: 'tastecaliber-mcp',
    version: '1.0.0',
  });

  // 1. taste_get_context — file-aware, token-budgeted context + verified repo micro-skills
  server.registerTool(
    'taste_get_context',
    {
      title: 'Get Budgeted Coding Taste Context',
      description:
        'Retrieve token-budgeted, file-relevant coding rules and verified repository micro-skills from local SQLite so agents stay taste-aligned without prompt bloat.',
      inputSchema: {
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
        categories: z.array(z.enum(TASTE_CATEGORIES)).optional(),
        filePath: z.string().optional(),
        maxTokens: z.number().min(120).max(4000).optional().default(800),
        compact: z.boolean().optional().default(true),
        includeHints: z.boolean().optional().default(true),
        includeMicroSkills: z.boolean().optional().default(true),
        agentName: z.string().optional().default('MCP Coding Agent'),
      },
    },
    async ({ scope, categories, filePath, maxTokens, compact, includeHints, includeMicroSkills, agentName }) => {
      recordAgentTouch(db, agentName, transportKind);
      const learnings = listLearnings(db);
      const microSkills = listMicroSkills(db);

      const budgeted = selectBudgetedLearnings({
        learnings,
        microSkills,
        scope: scope ?? 'all',
        categories,
        filePath,
        maxTokens,
        compact,
        includeHints,
        includeMicroSkills,
      });

      if (budgeted.tokensSaved > 0) {
        recordEconomicsEvent(db, {
          eventType: 'context_pruned',
          agentName,
          filePath: filePath ?? null,
          baselineTokens: budgeted.baselineTokens,
          injectedTokens: budgeted.injectedTokens,
          tokensSaved: budgeted.tokensSaved,
          details: `Budgeted context (${budgeted.compressionRatioPct}% reduction, ${budgeted.omittedCount} low-priority rules omitted)`,
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

      recordToolUsage(db, 'taste_get_context', budgeted.injectedTokens);

      return {
        content: [
          { type: 'text', text: budgeted.markdownText },
          {
            type: 'text',
            text: JSON.stringify(
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
            ),
          },
        ],
      };
    },
  );

  // 2. taste_record_signal — ingests prompt, accept, reject, or diff through the 4-step pipeline + loop guard
  server.registerTool(
    'taste_record_signal',
    {
      title: 'Record Coding Signal',
      description:
        'Run the 4-step TasteCaliber pipeline (1: Input LLM extraction, 2: taste-1 neuro-symbolic classification & conflict detection, 3: Output markdown compilation, 4: Local SQLite + .tastecaliber/taste sync) with failure-loop intervention.',
      inputSchema: {
        signalType: z.enum(['accept', 'reject', 'edit', 'diff', 'prompt']),
        rawInput: z.string().min(2),
        diffBefore: z.string().optional(),
        diffAfter: z.string().optional(),
        filePath: z.string().optional(),
        scope: z.enum(['project', 'global', 'remote']).optional().default('project'),
        agentName: z.string().optional().default('MCP Coding Agent'),
      },
    },
    async ({ signalType, rawInput, diffBefore, diffAfter, filePath, scope, agentName }) => {
      const trace = await processTasteSignal(db, {
        sourceAgent: agentName,
        transport: transportKind,
        signalType,
        scope,
        filePath,
        rawInput,
        diffBefore,
        diffAfter,
      });

      const payload = JSON.stringify(
        {
          dryRun: Boolean(trace.dryRun),
          learningId: trace.step4.learning.id,
          category: trace.step2.category,
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

      return {
        content: [{ type: 'text', text: payload }],
      };
    },
  );

  // 3. taste_query_learnings — inspect or filter learnings
  server.registerTool(
    'taste_query_learnings',
    {
      title: 'Query Taste Learnings',
      description: 'Search and filter learned preferences stored in local SQLite.',
      inputSchema: {
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
        category: z.string().optional().default('all'),
        status: z.enum(['all', 'enforced', 'hint', 'conflicted', 'archived']).optional().default('all'),
        search: z.string().optional(),
        minConfidence: z.number().min(0).max(1).optional(),
      },
    },
    async ({ scope, category, status, search, minConfidence }) => {
      const items = listLearnings(db, { scope, category, status, search, minConfidence });
      const out = JSON.stringify({ count: items.length, learnings: items }, null, 2);
      recordToolUsage(db, 'taste_query_learnings', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 4. taste_reinforce — Meta-RL accept/reject feedback on an existing learning
  server.registerTool(
    'taste_reinforce',
    {
      title: 'Reinforce Learning (Meta-RL)',
      description: 'Apply explicit accept (+1) or reject (-1) RL reward feedback to recalibrate a learning confidence score.',
      inputSchema: {
        learningId: z.string(),
        feedback: z.enum(['accept', 'reject']),
      },
    },
    async ({ learningId, feedback }) => {
      const result = applyLearningFeedback(db, learningId, feedback);
      const out = JSON.stringify(result, null, 2);
      recordToolUsage(db, 'taste_reinforce', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 5. taste_resolve_conflict — resolve flagged symbolic contradictions
  server.registerTool(
    'taste_resolve_conflict',
    {
      title: 'Resolve Symbolic Conflict',
      description: 'Resolve a flagged contradiction between two competing taste learnings.',
      inputSchema: {
        conflictedLearningId: z.string(),
        resolution: z.enum(['keep_existing', 'accept_new', 'keep_both']),
      },
    },
    async ({ conflictedLearningId, resolution }) => {
      const res = resolveLearningConflict(db, conflictedLearningId, resolution);
      const out = JSON.stringify(res, null, 2);
      recordToolUsage(db, 'taste_resolve_conflict', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 6. taste_lint — validate all taste.md packages
  server.registerTool(
    'taste_lint',
    {
      title: 'Lint Taste Packages',
      description: 'Validate markdown structure, confidence bounds [0,1], headers, and UTF-8 across taste.md files.',
      inputSchema: {},
    },
    async () => {
      const results = lintAllPackages(db);
      const out = JSON.stringify({ results }, null, 2);
      recordToolUsage(db, 'taste_lint', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 7. taste_push_pull — sync between project, global, and remote scopes
  server.registerTool(
    'taste_push_pull',
    {
      title: 'Push or Pull Taste Packages',
      description: 'Intelligently merge or overwrite learnings between project, global, and remote scopes.',
      inputSchema: {
        action: z.enum(['push', 'pull']),
        fromScope: z.enum(['project', 'global', 'remote']),
        toScope: z.enum(['project', 'global', 'remote']),
        overwrite: z.boolean().optional().default(false),
      },
    },
    async ({ action, fromScope, toScope, overwrite }) => {
      const summary = pushOrPullPackages(db, action, fromScope as TasteScope, toScope as TasteScope, overwrite);
      const out = JSON.stringify(summary, null, 2);
      recordToolUsage(db, 'taste_push_pull', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 8. taste_list_providers — inspect active Step 1 & Step 3 models and fast NVIDIA NIM presets
  server.registerTool(
    'taste_list_providers',
    {
      title: 'List Model Providers & Fast Presets',
      description:
        'View all configured Local Inference, NVIDIA NIM fast models, and OpenRouter providers along with active Step 1 / Step 3 role assignments.',
      inputSchema: {},
    },
    async () => {
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
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 9. taste_set_provider — let coding agents switch active provider or fast NVIDIA model directly
  server.registerTool(
    'taste_set_provider',
    {
      title: 'Switch Active Model Provider',
      description:
        'Assign a provider (e.g. prov-nvidia-fast, prov-nvidia-nim, prov-ollama-local, prov-openrouter-free) to Step 1 (input_extractor), Step 3 (output_writer), or both, optionally setting a fast modelId.',
      inputSchema: {
        providerId: z.string(),
        role: z.enum(['input_extractor', 'output_writer', 'both', 'standby']).default('both'),
        modelId: z.string().optional(),
      },
    },
    async ({ providerId, role, modelId }) => {
      const updated = activateProviderRole(db, providerId, role, modelId);
      const out = JSON.stringify({ providers: updated }, null, 2);
      recordToolUsage(db, 'taste_set_provider', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 10. taste_configure_settings — enable/disable project or user taste learning via MCP
  server.registerTool(
    'taste_configure_settings',
    {
      title: 'Configure Taste Learning Settings',
      description: 'Enable or pause TasteCaliber learning at the project or user level.',
      inputSchema: {
        tasteLearningProject: z.boolean().optional(),
        tasteLearningUser: z.boolean().optional(),
      },
    },
    async ({ tasteLearningProject, tasteLearningUser }) => {
      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      if (typeof tasteLearningProject === 'boolean') {
        stmt.run('tasteLearningProject', String(tasteLearningProject));
      }
      if (typeof tasteLearningUser === 'boolean') {
        stmt.run('tasteLearningUser', String(tasteLearningUser));
      }
      const out = JSON.stringify({ settings: getSettings(db) }, null, 2);
      recordToolUsage(db, 'taste_configure_settings', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 11. taste_bootstrap — batch extract initial coding preferences from code/guidelines (/learn-taste)
  server.registerTool(
    'taste_bootstrap',
    {
      title: 'Bootstrap Taste From Guidelines or Code',
      description: 'Extract and classify multiple coding preferences in batch from style notes, PR comments, or config rules.',
      inputSchema: {
        text: z.string().min(10),
        filePath: z.string().optional(),
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
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 12. taste_record_micro_skill — capture or corroborate operational repository facts
  server.registerTool(
    'taste_record_micro_skill',
    {
      title: 'Record or Corroborate Repo Micro-Skill',
      description:
        'Store a compact repository operational fact (test command, build flag, env setup). Repeated corroborations (>=2) promote it to verified for turn-1 token savings.',
      inputSchema: {
        category: z.enum(['test', 'build', 'lint', 'env', 'db', 'deploy', 'pattern']),
        triggerPattern: z.string().min(3),
        factText: z.string().min(5),
        scope: z.enum(['project', 'global', 'remote']).optional().default('project'),
        estimatedTokensSaved: z.number().min(50).max(2000).optional().default(240),
        agentName: z.string().optional().default('MCP Coding Agent'),
      },
    },
    async ({ category, triggerPattern, factText, scope, estimatedTokensSaved, agentName }) => {
      recordAgentTouch(db, agentName, transportKind);
      const result = upsertOrCorroborateMicroSkill(db, {
        category,
        triggerPattern,
        factText,
        scope,
        estimatedTokensSaved,
      });
      const out = JSON.stringify(result, null, 2);
      recordToolUsage(db, 'taste_record_micro_skill', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 13. taste_list_micro_skills — query verified/candidate repo micro-skills
  server.registerTool(
    'taste_list_micro_skills',
    {
      title: 'List Repository Micro-Skills',
      description: 'Inspect verified, candidate, or retired repository operational facts stored in SQLite.',
      inputSchema: {
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
        status: z.enum(['all', 'verified', 'candidate', 'retired']).optional().default('all'),
        category: z.string().optional().default('all'),
      },
    },
    async ({ scope, status, category }) => {
      const microSkills = listMicroSkills(db, { scope, status, category });
      const out = JSON.stringify({ count: microSkills.length, microSkills }, null, 2);
      recordToolUsage(db, 'taste_list_micro_skills', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 14. taste_get_economics — inspect token savings, failure loops prevented, and MCP tool pruning tips
  server.registerTool(
    'taste_get_economics',
    {
      title: 'Get Token Economics & Tool Pruning Report',
      description:
        'Retrieve TokenEconomizer metrics: total tokens saved, context compression ratio, failure loops prevented, verified micro-skills, and unused MCP tools recommended for pruning.',
      inputSchema: {},
    },
    async () => {
      const summary = getEconomicsSummary(db);
      const out = JSON.stringify(summary, null, 2);
      recordToolUsage(db, 'taste_get_economics', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 15. taste_manage_learning — edit, archive, or restore existing learnings directly from any agent
  server.registerTool(
    'taste_manage_learning',
    {
      title: 'Manage Taste Learning Lifecycle',
      description: 'Edit rule text/rationale/category, archive an obsolete preference, or restore an archived learning.',
      inputSchema: {
        learningId: z.string(),
        action: z.enum(['edit', 'archive', 'restore']),
        ruleText: z.string().optional(),
        rationale: z.string().optional(),
        category: z.enum(TASTE_CATEGORIES).optional(),
        hardDelete: z.boolean().optional().default(false),
      },
    },
    async ({ learningId, action, ruleText, rationale, category, hardDelete }) => {
      let result: unknown;
      if (action === 'edit') {
        result = editLearning(db, learningId, {
          ruleText,
          rationale,
          category: category as TasteCategory | undefined,
        });
      } else if (action === 'archive') {
        result = archiveOrDeleteLearning(db, learningId, hardDelete);
      } else {
        result = restoreLearning(db, learningId);
      }
      const out = JSON.stringify(result, null, 2);
      recordToolUsage(db, 'taste_manage_learning', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // 16. taste_manage_micro_skill — corroborate or retire a repository micro-skill by ID
  server.registerTool(
    'taste_manage_micro_skill',
    {
      title: 'Manage Repository Micro-Skill Lifecycle',
      description: 'Corroborate a candidate micro-skill (promotes to verified at x2) or retire a stale micro-skill.',
      inputSchema: {
        microSkillId: z.string(),
        action: z.enum(['corroborate', 'retire']),
      },
    },
    async ({ microSkillId, action }) => {
      const result =
        action === 'corroborate'
          ? { microSkill: corroborateMicroSkillById(db, microSkillId) }
          : retireMicroSkill(db, microSkillId);
      const out = JSON.stringify(result, null, 2);
      recordToolUsage(db, 'taste_manage_micro_skill', estimateTokens(out));
      return {
        content: [{ type: 'text', text: out }],
      };
    },
  );

  // MCP Resources
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
      description: 'Personal coding taste shared across projects',
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

  // MCP Prompt
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
              text: `Before executing this task: "${task}", strictly obey these enforced coding preferences from taste-1:\n\n${rules}`,
            },
          },
        ],
      };
    },
  );

  return server;
}
