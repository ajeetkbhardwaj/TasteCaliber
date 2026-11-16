import {
  CategoryScore,
  ExtractedSignal,
  LearningStatus,
  LintFileResult,
  LintIssue,
  SignalType,
  TASTE_CATEGORIES,
  Taste1Decision,
  TasteCategory,
  TasteLearning,
  TasteScope,
} from './types';

export const META_RL_CONFIG = {
  betaNS: 0.18, // KL-divergence regularization against SFT baseline
  gammaNS: 0.08, // Pretrain retention weight
  enforcedThreshold: 0.72,
  hintThreshold: 0.4,
  noiseThreshold: 0.32,
  learningRate: 0.22,
} as const;

interface CategoryLexicon {
  category: TasteCategory;
  keywords: string[];
  structuralPatterns: RegExp[];
}

const CATEGORY_LEXICONS: CategoryLexicon[] = [
  {
    category: 'typescript',
    keywords: [
      'typescript',
      'type',
      'interface',
      'zod',
      'unknown',
      'any',
      'enum',
      'generic',
      'strict',
      'readonly',
      'const',
      'as const',
      'inference',
      'import type',
    ],
    structuralPatterns: [/\binterface\s+\w+/, /\btype\s+\w+\s*=/, /:\s*(unknown|never|readonly)\b/, /\bas\s+const\b/],
  },
  {
    category: 'error-handling',
    keywords: [
      'try',
      'catch',
      'throw',
      'error',
      'result',
      'fallback',
      'guard',
      'early return',
      'finally',
      'reject',
      'exception',
      'status',
    ],
    structuralPatterns: [/\btry\s*\{/, /\bcatch\s*\(/, /if\s*\([^)]+\)\s*return\b/, /new\s+Error\(/],
  },
  {
    category: 'architecture',
    keywords: [
      'module',
      'decouple',
      'layer',
      'service',
      'pure',
      'dependency',
      'injection',
      'barrel',
      'monorepo',
      'separation',
      'helper',
      'domain',
      'named export',
      'default export',
    ],
    structuralPatterns: [/\bexport\s+(function|const|class)\b/, /\bexport\s+default\b/],
  },
  {
    category: 'react',
    keywords: [
      'react',
      'hook',
      'useeffect',
      'usestate',
      'usememo',
      'component',
      'jsx',
      'tsx',
      'props',
      'tailwind',
      'aria',
      'accessible',
      'state',
    ],
    structuralPatterns: [/\buse[A-Z]\w+\(/, /<[A-Z]\w+/, /\bclassName=/],
  },
  {
    category: 'database',
    keywords: [
      'sqlite',
      'sql',
      'query',
      'prepared',
      'transaction',
      'wal',
      'migration',
      'index',
      'schema',
      'foreign key',
      'parameterized',
      'database',
    ],
    structuralPatterns: [/\bSELECT\b/i, /\bINSERT\b/i, /\bCREATE\s+TABLE\b/i, /\.prepare\(/],
  },
  {
    category: 'cli',
    keywords: [
      'cli',
      'command',
      'flag',
      'stdio',
      'stdin',
      'stdout',
      'stderr',
      'exit',
      'argv',
      'terminal',
      'npx',
      'bin',
    ],
    structuralPatterns: [/process\.(argv|exit|stdout|stderr)/],
  },
  {
    category: 'testing',
    keywords: [
      'test',
      'assert',
      'node:test',
      'vitest',
      'unit',
      'fixture',
      'deterministic',
      'mock',
      'coverage',
      'spec',
    ],
    structuralPatterns: [/\bassert\./, /\btest\(/, /\bdescribe\(/, /\bit\(/],
  },
  {
    category: 'security',
    keywords: [
      'auth',
      'token',
      'secret',
      'env',
      'sanitize',
      'escape',
      'cors',
      'bearer',
      'hash',
      'validate',
      'injection',
      'xss',
    ],
    structuralPatterns: [/process\.env\./, /\bBearer\b/],
  },
  {
    category: 'api',
    keywords: [
      'express',
      'route',
      'endpoint',
      'json',
      'mcp',
      'rpc',
      'http',
      'rest',
      'fetch',
      'response',
      'request',
      'status',
      'async',
      'await',
    ],
    structuralPatterns: [/\bapp\.(get|post|put|delete)\(/, /\basync\s+/, /\bawait\s+/],
  },
  {
    category: 'formatting',
    keywords: [
      'semicolon',
      'quote',
      'single quote',
      'double quote',
      'indent',
      'tab',
      'space',
      'trailing comma',
      'naming',
      'camelcase',
      'kebab',
      'snake',
    ],
    structuralPatterns: [/;\s*$/m, /['"`]/],
  },
  {
    category: 'performance',
    keywords: [
      'cache',
      'memo',
      'batch',
      'stream',
      'index',
      'pool',
      'debounce',
      'throttle',
      'latency',
      'complexity',
    ],
    structuralPatterns: [/\bnew\s+Map\(/, /\bnew\s+Set\(/],
  },
];

// Symbolic antonym / contradiction pairs for deterministic conflict detection
interface ConflictAxis {
  axis: string;
  sideA: RegExp;
  sideB: RegExp;
}

const CONFLICT_AXES: ConflictAxis[] = [
  {
    axis: 'semicolons',
    sideA: /\b(use|require|enforce|keep|include|add)\b.*\bsemicolon/i,
    sideB: /\b(omit|no|avoid|remove|drop|never)\b.*\bsemicolon/i,
  },
  {
    axis: 'indentation',
    sideA: /\b(use|prefer)\b.*\btabs?\b/i,
    sideB: /\b(use|prefer)\b.*\bspaces?\b/i,
  },
  {
    axis: 'exports',
    sideA: /\b(prefer|use|enforce)\b.*\bnamed\s+exports?\b/i,
    sideB: /\b(prefer|use|enforce)\b.*\bdefault\s+exports?\b/i,
  },
  {
    axis: 'async-style',
    sideA: /\b(prefer|use|enforce)\b.*\basync\s*\/?\s*await\b/i,
    sideB: /\b(prefer|use)\b.*\b(\.then\(|promise\s+chains?|callbacks?)\b/i,
  },
  {
    axis: 'error-style',
    sideA: /\b(throw|use\s+exceptions|try\/catch)\b/i,
    sideB: /\b(never\s+throw|return\s+result\s+tuples?|avoid\s+try\/catch)\b/i,
  },
  {
    axis: 'quotes',
    sideA: /\b(single\s+quotes?)\b/i,
    sideB: /\b(double\s+quotes?)\b/i,
  },
  {
    axis: 'type-strictness',
    sideA: /\b(avoid|forbid|ban|no)\b.*\bany\b/i,
    sideB: /\b(allow|use)\b.*\bany\b/i,
  },
  {
    axis: 'null-handling',
    sideA: /\b(prefer|use)\b.*\bundefined\b/i,
    sideB: /\b(prefer|use)\b.*\bnull\b/i,
  },
];

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function round4(val: number): number {
  return Math.round(val * 10000) / 10000;
}

export function normalizeRuleKey(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into'].includes(w))
    .slice(0, 6)
    .join('-');
  return cleaned || 'general-preference';
}

const SIMILARITY_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'over', 'instead',
  'across', 'code', 'files', 'use', 'prefer', 'always', 'keep', 'make', 'sure',
]);

function tokenizeForSimilarity(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !SIMILARITY_STOP_WORDS.has(w));
  return new Set(words);
}

/**
 * Computes Sorensen-Dice lexical similarity [0, 1] between two rule statements
 * so paraphrases and concise/expanded variants merge cleanly without false positives.
 */
export function computeRuleSimilarity(ruleA: string, ruleB: string): number {
  const setA = tokenizeForSimilarity(ruleA);
  const setB = tokenizeForSimilarity(ruleB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const denom = setA.size + setB.size;
  return denom === 0 ? 0 : round4((2 * intersection) / denom);
}

export function findSimilarLearning(params: {
  candidateRule: string;
  ruleKey: string;
  category: TasteCategory;
  scope: TasteScope;
  existingLearnings: TasteLearning[];
  contradictsId: string | null;
}): TasteLearning | null {
  if (params.contradictsId) return null;
  const candidates = params.existingLearnings.filter(
    (l) => l.scope === params.scope && l.status !== 'archived',
  );

  // 1. Exact ruleKey match
  const exact = candidates.find((l) => l.ruleKey === params.ruleKey);
  if (exact) return exact;

  // 2. Semantic token overlap >= 0.58 within the same category
  let bestMatch: TasteLearning | null = null;
  let bestScore = 0;
  for (const l of candidates) {
    if (l.category !== params.category) continue;
    const sim = computeRuleSimilarity(params.candidateRule, l.ruleText);
    if (sim >= 0.58 && sim > bestScore) {
      bestScore = sim;
      bestMatch = l;
    }
  }
  return bestMatch;
}

/**
 * Deterministic fallback signal extractor when no external LLM is connected (or offline mode).
 * Analyzes raw text + before/after diffs to produce structured Step 1 signals.
 */
export function deterministicExtractSignal(input: {
  rawInput: string;
  diffBefore?: string | null;
  diffAfter?: string | null;
  filePath?: string | null;
  signalType: SignalType;
}): ExtractedSignal {
  const started = Date.now();
  const raw = input.rawInput.trim();
  const before = (input.diffBefore ?? '').trim();
  const after = (input.diffAfter ?? '').trim();
  const filePath = input.filePath?.trim() || '';

  let candidateRule = raw;
  let rationale = `Observed ${input.signalType} signal${filePath ? ` in ${filePath}` : ''}.`;
  let diffSummary = 'No code diff attached.';

  if (before || after) {
    const changes: string[] = [];
    if (/\bvar\b/.test(before) && /\b(const|let)\b/.test(after)) {
      changes.push('Prefer immutable const/let bindings over var');
    }
    if (/\.then\s*\(/.test(before) && /\basync\b|\bawait\b/.test(after)) {
      changes.push('Prefer async/await over chained .then() callbacks');
    }
    if (!/\btry\s*\{/.test(before) && /\btry\s*\{/.test(after)) {
      changes.push('Wrap fallible async operations in explicit try/catch error handling');
    }
    if (/:\s*any\b/.test(before) && /:\s*(unknown|[A-Z]\w+)/.test(after)) {
      changes.push('Use explicit interfaces or unknown instead of any in TypeScript');
    }
    if (/\bexport\s+default\b/.test(before) && /\bexport\s+(const|function)\b/.test(after)) {
      changes.push('Prefer named exports over default exports for module clarity');
    }
    if (/\bconsole\.log\b/.test(before) && !/\bconsole\.log\b/.test(after)) {
      changes.push('Avoid leaving console.log statements in production code');
    }
    if (/`SELECT\s+.*\$\{/.test(before) && /\.prepare\(/.test(after)) {
      changes.push('Use parameterized prepared SQLite statements instead of string interpolation');
    }
    if (!/if\s*\([^)]+\)\s*return\b/.test(before) && /if\s*\([^)]+\)\s*return\b/.test(after)) {
      changes.push('Prefer early guard returns over deeply nested conditional blocks');
    }

    diffSummary = `${before.split('\n').length} line(s) replaced by ${after.split('\n').length} line(s)`;

    if (changes.length > 0 && (!raw || raw.length < 18)) {
      candidateRule = changes[0];
      rationale = `Extracted from diff transformation (${diffSummary}): ${changes.join('; ')}.`;
    } else if (!raw) {
      candidateRule = changes[0] || `Apply structural pattern observed in ${filePath || 'code edit'}`;
      rationale = `Derived directly from before/after code diff (${diffSummary}).`;
    } else {
      rationale = `${raw} (${diffSummary})`;
    }
  }

  return {
    candidateRule: candidateRule.slice(0, 220),
    rationale: rationale.slice(0, 320),
    ruleKey: normalizeRuleKey(candidateRule),
    diffSummary,
    extractorMode: 'deterministic',
    modelUsed: 'taste-structural-parser-v1',
    latencyMs: Math.max(1, Date.now() - started),
  };
}

/**
 * Step 2: taste-1 Meta Neuro-Symbolic Classifier
 * Does NOT generate text. Evaluates structured signals deterministically:
 *  - Neural intuition layer: lexical + structural pattern affinity across categories
 *  - Symbolic rule layer: fixed category enforcement, noise gating, contradiction detection
 */
export function classifyWithTaste1(params: {
  extracted: ExtractedSignal;
  signalType: SignalType;
  filePath?: string | null;
  diffBefore?: string | null;
  diffAfter?: string | null;
  existingLearnings: TasteLearning[];
}): Taste1Decision {
  const { extracted, signalType, filePath, diffBefore, diffAfter, existingLearnings } = params;
  const corpus = [
    extracted.candidateRule,
    extracted.rationale,
    filePath ?? '',
    diffBefore ?? '',
    diffAfter ?? '',
  ]
    .join(' ')
    .toLowerCase();

  // 1. Neural Salience Scoring (detect noise vs actionable coding preference)
  const preferenceMarkers = [
    /\b(prefer|always|never|avoid|use|enforce|keep|require|must|should|omit|split|parameterized|explicit|strict|named|early)\b/i,
    /\b(instead of|rather than|over|without)\b/i,
  ];
  const noiseMarkers = [
    /^(hi|hello|hey|ok|thanks|thank you|looks good|lgtm|test|ping|what time|how are you)\W*$/i,
    /\b(weather|lunch|meeting|joke|unrelated)\b/i,
  ];

  let salience = 0.28;
  for (const rx of preferenceMarkers) {
    if (rx.test(extracted.candidateRule) || rx.test(extracted.rationale)) {
      salience += 0.24;
    }
  }
  if (diffBefore && diffAfter && diffBefore.trim() !== diffAfter.trim()) {
    salience += 0.22;
  }
  if (signalType === 'reject' || signalType === 'edit' || signalType === 'diff') {
    salience += 0.14;
  }
  if (extracted.candidateRule.trim().length >= 16) {
    salience += 0.08;
  }
  for (const rx of noiseMarkers) {
    if (rx.test(extracted.candidateRule.trim())) {
      salience -= 0.45;
    }
  }
  salience = round4(clamp(salience, 0.05, 0.96));

  // 2. Category Classification over Fixed Symbolic Taxonomy
  const rawScores: CategoryScore[] = CATEGORY_LEXICONS.map((lex) => {
    let score = 0.05;
    for (const kw of lex.keywords) {
      if (corpus.includes(kw)) {
        score += kw.includes(' ') ? 0.26 : 0.18;
      }
    }
    for (const pat of lex.structuralPatterns) {
      if (pat.test(diffAfter ?? '') || pat.test(diffBefore ?? '') || pat.test(extracted.candidateRule)) {
        score += 0.22;
      }
    }
    if (filePath) {
      if (lex.category === 'react' && /\.(tsx|jsx)$/i.test(filePath)) score += 0.25;
      if (lex.category === 'typescript' && /\.(ts|tsx)$/i.test(filePath)) score += 0.18;
      if (lex.category === 'testing' && /\.(test|spec)\./i.test(filePath)) score += 0.32;
      if (lex.category === 'database' && /(db|sqlite|sql|schema|migration)/i.test(filePath)) score += 0.28;
      if (lex.category === 'cli' && /(cli|bin|stdio|cmd)/i.test(filePath)) score += 0.28;
      if (lex.category === 'api' && /(server|api|route|mcp)/i.test(filePath)) score += 0.22;
    }
    return { category: lex.category, score };
  });

  const totalScore = rawScores.reduce((acc, item) => acc + item.score, 0) || 1;
  const topCategories = rawScores
    .map((item) => ({
      category: item.category,
      score: round4(item.score / totalScore),
    }))
    .sort((a, b) => b.score - a.score || a.category.localeCompare(b.category))
    .slice(0, 4);

  const chosenCategory = topCategories[0].category;
  const isPreference = salience >= META_RL_CONFIG.noiseThreshold && extracted.candidateRule.trim().length >= 8;

  // Polarity detection
  const polarity: 'prefer' | 'avoid' =
    /\b(avoid|never|do not|don't|ban|forbid|omit|no\s+\w+)\b/i.test(extracted.candidateRule) ||
    signalType === 'reject'
      ? 'avoid'
      : 'prefer';

  // 3. Symbolic Contradiction Detection
  let contradictsId: string | null = null;
  let contradictionReason: string | null = null;

  if (isPreference) {
    const activeCandidates = existingLearnings.filter(
      (l) => l.status !== 'archived' && (l.category === chosenCategory || l.scope === 'project'),
    );

    for (const existing of activeCandidates) {
      // Exact rule key conflict with opposite polarity
      if (existing.ruleKey === extracted.ruleKey && existing.ruleText.toLowerCase() !== extracted.candidateRule.toLowerCase()) {
        const existingAvoid = /\b(avoid|never|do not|omit|no)\b/i.test(existing.ruleText);
        const newAvoid = polarity === 'avoid';
        if (existingAvoid !== newAvoid) {
          contradictsId = existing.id;
          contradictionReason = `Opposite polarity on rule key "${existing.ruleKey}" against existing learning (${existing.confidence.toFixed(2)} confidence).`;
          break;
        }
      }

      // Axis-based symbolic contradiction check (strip "over X / instead of X" comparisons so "Prefer A over B" only asserts A)
      const stripComparison = (text: string) =>
        text.replace(/\b(over|instead\s+of|rather\s+than|versus|vs\.?)\b[^.;,]*/gi, '');
      const existingPrimary = stripComparison(existing.ruleText);
      const newPrimary = stripComparison(extracted.candidateRule);

      for (const axis of CONFLICT_AXES) {
        const exA = axis.sideA.test(existingPrimary);
        const exB = axis.sideB.test(existingPrimary);
        const nwA = axis.sideA.test(newPrimary);
        const nwB = axis.sideB.test(newPrimary);

        const existingA = exA && !exB;
        const existingB = exB && !exA;
        const newA = nwA && !nwB;
        const newB = nwB && !nwA;

        if ((existingA && newB) || (existingB && newA)) {
          contradictsId = existing.id;
          contradictionReason = `Symbolic conflict on "${axis.axis}" axis with "${existing.ruleText}".`;
          break;
        }
      }
      if (contradictsId) break;
    }
  }

  // Calibrated initial confidence
  const signalBase =
    signalType === 'accept'
      ? 0.62
      : signalType === 'edit' || signalType === 'diff'
        ? 0.68
        : signalType === 'reject'
          ? 0.58
          : 0.48;

  const initialConfidence = isPreference
    ? round4(clamp(signalBase * 0.6 + salience * 0.4 - (contradictsId ? 0.14 : 0), 0.15, 0.88))
    : round4(clamp(salience * 0.5, 0.05, 0.31));

  let recommendedStatus: LearningStatus = 'hint';
  if (!isPreference) {
    recommendedStatus = 'archived';
  } else if (contradictsId) {
    recommendedStatus = 'conflicted';
  } else if (initialConfidence >= META_RL_CONFIG.enforcedThreshold) {
    recommendedStatus = 'enforced';
  } else if (initialConfidence >= META_RL_CONFIG.hintThreshold) {
    recommendedStatus = 'hint';
  } else {
    recommendedStatus = 'archived';
  }

  return {
    isPreference,
    salienceScore: salience,
    category: chosenCategory,
    topCategories,
    ruleKey: extracted.ruleKey,
    polarity,
    initialConfidence,
    recommendedStatus,
    contradictsId,
    contradictionReason,
    symbolicChecks: {
      validCategory: TASTE_CATEGORIES.includes(chosenCategory),
      hasActionableRule: extracted.candidateRule.trim().length >= 8,
      noConflictOverwrite: contradictsId === null,
    },
  };
}

/**
 * Meta-NeuroSymbolic RL Policy Update:
 * Objective(phi) = E[ RM_NS(x,y) - beta_NS * log(pi_phi(y|x) / pi_SFT(y|x)) ] + gamma_NS * E[ log pi_phi(x) ]
 */
export function updateMetaRL(params: {
  confidenceBefore: number;
  reward: number;
  evidenceCount: number;
  hasConflict: boolean;
}): {
  baselineProb: number;
  policyProb: number;
  klPenalty: number;
  objectiveScore: number;
  confidenceAfter: number;
  statusAfter: LearningStatus;
} {
  const { confidenceBefore, reward, evidenceCount, hasConflict } = params;
  const baselineProb = clamp(0.5 + (evidenceCount > 1 ? 0.08 : 0), 0.1, 0.9);
  const currentProb = clamp(confidenceBefore, 0.05, 0.99);

  // KL term: log(pi_phi / pi_SFT) weighted by beta_NS
  const logRatio = Math.log(currentProb / baselineProb);
  const klPenalty = round4(META_RL_CONFIG.betaNS * Math.abs(logRatio));

  // Pretrain retention term: gamma_NS * log(pi_phi)
  const retentionTerm = META_RL_CONFIG.gammaNS * Math.log(currentProb);

  // Effective objective score
  const objectiveScore = round4(reward - klPenalty + retentionTerm);

  // Dampened step size as evidence accumulates so established taste stabilizes
  const adaptiveLr = META_RL_CONFIG.learningRate / Math.sqrt(Math.max(1, evidenceCount));
  const rawDelta = adaptiveLr * (reward - META_RL_CONFIG.betaNS * logRatio);
  const confidenceAfter = round4(clamp(currentProb + rawDelta, 0.05, 0.99));
  const policyProb = confidenceAfter;

  let statusAfter: LearningStatus;
  if (hasConflict) {
    statusAfter = 'conflicted';
  } else if (confidenceAfter >= META_RL_CONFIG.enforcedThreshold) {
    statusAfter = 'enforced';
  } else if (confidenceAfter >= META_RL_CONFIG.hintThreshold) {
    statusAfter = 'hint';
  } else {
    statusAfter = 'archived';
  }

  return {
    baselineProb: round4(baselineProb),
    policyProb,
    klPenalty,
    objectiveScore,
    confidenceAfter,
    statusAfter,
  };
}

/**
 * Step 3: Compile learnings into standard .tastecaliber/taste/<category>/taste.md format
 */
export function compileTasteMarkdown(params: {
  title: string;
  scope: TasteScope;
  learnings: TasteLearning[];
}): string {
  const { title, scope, learnings } = params;
  const active = learnings
    .filter((l) => l.status !== 'archived')
    .sort((a, b) => b.confidence - a.confidence || a.category.localeCompare(b.category));

  const lines: string[] = [
    `# Taste Profile: ${title}`,
    ``,
    `> Scope: ${scope}`,
    `> Engine: taste-1 (Meta Neuro-Symbolic)`,
    `> Learnings: ${active.length}`,
    ``,
  ];

  const grouped = new Map<TasteCategory, TasteLearning[]>();
  for (const item of active) {
    const list = grouped.get(item.category) ?? [];
    list.push(item);
    grouped.set(item.category, list);
  }

  if (grouped.size === 0) {
    lines.push('## General', '', '_No active taste learnings recorded yet._', '');
    return lines.join('\n');
  }

  for (const [category, items] of grouped.entries()) {
    lines.push(`## ${category}`, '');
    for (const item of items) {
      const tag =
        item.status === 'enforced'
          ? 'enforced'
          : item.status === 'conflicted'
            ? 'conflicted'
            : 'hint';
      lines.push(
        `- [confidence: ${item.confidence.toFixed(2)}] [${tag}] ${item.ruleText}`,
      );
      if (item.rationale) {
        lines.push(`  - Rationale: ${item.rationale}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * `npx taste lint` equivalent: validates markdown hierarchy, headers, UTF-8, and [0, 1] confidence bounds.
 */
export function lintTasteMarkdown(file: string, content: string): LintFileResult {
  const issues: LintIssue[] = [];
  const lines = content.split(/\r?\n/);

  if (!content.trim()) {
    issues.push({
      file,
      line: 1,
      severity: 'error',
      message: 'Taste file is empty',
    });
  }

  const hasH1 = lines.some((l) => /^#\s+.+/.test(l));
  if (!hasH1) {
    issues.push({
      file,
      line: 1,
      severity: 'error',
      message: 'Missing required top-level # Taste Profile header',
    });
  }

  const hasScopeHeader = lines.some((l) => /^>\s*Scope:\s*(project|global|remote)/i.test(l));
  if (!hasScopeHeader) {
    issues.push({
      file,
      line: 2,
      severity: 'warning',
      message: 'Missing > Scope metadata header (project | global | remote)',
    });
  }

  let hasSectionH2 = false;
  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    if (/^##\s+(.+)/.test(line)) {
      hasSectionH2 = true;
      const cat = line.replace(/^##\s+/, '').trim().toLowerCase();
      if (cat !== 'general' && !TASTE_CATEGORIES.includes(cat as TasteCategory)) {
        issues.push({
          file,
          line: lineNum,
          severity: 'warning',
          message: `Non-canonical category "${cat}" outside taste-1 symbolic taxonomy`,
        });
      }
    }

    const confMatch = line.match(/\[confidence:\s*([^\]]+)\]/i);
    if (confMatch) {
      const val = Number(confMatch[1]);
      if (Number.isNaN(val) || val < 0 || val > 1) {
        issues.push({
          file,
          line: lineNum,
          severity: 'error',
          message: `Invalid confidence value "${confMatch[1]}" (must be between 0 and 1)`,
        });
      }
    } else if (/^-\s+/.test(line) && !/^\s+-\s+Rationale:/i.test(line)) {
      issues.push({
        file,
        line: lineNum,
        severity: 'warning',
        message: 'Learning bullet missing [confidence: 0.xx] calibration tag',
      });
    }

    if (line.includes('\uFFFD')) {
      issues.push({
        file,
        line: lineNum,
        severity: 'error',
        message: 'Invalid UTF-8 replacement character detected',
      });
    }
  });

  if (!hasSectionH2) {
    issues.push({
      file,
      line: lines.length,
      severity: 'error',
      message: 'Missing required ## category section header',
    });
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

  return {
    file,
    valid: errors === 0,
    errors,
    warnings,
    issues,
  };
}
