import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LintFileResult,
  ProviderConfig,
  ProviderKind,
  ProviderRole,
  RlEpisode,
  TasteCategory,
  TasteLearning,
  TastePackage,
  TasteScope,
  TasteSignalRecord,
} from '../src/engine/types.ts';
import { compileTasteMarkdown, lintTasteMarkdown } from '../src/engine/taste1.ts';

const DEFAULT_DB_PATH = process.env.TASTE_DB_PATH || path.resolve(process.cwd(), 'data', 'taste.db');

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;

  const dir = path.dirname(DEFAULT_DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(DEFAULT_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');

  initSchema(db);
  seedIfEmpty(db);

  dbInstance = db;
  return db;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('project', 'global', 'remote')),
      category TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'local',
      is_public INTEGER NOT NULL DEFAULT 0,
      stars INTEGER NOT NULL DEFAULT 0,
      downloads INTEGER NOT NULL DEFAULT 0,
      markdown_content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learnings (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('project', 'global', 'remote')),
      category TEXT NOT NULL,
      rule_key TEXT NOT NULL,
      rule_text TEXT NOT NULL,
      rationale TEXT NOT NULL,
      confidence REAL NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('enforced', 'hint', 'conflicted', 'archived')),
      reward_sum REAL NOT NULL DEFAULT 0,
      accept_count INTEGER NOT NULL DEFAULT 0,
      reject_count INTEGER NOT NULL DEFAULT 0,
      kl_divergence REAL NOT NULL DEFAULT 0,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      conflicts_with_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      source_agent TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      file_path TEXT,
      raw_input TEXT NOT NULL,
      diff_before TEXT,
      diff_after TEXT,
      extracted_signal_json TEXT NOT NULL,
      taste1_decision_json TEXT NOT NULL,
      reward_delta REAL NOT NULL DEFAULT 0,
      learning_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rl_episodes (
      id TEXT PRIMARY KEY,
      learning_id TEXT NOT NULL REFERENCES learnings(id) ON DELETE CASCADE,
      reward REAL NOT NULL,
      baseline_prob REAL NOT NULL,
      policy_prob REAL NOT NULL,
      kl_penalty REAL NOT NULL,
      objective_score REAL NOT NULL,
      confidence_before REAL NOT NULL,
      confidence_after REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('local', 'nvidia', 'openrouter', 'custom')),
      base_url TEXT NOT NULL,
      env_var_name TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('input_extractor', 'output_writer', 'both', 'standby')),
      is_active INTEGER NOT NULL DEFAULT 0,
      last_status TEXT NOT NULL DEFAULT 'unknown',
      last_latency_ms INTEGER,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_connections (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      transport TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      call_count INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_learnings_scope_cat_status ON learnings(scope, category, status);
    CREATE INDEX IF NOT EXISTS idx_learnings_rule_key ON learnings(rule_key);
    CREATE INDEX IF NOT EXISTS idx_rl_episodes_learning ON rl_episodes(learning_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
  `);
}

function seedIfEmpty(db: DatabaseSync): void {
  const pkgCountRow = db.prepare('SELECT COUNT(*) as cnt FROM packages').get() as { cnt: number };
  if (pkgCountRow.cnt > 0) return;

  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 3600_000 * 4).toISOString();
  const yesterday = new Date(Date.now() - 86400_000).toISOString();

  // Seed settings
  const insertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('tasteLearningProject', 'true');
  insertSetting.run('tasteLearningUser', 'true');
  insertSetting.run('namespace', 'local-studio');

  // Seed packages
  const insertPkg = db.prepare(`
    INSERT INTO packages (id, name, scope, category, namespace, is_public, stars, downloads, markdown_content, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertPkg.run('pkg-project-main', 'tastecaliber-core', 'project', 'main', 'local-studio', 0, 0, 0, '', now);
  insertPkg.run('pkg-global-ts', 'typescript-strict', 'global', 'typescript', 'local-studio', 0, 0, 0, '', earlier);
  insertPkg.run('pkg-remote-node', 'node-sqlite-patterns', 'remote', 'database', 'local-studio', 1, 14, 83, '', yesterday);

  // Seed learnings (including 1 flagged contradiction so conflict resolution is immediately demonstrable)
  const insertLearning = db.prepare(`
    INSERT INTO learnings (
      id, package_id, scope, category, rule_key, rule_text, rationale, confidence, status,
      reward_sum, accept_count, reject_count, kl_divergence, evidence_count, conflicts_with_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedLearnings: Array<Omit<TasteLearning, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string }> = [
    {
      id: 'lrn-ts-unknown',
      packageId: 'pkg-project-main',
      scope: 'project',
      category: 'typescript',
      ruleKey: 'avoid-any-use-unknown',
      ruleText: 'Avoid explicit any in TypeScript; use unknown with narrow type guards or zod schemas',
      rationale: 'Preserves end-to-end static safety across MCP tool boundaries.',
      confidence: 0.91,
      status: 'enforced',
      rewardSum: 4.2,
      acceptCount: 5,
      rejectCount: 0,
      klDivergence: 0.041,
      evidenceCount: 5,
      conflictsWithId: null,
      createdAt: yesterday,
      updatedAt: now,
    },
    {
      id: 'lrn-db-prepared',
      packageId: 'pkg-project-main',
      scope: 'project',
      category: 'database',
      ruleKey: 'parameterized-sqlite-prepared',
      ruleText: 'Always use parameterized prepared SQLite statements with WAL mode enabled',
      rationale: 'Prevents SQL injection and keeps concurrent MCP reads lock-free.',
      confidence: 0.89,
      status: 'enforced',
      rewardSum: 3.4,
      acceptCount: 4,
      rejectCount: 0,
      klDivergence: 0.036,
      evidenceCount: 4,
      conflictsWithId: null,
      createdAt: yesterday,
      updatedAt: earlier,
    },
    {
      id: 'lrn-err-guard',
      packageId: 'pkg-project-main',
      scope: 'project',
      category: 'error-handling',
      ruleKey: 'early-guard-returns',
      ruleText: 'Prefer early guard returns over deeply nested conditional blocks',
      rationale: 'Improves readability and isolates error paths at the top of handlers.',
      confidence: 0.84,
      status: 'enforced',
      rewardSum: 2.6,
      acceptCount: 3,
      rejectCount: 0,
      klDivergence: 0.029,
      evidenceCount: 3,
      conflictsWithId: null,
      createdAt: yesterday,
      updatedAt: earlier,
    },
    {
      id: 'lrn-arch-named',
      packageId: 'pkg-project-main',
      scope: 'project',
      category: 'architecture',
      ruleKey: 'prefer-named-exports',
      ruleText: 'Prefer named exports over default exports in engine and service modules',
      rationale: 'Enables reliable IDE refactoring and deterministic tree-shaking.',
      confidence: 0.78,
      status: 'enforced',
      rewardSum: 1.9,
      acceptCount: 3,
      rejectCount: 1,
      klDivergence: 0.052,
      evidenceCount: 4,
      conflictsWithId: null,
      createdAt: yesterday,
      updatedAt: earlier,
    },
    {
      id: 'lrn-api-async',
      packageId: 'pkg-project-main',
      scope: 'project',
      category: 'api',
      ruleKey: 'prefer-async-await',
      ruleText: 'Prefer async/await with explicit try/catch over chained .then() promises',
      rationale: 'Keeps stack traces clear in Express and MCP transport handlers.',
      confidence: 0.86,
      status: 'enforced',
      rewardSum: 2.8,
      acceptCount: 3,
      rejectCount: 0,
      klDivergence: 0.034,
      evidenceCount: 3,
      conflictsWithId: null,
      createdAt: yesterday,
      updatedAt: earlier,
    },
    {
      id: 'lrn-fmt-semi-use',
      packageId: 'pkg-project-main',
      scope: 'project',
      category: 'formatting',
      ruleKey: 'use-semicolons',
      ruleText: 'Always use semicolons at statement boundaries across TypeScript files',
      rationale: 'Consistent ASI safety across multi-file edits.',
      confidence: 0.79,
      status: 'enforced',
      rewardSum: 1.8,
      acceptCount: 2,
      rejectCount: 0,
      klDivergence: 0.031,
      evidenceCount: 2,
      conflictsWithId: null,
      createdAt: yesterday,
      updatedAt: earlier,
    },
    {
      id: 'lrn-fmt-semi-omit',
      packageId: 'pkg-project-main',
      scope: 'project',
      category: 'formatting',
      ruleKey: 'omit-semicolons',
      ruleText: 'Omit semicolons in frontend JSX components for cleaner diffs',
      rationale: 'Observed in manual edit to JSX component return blocks.',
      confidence: 0.54,
      status: 'conflicted',
      rewardSum: 0.5,
      acceptCount: 1,
      rejectCount: 0,
      klDivergence: 0.068,
      evidenceCount: 1,
      conflictsWithId: 'lrn-fmt-semi-use',
      createdAt: earlier,
      updatedAt: now,
    },
    {
      id: 'lrn-test-node',
      packageId: 'pkg-global-ts',
      scope: 'global',
      category: 'testing',
      ruleKey: 'node-test-pure-logic',
      ruleText: 'Decouple pure business logic and verify with node:test deterministic assertions',
      rationale: 'Runs in milliseconds without browser or network dependencies.',
      confidence: 0.76,
      status: 'enforced',
      rewardSum: 2.1,
      acceptCount: 2,
      rejectCount: 0,
      klDivergence: 0.025,
      evidenceCount: 2,
      conflictsWithId: null,
      createdAt: yesterday,
      updatedAt: earlier,
    },
    {
      id: 'lrn-react-semantic',
      packageId: 'pkg-global-ts',
      scope: 'global',
      category: 'react',
      ruleKey: 'native-accessible-controls',
      ruleText: 'Use native button and label elements instead of clickable div wrappers',
      rationale: 'Maintains keyboard navigation and screen-reader accessibility.',
      confidence: 0.64,
      status: 'hint',
      rewardSum: 0.9,
      acceptCount: 1,
      rejectCount: 0,
      klDivergence: 0.019,
      evidenceCount: 1,
      conflictsWithId: null,
      createdAt: earlier,
      updatedAt: earlier,
    },
    {
      id: 'lrn-remote-wal',
      packageId: 'pkg-remote-node',
      scope: 'remote',
      category: 'database',
      ruleKey: 'sqlite-wal-pragma',
      ruleText: 'Initialize local SQLite databases with WAL journal mode and foreign_keys ON',
      rationale: 'Standard team practice for embedded local-first MCP servers.',
      confidence: 0.88,
      status: 'enforced',
      rewardSum: 3.1,
      acceptCount: 4,
      rejectCount: 0,
      klDivergence: 0.032,
      evidenceCount: 4,
      conflictsWithId: null,
      createdAt: yesterday,
      updatedAt: yesterday,
    },
  ];

  for (const l of seedLearnings) {
    insertLearning.run(
      l.id,
      l.packageId,
      l.scope,
      l.category,
      l.ruleKey,
      l.ruleText,
      l.rationale,
      l.confidence,
      l.status,
      l.rewardSum,
      l.acceptCount,
      l.rejectCount,
      l.klDivergence,
      l.evidenceCount,
      l.conflictsWithId,
      l.createdAt,
      l.updatedAt,
    );
  }

  // Seed RL Episodes
  const insertEpisode = db.prepare(`
    INSERT INTO rl_episodes (id, learning_id, reward, baseline_prob, policy_prob, kl_penalty, objective_score, confidence_before, confidence_after, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seedEpisodes = [
    ['ep-1', 'lrn-ts-unknown', 1.0, 0.58, 0.79, 0.041, 0.94, 0.72, 0.79, yesterday],
    ['ep-2', 'lrn-ts-unknown', 1.0, 0.58, 0.91, 0.044, 0.95, 0.79, 0.91, earlier],
    ['ep-3', 'lrn-db-prepared', 1.0, 0.58, 0.89, 0.036, 0.95, 0.81, 0.89, earlier],
    ['ep-4', 'lrn-arch-named', -0.5, 0.58, 0.78, 0.052, -0.57, 0.83, 0.78, earlier],
    ['ep-5', 'lrn-fmt-semi-omit', -0.25, 0.5, 0.54, 0.068, -0.36, 0.62, 0.54, now],
  ] as const;

  for (const ep of seedEpisodes) {
    insertEpisode.run(...ep);
  }

  // Seed Signals
  const insertSignal = db.prepare(`
    INSERT INTO signals (id, source_agent, signal_type, file_path, raw_input, diff_before, diff_after, extracted_signal_json, taste1_decision_json, reward_delta, learning_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertSignal.run(
    'sig-seed-1',
    'Claude Code',
    'edit',
    'server/db.ts',
    'Replace template SQL interpolation with parameterized prepared statement',
    'db.exec(`SELECT * FROM learnings WHERE id = ${id}`)',
    'db.prepare("SELECT * FROM learnings WHERE id = ?").get(id)',
    JSON.stringify({
      candidateRule: 'Always use parameterized prepared SQLite statements with WAL mode enabled',
      rationale: 'Prevents SQL injection and keeps concurrent MCP reads lock-free.',
      ruleKey: 'parameterized-sqlite-prepared',
      diffSummary: '1 line(s) replaced by 1 line(s)',
      extractorMode: 'deterministic',
      modelUsed: 'taste-structural-parser-v1',
      latencyMs: 3,
    }),
    JSON.stringify({
      isPreference: true,
      salienceScore: 0.91,
      category: 'database',
      topCategories: [
        { category: 'database', score: 0.68 },
        { category: 'security', score: 0.19 },
      ],
      ruleKey: 'parameterized-sqlite-prepared',
      polarity: 'prefer',
      initialConfidence: 0.89,
      recommendedStatus: 'enforced',
      contradictsId: null,
      contradictionReason: null,
      symbolicChecks: { validCategory: true, hasActionableRule: true, noConflictOverwrite: true },
    }),
    1.0,
    'lrn-db-prepared',
    earlier,
  );

  insertSignal.run(
    'sig-seed-2',
    'Cursor',
    'diff',
    'src/components/Header.tsx',
    'Omit semicolons in frontend JSX components for cleaner diffs',
    'return <header className="border-b" />;',
    'return <header className="border-b" />',
    JSON.stringify({
      candidateRule: 'Omit semicolons in frontend JSX components for cleaner diffs',
      rationale: 'Observed in manual edit to JSX component return blocks.',
      ruleKey: 'omit-semicolons',
      diffSummary: '1 line(s) replaced by 1 line(s)',
      extractorMode: 'deterministic',
      modelUsed: 'taste-structural-parser-v1',
      latencyMs: 2,
    }),
    JSON.stringify({
      isPreference: true,
      salienceScore: 0.78,
      category: 'formatting',
      topCategories: [
        { category: 'formatting', score: 0.74 },
        { category: 'react', score: 0.16 },
      ],
      ruleKey: 'omit-semicolons',
      polarity: 'avoid',
      initialConfidence: 0.54,
      recommendedStatus: 'conflicted',
      contradictsId: 'lrn-fmt-semi-use',
      contradictionReason: 'Symbolic conflict on "semicolons" axis with "Always use semicolons at statement boundaries across TypeScript files".',
      symbolicChecks: { validCategory: true, hasActionableRule: true, noConflictOverwrite: false },
    }),
    -0.25,
    'lrn-fmt-semi-omit',
    now,
  );

  // Seed Providers (Local Inference, Fast NVIDIA NIM defaults, OpenRouter)
  const insertProvider = db.prepare(`
    INSERT INTO providers (id, name, kind, base_url, env_var_name, model_id, role, is_active, last_status, last_latency_ms, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const hasNvidiaKey = Boolean(process.env.NVIDIA_API_KEY);

  insertProvider.run(
    'prov-nvidia-fast',
    'NVIDIA NIM Fast (Llama 3.1 8B)',
    'nvidia',
    'https://integrate.api.nvidia.com/v1',
    'NVIDIA_API_KEY',
    'meta/llama-3.1-8b-instruct',
    hasNvidiaKey ? 'input_extractor' : 'standby',
    hasNvidiaKey ? 1 : 0,
    hasNvidiaKey ? 'ready' : 'missing_key',
    null,
    null,
  );
  insertProvider.run(
    'prov-nvidia-nim',
    'NVIDIA NIM Coder (Qwen 2.5 32B)',
    'nvidia',
    'https://integrate.api.nvidia.com/v1',
    'NVIDIA_API_KEY',
    'qwen/qwen2.5-coder-32b-instruct',
    hasNvidiaKey ? 'output_writer' : 'standby',
    hasNvidiaKey ? 1 : 0,
    hasNvidiaKey ? 'ready' : 'missing_key',
    null,
    null,
  );
  insertProvider.run(
    'prov-nvidia-nemotron',
    'NVIDIA NIM Nemotron Nano 8B',
    'nvidia',
    'https://integrate.api.nvidia.com/v1',
    'NVIDIA_API_KEY',
    'nvidia/llama-3.1-nemotron-nano-8b-v1',
    'standby',
    0,
    hasNvidiaKey ? 'ready' : 'missing_key',
    null,
    null,
  );
  insertProvider.run(
    'prov-ollama-local',
    'Ollama (Local Engine)',
    'local',
    process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1',
    '',
    process.env.LOCAL_LLM_MODEL || 'qwen2.5-coder:7b',
    hasNvidiaKey ? 'standby' : 'both',
    hasNvidiaKey ? 0 : 1,
    'unknown',
    null,
    null,
  );
  insertProvider.run(
    'prov-lmstudio-local',
    'LM Studio (Local Engine)',
    'local',
    'http://localhost:1234/v1',
    '',
    'qwen2.5-coder-7b-instruct',
    'standby',
    0,
    'unknown',
    null,
    null,
  );
  insertProvider.run(
    'prov-openrouter-free',
    'OpenRouter (Free Models)',
    'openrouter',
    'https://openrouter.ai/api/v1',
    'OPENROUTER_API_KEY',
    'qwen/qwen-2.5-coder-32b-instruct:free',
    'standby',
    0,
    process.env.OPENROUTER_API_KEY ? 'ready' : 'missing_key',
    null,
    null,
  );

  // Seed agent connections
  const insertAgent = db.prepare(`
    INSERT INTO agent_connections (id, agent_name, transport, last_seen_at, call_count)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertAgent.run('agent-claude', 'Claude Code', 'stdio', now, 12);
  insertAgent.run('agent-cursor', 'Cursor IDE', 'http', earlier, 7);

  // Compile initial markdown & sync disk
  syncAllPackageMarkdown(db);
}

export function syncAllPackageMarkdown(db: DatabaseSync): string[] {
  const packages = db.prepare('SELECT * FROM packages').all() as Array<{
    id: string;
    name: string;
    scope: TasteScope;
    category: string;
  }>;

  const syncedFiles: string[] = [];
  const updatePkgMd = db.prepare('UPDATE packages SET markdown_content = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();

  for (const pkg of packages) {
    const learnings = listLearnings(db, { packageId: pkg.id });
    const md = compileTasteMarkdown({
      title: pkg.name,
      scope: pkg.scope,
      learnings,
    });
    updatePkgMd.run(md, now, pkg.id);

    // Write local .tastecaliber/taste files for project scope
    if (pkg.scope === 'project') {
      const baseDir = path.resolve(process.cwd(), '.tastecaliber', 'taste');
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }
      const mainFile = path.join(baseDir, 'taste.md');
      fs.writeFileSync(mainFile, md, 'utf8');
      syncedFiles.push('.tastecaliber/taste/taste.md');

      // Also write category-specific files
      const byCategory = new Map<TasteCategory, TasteLearning[]>();
      for (const l of learnings) {
        if (l.status === 'archived') continue;
        const arr = byCategory.get(l.category) ?? [];
        arr.push(l);
        byCategory.set(l.category, arr);
      }
      for (const [cat, items] of byCategory.entries()) {
        const catDir = path.join(baseDir, cat);
        if (!fs.existsSync(catDir)) {
          fs.mkdirSync(catDir, { recursive: true });
        }
        const catMd = compileTasteMarkdown({
          title: `${pkg.name} / ${cat}`,
          scope: pkg.scope,
          learnings: items,
        });
        const catFile = path.join(catDir, 'taste.md');
        fs.writeFileSync(catFile, catMd, 'utf8');
        syncedFiles.push(`.tastecaliber/taste/${cat}/taste.md`);
      }
    }
  }

  return syncedFiles;
}

export function listLearnings(
  db: DatabaseSync,
  filters?: {
    scope?: TasteScope | 'all';
    category?: string;
    status?: string;
    packageId?: string;
    minConfidence?: number;
    search?: string;
  },
): TasteLearning[] {
  let sql = 'SELECT * FROM learnings WHERE 1=1';
  const params: Array<string | number> = [];

  if (filters?.packageId) {
    sql += ' AND package_id = ?';
    params.push(filters.packageId);
  }
  if (filters?.scope && filters.scope !== 'all') {
    sql += ' AND scope = ?';
    params.push(filters.scope);
  }
  if (filters?.category && filters.category !== 'all') {
    sql += ' AND category = ?';
    params.push(filters.category);
  }
  if (filters?.status && filters.status !== 'all') {
    sql += ' AND status = ?';
    params.push(filters.status);
  }
  if (typeof filters?.minConfidence === 'number') {
    sql += ' AND confidence >= ?';
    params.push(filters.minConfidence);
  }
  if (filters?.search && filters.search.trim()) {
    sql += ' AND (LOWER(rule_text) LIKE ? OR LOWER(rationale) LIKE ? OR LOWER(category) LIKE ?)';
    const q = `%${filters.search.trim().toLowerCase()}%`;
    params.push(q, q, q);
  }

  sql += ' ORDER BY confidence DESC, updated_at DESC';

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapLearningRow);
}

export function getLearningById(db: DatabaseSync, id: string): TasteLearning | null {
  const row = db.prepare('SELECT * FROM learnings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapLearningRow(row) : null;
}

function mapLearningRow(r: Record<string, unknown>): TasteLearning {
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

export function listPackages(db: DatabaseSync): TastePackage[] {
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM learnings l WHERE l.package_id = p.id AND l.status != 'archived') as learning_count
       FROM packages p
       ORDER BY CASE p.scope WHEN 'project' THEN 1 WHEN 'global' THEN 2 ELSE 3 END, p.updated_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    scope: r.scope as TasteScope,
    category: String(r.category),
    namespace: String(r.namespace),
    isPublic: Boolean(r.is_public),
    stars: Number(r.stars),
    downloads: Number(r.downloads),
    markdownContent: String(r.markdown_content),
    learningCount: Number(r.learning_count ?? 0),
    updatedAt: String(r.updated_at),
  }));
}

export function listSignals(db: DatabaseSync, limit = 25): TasteSignalRecord[] {
  const rows = db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?').all(limit) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: String(r.id),
    sourceAgent: String(r.source_agent),
    signalType: r.signal_type as TasteSignalRecord['signalType'],
    filePath: r.file_path ? String(r.file_path) : null,
    rawInput: String(r.raw_input),
    diffBefore: r.diff_before ? String(r.diff_before) : null,
    diffAfter: r.diff_after ? String(r.diff_after) : null,
    extractedSignal: JSON.parse(String(r.extracted_signal_json)),
    taste1Decision: JSON.parse(String(r.taste1_decision_json)),
    rewardDelta: Number(r.reward_delta),
    learningId: r.learning_id ? String(r.learning_id) : null,
    createdAt: String(r.created_at),
  }));
}

export function listRlEpisodes(db: DatabaseSync, limit = 40): RlEpisode[] {
  const rows = db.prepare('SELECT * FROM rl_episodes ORDER BY created_at DESC LIMIT ?').all(limit) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: String(r.id),
    learningId: String(r.learning_id),
    reward: Number(r.reward),
    baselineProb: Number(r.baseline_prob),
    policyProb: Number(r.policy_prob),
    klPenalty: Number(r.kl_penalty),
    objectiveScore: Number(r.objective_score),
    confidenceBefore: Number(r.confidence_before),
    confidenceAfter: Number(r.confidence_after),
    createdAt: String(r.created_at),
  }));
}

export function listProviders(db: DatabaseSync): ProviderConfig[] {
  const rows = db.prepare('SELECT * FROM providers ORDER BY is_active DESC, name ASC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => {
    const envVar = String(r.env_var_name || '');
    const kind = r.kind as ProviderKind;
    const hasKeyConfigured = kind === 'local' ? true : Boolean(envVar && process.env[envVar]);
    return {
      id: String(r.id),
      name: String(r.name),
      kind,
      baseUrl: String(r.base_url),
      envVarName: envVar,
      modelId: String(r.model_id),
      role: r.role as ProviderRole,
      isActive: Boolean(r.is_active),
      hasKeyConfigured,
      lastStatus: (r.last_status as ProviderConfig['lastStatus']) || 'unknown',
      lastLatencyMs: r.last_latency_ms !== null && r.last_latency_ms !== undefined ? Number(r.last_latency_ms) : null,
      lastError: r.last_error ? String(r.last_error) : null,
    };
  });
}

export function getSettings(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.key] = r.value;
  }
  return out;
}

export function lintAllPackages(db: DatabaseSync): LintFileResult[] {
  const packages = listPackages(db);
  return packages.map((pkg) => {
    const fileLabel =
      pkg.scope === 'project'
        ? '.tastecaliber/taste/taste.md'
        : pkg.scope === 'global'
          ? `~/.tastecaliber/taste/${pkg.category}/taste.md`
          : `remote/${pkg.namespace}/${pkg.name}/taste.md`;
    return lintTasteMarkdown(fileLabel, pkg.markdownContent);
  });
}

export function recordAgentTouch(db: DatabaseSync, agentName: string, transport: 'http' | 'stdio'): void {
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT id, call_count FROM agent_connections WHERE LOWER(agent_name) = LOWER(?) AND transport = ?')
    .get(agentName, transport) as { id: string; call_count: number } | undefined;

  if (existing) {
    db.prepare('UPDATE agent_connections SET last_seen_at = ?, call_count = ? WHERE id = ?').run(
      now,
      existing.call_count + 1,
      existing.id,
    );
  } else {
    db.prepare('INSERT INTO agent_connections (id, agent_name, transport, last_seen_at, call_count) VALUES (?, ?, ?, ?, 1)').run(
      `agent-${Date.now()}`,
      agentName,
      transport,
      now,
    );
  }
}
