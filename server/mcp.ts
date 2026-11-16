import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import {
  getSettings,
  lintAllPackages,
  listLearnings,
  listPackages,
  listProviders,
  listRlEpisodes,
  recordAgentTouch,
} from './db.ts';
import {
  applyLearningFeedback,
  bootstrapTasteFromSnippets,
  processTasteSignal,
  pushOrPullPackages,
  resolveLearningConflict,
} from './pipeline.ts';
import { activateProviderRole } from './providers.ts';
import {
  NVIDIA_FAST_MODELS,
  OPENROUTER_FREE_MODELS,
  TASTE_CATEGORIES,
  TasteScope,
} from '../src/engine/types.ts';

export function createTasteMcpServer(db: DatabaseSync, transportKind: 'http' | 'stdio' = 'http'): McpServer {
  const server = new McpServer({
    name: 'tastecaliber-mcp',
    version: '1.0.0',
  });

  // 1. taste_get_context — coding agents call this before writing/reviewing code
  server.registerTool(
    'taste_get_context',
    {
      title: 'Get Coding Taste Context',
      description:
        'Retrieve active enforced rules, low-confidence hints, and flagged conflicts from the local SQLite taste profile so the coding agent aligns with the user’s style and architecture.',
      inputSchema: {
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
        categories: z.array(z.enum(TASTE_CATEGORIES)).optional(),
        includeHints: z.boolean().optional().default(true),
        agentName: z.string().optional().default('MCP Coding Agent'),
      },
    },
    async ({ scope, categories, includeHints, agentName }) => {
      recordAgentTouch(db, agentName, transportKind);
      const learnings = listLearnings(db, { scope: scope ?? 'all' });
      const filtered = learnings.filter((l) => {
        if (l.status === 'archived') return false;
        if (!includeHints && l.status === 'hint') return false;
        if (categories && categories.length > 0 && !categories.includes(l.category)) return false;
        return true;
      });

      const enforced = filtered.filter((l) => l.status === 'enforced');
      const hints = filtered.filter((l) => l.status === 'hint');
      const conflicted = filtered.filter((l) => l.status === 'conflicted');

      const summaryText = [
        `# Active TasteCaliber Context (${filtered.length} rules)`,
        '',
        `## Enforced Preferences (${enforced.length})`,
        ...enforced.map((l) => `- [${l.category} | conf=${l.confidence.toFixed(2)}] ${l.ruleText}`),
        '',
        `## Low-Confidence Hints (${hints.length})`,
        ...hints.map((l) => `- [${l.category} | conf=${l.confidence.toFixed(2)}] ${l.ruleText}`),
        ...(conflicted.length > 0
          ? [
              '',
              `## Flagged Conflicts Requiring Review (${conflicted.length})`,
              ...conflicted.map((l) => `- [CONFLICT ${l.id}] ${l.ruleText} (conflicts with ${l.conflictsWithId})`),
            ]
          : []),
      ].join('\n');

      return {
        content: [
          { type: 'text', text: summaryText },
          {
            type: 'text',
            text: JSON.stringify({ enforced, hints, conflicted }, null, 2),
          },
        ],
      };
    },
  );

  // 2. taste_record_signal — ingests prompt, accept, reject, or diff through the 4-step pipeline
  server.registerTool(
    'taste_record_signal',
    {
      title: 'Record Coding Signal',
      description:
        'Run the 4-step TasteCaliber pipeline (1: Input LLM extraction, 2: taste-1 neuro-symbolic classification & conflict detection, 3: Output markdown compilation, 4: Local SQLite + .tastecaliber/taste sync).',
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                dryRun: Boolean(trace.dryRun),
                learningId: trace.step4.learning.id,
                category: trace.step2.category,
                confidence: trace.step4.learning.confidence,
                status: trace.step4.learning.status,
                contradictsId: trace.step2.contradictsId,
                contradictionReason: trace.step2.contradictionReason,
                extractorMode: trace.step1.extractorMode,
                modelUsed: trace.step1.modelUsed,
                fallbackChainUsed: trace.step1.fallbackChainUsed,
                syncedFiles: trace.step4.syncedFiles,
              },
              null,
              2,
            ),
          },
        ],
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
      return {
        content: [{ type: 'text', text: JSON.stringify({ count: items.length, learnings: items }, null, 2) }],
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
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
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
      return {
        content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }],
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
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
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
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                providers,
                nvidiaFastModels: NVIDIA_FAST_MODELS,
                openRouterFreeModels: OPENROUTER_FREE_MODELS,
              },
              null,
              2,
            ),
          },
        ],
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
      return {
        content: [{ type: 'text', text: JSON.stringify({ providers: updated }, null, 2) }],
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
      return {
        content: [{ type: 'text', text: JSON.stringify({ settings: getSettings(db) }, null, 2) }],
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
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
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
