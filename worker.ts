import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { selectBudgetedLearnings, estimateTokens } from './src/engine/economics.ts';
import {
  classifyWithTaste1,
  deterministicExtractSignal,
  findSimilarLearning,
  updateMetaRL,
} from './src/engine/taste1.ts';
import { TASTE_CATEGORIES } from './src/engine/types.ts';
import type {
  MicroSkill,
  MicroSkillCategory,
  SignalType,
  TasteCategory,
  TasteLearning,
  TasteScope,
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
  NVIDIA_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

function mapLearning(r: Record<string, unknown>): TasteLearning {
  return {
    id: String(r.id),
    packageId: String(r.package_id),
    scope: r.scope as TasteScope,
    category: r.category as TasteCategory,
    ruleKey: String(r.rule_key),
    ruleText: String(r.rule_text),
    rationale: String(r.rationale),
    confidence: Number(r.confidence),
    status: r.status as TasteLearning['status'],
    rewardSum: Number(r.reward_sum),
    acceptCount: Number(r.accept_count),
    rejectCount: Number(r.reject_count),
    klDivergence: Number(r.kl_divergence),
    evidenceCount: Number(r.evidence_count),
    conflictsWithId: r.conflicts_with_id ? String(r.conflicts_with_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapMicroSkill(r: Record<string, unknown>): MicroSkill {
  return {
    id: String(r.id),
    scope: r.scope as TasteScope,
    category: r.category as MicroSkillCategory,
    triggerPattern: String(r.trigger_pattern),
    factText: String(r.fact_text),
    corroborations: Number(r.corroborations),
    status: r.status as MicroSkill['status'],
    estimatedTokensSaved: Number(r.estimated_tokens_saved),
    lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function buildEdgeMcpServer(env: WorkerEnv): McpServer {
  const server = new McpServer({
    name: 'tastecaliber-mcp-edge',
    version: '1.0.0',
  });

  server.registerTool(
    'taste_get_context',
    {
      title: 'Get Budgeted Coding Taste Context',
      description: 'Retrieve token-budgeted coding preferences and verified repo micro-skills from Cloudflare D1.',
      inputSchema: {
        scope: z.enum(['all', 'project', 'global', 'remote']).optional().default('all'),
        categories: z.array(z.enum(TASTE_CATEGORIES)).optional(),
        filePath: z.string().optional(),
        maxTokens: z.number().min(120).max(4000).optional().default(800),
        compact: z.boolean().optional().default(true),
        includeHints: z.boolean().optional().default(true),
        includeMicroSkills: z.boolean().optional().default(true),
        agentName: z.string().optional().default('Edge MCP Agent'),
      },
    },
    async ({ scope, categories, filePath, maxTokens, compact, includeHints, includeMicroSkills, agentName }) => {
      const lrnRows = await env.DB.prepare('SELECT * FROM learnings ORDER BY confidence DESC').all();
      const msRows = await env.DB.prepare('SELECT * FROM micro_skills ORDER BY corroborations DESC').all();

      const budgeted = selectBudgetedLearnings({
        learnings: lrnRows.results.map(mapLearning),
        microSkills: msRows.results.map(mapMicroSkill),
        scope,
        categories,
        filePath,
        maxTokens,
        compact,
        includeHints,
        includeMicroSkills,
      });

      if (budgeted.tokensSaved > 0) {
        await env.DB.prepare(
          `INSERT INTO economics_events (id, event_type, agent_name, file_path, baseline_tokens, injected_tokens, tokens_saved, details, created_at)
           VALUES (?, 'context_pruned', ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            `econ-${Date.now()}`,
            agentName,
            filePath ?? null,
            budgeted.baselineTokens,
            budgeted.injectedTokens,
            budgeted.tokensSaved,
            `Edge budgeted context (${budgeted.compressionRatioPct}% saved)`,
            new Date().toISOString(),
          )
          .run();
      }

      return {
        content: [
          { type: 'text', text: budgeted.markdownText },
          { type: 'text', text: JSON.stringify(budgeted, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    'taste_record_signal',
    {
      title: 'Record Coding Signal',
      description: 'Classify and persist a coding preference signal through taste-1 on Cloudflare D1.',
      inputSchema: {
        signalType: z.enum(['accept', 'reject', 'edit', 'diff', 'prompt']),
        rawInput: z.string().min(2),
        diffBefore: z.string().optional(),
        diffAfter: z.string().optional(),
        filePath: z.string().optional(),
        scope: z.enum(['project', 'global', 'remote']).optional().default('project'),
      },
    },
    async ({ signalType, rawInput, diffBefore, diffAfter, filePath, scope }) => {
      const extracted = deterministicExtractSignal({
        rawInput,
        diffBefore,
        diffAfter,
        filePath,
        signalType: signalType as SignalType,
      });

      const existingRows = await env.DB.prepare('SELECT * FROM learnings').all();
      const existingLearnings = existingRows.results.map(mapLearning);
      const decision = classifyWithTaste1({
        extracted,
        signalType: signalType as SignalType,
        filePath,
        diffBefore,
        diffAfter,
        existingLearnings,
      });

      const reward = signalType === 'accept' ? 1.0 : signalType === 'reject' ? -0.8 : 0.75;
      const similar = findSimilarLearning({
        candidateRule: extracted.candidateRule,
        ruleKey: decision.ruleKey,
        category: decision.category,
        scope,
        existingLearnings,
        contradictsId: decision.contradictsId,
      });

      const now = new Date().toISOString();
      let learningId: string;

      if (similar) {
        learningId = similar.id;
        const rl = updateMetaRL({
          confidenceBefore: similar.confidence,
          reward,
          evidenceCount: similar.evidenceCount + 1,
          hasConflict: Boolean(similar.conflictsWithId),
        });
        await env.DB.prepare(
          `UPDATE learnings SET confidence = ?, status = ?, evidence_count = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(rl.confidenceAfter, rl.statusAfter, similar.evidenceCount + 1, now, similar.id)
          .run();
      } else {
        learningId = `lrn-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        await env.DB.prepare(
          `INSERT INTO learnings (id, package_id, scope, category, rule_key, rule_text, rationale, confidence, status, conflicts_with_id, created_at, updated_at)
           VALUES (?, 'pkg-project-main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            learningId,
            scope,
            decision.category,
            decision.ruleKey,
            extracted.candidateRule,
            extracted.rationale,
            decision.initialConfidence,
            decision.isPreference ? decision.recommendedStatus : 'archived',
            decision.contradictsId,
            now,
            now,
          )
          .run();
      }

      const payload = JSON.stringify({ learningId, decision, extracted, tokens: estimateTokens(rawInput) }, null, 2);
      return { content: [{ type: 'text', text: payload }] };
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
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, Authorization',
        },
      });
    }

    if (url.pathname === '/api/health') {
      return new Response(
        JSON.stringify({ ok: true, brand: 'TasteCaliber', runtime: 'cloudflare-workers', engine: 'taste-1' }),
        { headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.pathname !== '/mcp') {
      return new Response(
        JSON.stringify({ name: 'tastecaliber-mcp-edge', endpoint: '/mcp', health: '/api/health' }),
        { headers: { 'content-type': 'application/json' } },
      );
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
