import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  getDb,
  getSettings,
  lintAllPackages,
  listLearnings,
  listPackages,
  listProviders,
  listRlEpisodes,
  listSignals,
} from './server/db.ts';
import { createTasteMcpServer } from './server/mcp.ts';
import {
  applyLearningFeedback,
  archiveOrDeleteLearning,
  bootstrapTasteFromSnippets,
  editLearning,
  processTasteSignal,
  pushOrPullPackages,
  resolveLearningConflict,
} from './server/pipeline.ts';
import {
  activateProviderRole,
  testProviderConnectivity,
  updateProviderSettings,
} from './server/providers.ts';
import { META_RL_CONFIG } from './src/engine/taste1.ts';
import {
  NVIDIA_FAST_MODELS,
  OPENROUTER_FREE_MODELS,
  ProviderKind,
  ProviderRole,
  SignalType,
  TasteCategory,
  TasteScope,
} from './src/engine/types.ts';

const PORT = Number(process.env.PORT || 3000);

async function startServer(): Promise<void> {
  const db = getDb();
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // CORS for Streamable HTTP MCP clients across IDEs & browsers
  app.use('/mcp', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, brand: 'TasteCaliber', engine: 'taste-1', storage: 'sqlite' });
  });

  // Streamable HTTP MCP Endpoint (stateless JSON-RPC 2.0 + SSE compatible)
  app.post('/mcp', async (req, res) => {
    const server = createTasteMcpServer(db, 'http');
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'MCP transport failure';
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', (_req, res) => {
    res.json({
      name: 'tastecaliber-mcp',
      version: '1.0.0',
      transport: 'streamable-http',
      endpoint: '/mcp',
      stdioCommand: 'npx tsx mcp-stdio.ts',
      tools: [
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
      ],
    });
  });

  app.delete('/mcp', (_req, res) => {
    res.status(200).json({ closed: true });
  });

  // Overview & Dashboard State
  app.get('/api/overview', (_req, res) => {
    const learnings = listLearnings(db);
    const packages = listPackages(db);
    const signals = listSignals(db, 12);
    const episodes = listRlEpisodes(db, 30);
    const providers = listProviders(db);
    const settings = getSettings(db);
    const lintResults = lintAllPackages(db);
    const agents = db.prepare('SELECT * FROM agent_connections ORDER BY last_seen_at DESC').all();

    res.json({
      metaRlConfig: META_RL_CONFIG,
      nvidiaFastModels: NVIDIA_FAST_MODELS,
      openRouterFreeModels: OPENROUTER_FREE_MODELS,
      learnings,
      packages,
      signals,
      episodes,
      providers,
      settings,
      lintResults,
      agents,
    });
  });

  // Learnings CRUD & Meta-RL Feedback
  app.get('/api/learnings', (req, res) => {
    const scope = (req.query.scope as TasteScope | 'all') || 'all';
    const category = (req.query.category as string) || 'all';
    const status = (req.query.status as string) || 'all';
    const search = (req.query.search as string) || '';
    res.json({ learnings: listLearnings(db, { scope, category, status, search }) });
  });

  app.patch('/api/learnings/:id', (req, res) => {
    try {
      const { ruleText, rationale, category } = req.body ?? {};
      const result = editLearning(db, req.params.id, {
        ruleText,
        rationale,
        category: category as TasteCategory | undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Learning not found' });
    }
  });

  app.delete('/api/learnings/:id', (req, res) => {
    try {
      const hard = req.query.hard === 'true';
      const result = archiveOrDeleteLearning(db, req.params.id, hard);
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Learning not found' });
    }
  });

  app.post('/api/learnings/:id/feedback', (req, res) => {
    try {
      const feedback = req.body?.feedback === 'reject' ? 'reject' : 'accept';
      const result = applyLearningFeedback(db, req.params.id, feedback);
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Failed to apply feedback' });
    }
  });

  app.post('/api/learnings/:id/resolve', (req, res) => {
    try {
      const resolution = req.body?.resolution as 'keep_existing' | 'accept_new' | 'keep_both';
      if (!['keep_existing', 'accept_new', 'keep_both'].includes(resolution)) {
        res.status(400).json({ error: 'Invalid resolution option' });
        return;
      }
      const result = resolveLearningConflict(db, req.params.id, resolution);
      res.json(result);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Failed to resolve conflict' });
    }
  });

  // Signal Ingestion & Batch Bootstrap
  app.post('/api/signals', async (req, res) => {
    try {
      const { rawInput, diffBefore, diffAfter, filePath, signalType, scope, sourceAgent } = req.body ?? {};
      if (!rawInput || typeof rawInput !== 'string' || rawInput.trim().length < 2) {
        res.status(400).json({ error: 'Please provide a descriptive coding preference or edit note (min 2 chars).' });
        return;
      }
      const trace = await processTasteSignal(db, {
        sourceAgent: sourceAgent || 'TasteCaliber Lab',
        signalType: (signalType as SignalType) || 'edit',
        scope: (scope as TasteScope) || 'project',
        filePath: filePath || null,
        rawInput: rawInput.trim(),
        diffBefore: diffBefore || null,
        diffAfter: diffAfter || null,
      });
      res.json(trace);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Pipeline execution error' });
    }
  });

  app.post('/api/bootstrap', async (req, res) => {
    try {
      const { text, filePath, scope, sourceAgent } = req.body ?? {};
      if (!text || typeof text !== 'string' || text.trim().length < 10) {
        res.status(400).json({ error: 'Please paste at least 10 characters of coding guidelines or notes.' });
        return;
      }
      const result = await bootstrapTasteFromSnippets(db, {
        text,
        filePath,
        scope: (scope as TasteScope) || 'project',
        sourceAgent: sourceAgent || 'TasteCaliber Bootstrap',
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Bootstrap failed' });
    }
  });

  // Export Taste Profile JSON
  app.get('/api/export', (_req, res) => {
    res.json({
      exportedAt: new Date().toISOString(),
      brand: 'TasteCaliber',
      learnings: listLearnings(db).filter((l) => l.status !== 'archived'),
      packages: listPackages(db),
      settings: getSettings(db),
    });
  });

  // Packages Push / Pull & Lint
  app.get('/api/packages', (_req, res) => {
    res.json({ packages: listPackages(db), lintResults: lintAllPackages(db) });
  });

  app.post('/api/packages/sync', (req, res) => {
    const { action, fromScope, toScope, overwrite } = req.body ?? {};
    if (!['push', 'pull'].includes(action) || !fromScope || !toScope) {
      res.status(400).json({ error: 'action, fromScope, and toScope are required' });
      return;
    }
    const result = pushOrPullPackages(db, action, fromScope, toScope, Boolean(overwrite));
    res.json(result);
  });

  app.get('/api/lint', (_req, res) => {
    res.json({ lintResults: lintAllPackages(db) });
  });

  // Model Providers (Local Inference, NVIDIA NIM Fast Models, OpenRouter)
  app.get('/api/providers', (_req, res) => {
    res.json({
      providers: listProviders(db),
      nvidiaFastModels: NVIDIA_FAST_MODELS,
      openRouterFreeModels: OPENROUTER_FREE_MODELS,
    });
  });

  app.post('/api/providers', (req, res) => {
    const { name, kind, baseUrl, envVarName, modelId, role } = req.body ?? {};
    if (!name || !baseUrl || !modelId) {
      res.status(400).json({ error: 'Provider name, base URL, and model ID are required.' });
      return;
    }
    const id = `prov-${Date.now()}`;
    db.prepare(
      `INSERT INTO providers (id, name, kind, base_url, env_var_name, model_id, role, is_active, last_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'unknown')`,
    ).run(
      id,
      String(name).trim(),
      (kind as ProviderKind) || 'local',
      String(baseUrl).trim(),
      String(envVarName || '').trim(),
      String(modelId).trim(),
      (role as ProviderRole) || 'standby',
    );
    res.json({ providers: listProviders(db), createdId: id });
  });

  app.patch('/api/providers/:id', (req, res) => {
    try {
      const providers = updateProviderSettings(db, req.params.id, req.body ?? {});
      res.json({ providers });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Provider not found' });
    }
  });

  app.put('/api/providers/:id/activate', (req, res) => {
    try {
      const role = (req.body?.role as ProviderRole) || 'both';
      const modelId = req.body?.modelId as string | undefined;
      const providers = activateProviderRole(db, req.params.id, role, modelId);
      res.json({ providers });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Provider not found' });
    }
  });

  app.post('/api/providers/:id/test', async (req, res) => {
    const result = await testProviderConnectivity(db, req.params.id);
    res.json({ ...result, providers: listProviders(db) });
  });

  // Settings
  app.put('/api/settings', (req, res) => {
    const updates = req.body as Record<string, unknown>;
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(updates)) {
      stmt.run(k, String(v));
    }
    res.json({ settings: getSettings(db) });
  });

  // Vite dev middleware vs static production serving
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TasteCaliber MCP Server listening on http://localhost:${PORT} (MCP endpoint: /mcp)`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start TasteCaliber MCP Server:', err);
  process.exit(1);
});
