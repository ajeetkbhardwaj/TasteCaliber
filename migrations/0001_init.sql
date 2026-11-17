-- TasteCaliber Canonical SQLite / Cloudflare D1 Schema
-- Apply locally or via: wrangler d1 execute tastecaliber-db --file=./migrations/0001_init.sql

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

CREATE TABLE IF NOT EXISTS micro_skills (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'global', 'remote')),
  category TEXT NOT NULL CHECK (category IN ('test', 'build', 'lint', 'env', 'db', 'deploy', 'pattern')),
  trigger_pattern TEXT NOT NULL,
  fact_text TEXT NOT NULL,
  corroborations INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'verified', 'retired')),
  estimated_tokens_saved INTEGER NOT NULL DEFAULT 220,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS economics_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('context_pruned', 'micro_skill_hit', 'loop_prevented', 'tool_pruned')),
  agent_name TEXT NOT NULL,
  file_path TEXT,
  baseline_tokens INTEGER NOT NULL DEFAULT 0,
  injected_tokens INTEGER NOT NULL DEFAULT 0,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_usage (
  tool_name TEXT PRIMARY KEY,
  call_count INTEGER NOT NULL DEFAULT 0,
  avg_response_tokens INTEGER NOT NULL DEFAULT 0,
  last_called_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_learnings_scope_cat_status ON learnings(scope, category, status);
CREATE INDEX IF NOT EXISTS idx_learnings_rule_key ON learnings(rule_key);
CREATE INDEX IF NOT EXISTS idx_rl_episodes_learning ON rl_episodes(learning_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_micro_skills_status ON micro_skills(status, corroborations DESC);
CREATE INDEX IF NOT EXISTS idx_economics_created ON economics_events(created_at DESC);

INSERT OR IGNORE INTO packages (id, name, scope, category, namespace, is_public, stars, downloads, markdown_content, updated_at)
VALUES ('pkg-project-main', 'tastecaliber-core', 'project', 'main', 'edge', 0, 0, 0, '# Taste Profile: tastecaliber-core', '2026-11-17T00:00:00Z');
