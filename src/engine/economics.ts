import type {
  ContextBudgetResult,
  LoopGuardResult,
  MicroSkill,
  SignalType,
  TasteCategory,
  TasteLearning,
  TasteScope,
  TasteSignalRecord,
  ToolUsageStat,
  UnusedToolRecommendation,
} from './types.ts';

export const MCP_SCHEMA_TOKENS_PER_TOOL = 165;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function inferCategoriesFromFilePath(filePath?: string | null): TasteCategory[] {
  if (!filePath) return [];
  const p = filePath.toLowerCase();
  const matched = new Set<TasteCategory>();

  if (/\.(tsx|jsx)$/.test(p) || p.includes('/components/') || p.includes('ui')) {
    matched.add('react');
    matched.add('formatting');
    matched.add('typescript');
  }
  if (/\.(ts|mts|cts)$/.test(p)) {
    matched.add('typescript');
  }
  if (p.includes('db') || p.includes('sqlite') || p.includes('sql') || p.includes('schema') || p.includes('migration')) {
    matched.add('database');
    matched.add('security');
  }
  if (p.includes('test') || p.includes('spec')) {
    matched.add('testing');
  }
  if (p.includes('server') || p.includes('route') || p.includes('api') || p.includes('mcp')) {
    matched.add('api');
    matched.add('error-handling');
    matched.add('security');
  }
  if (p.includes('cli') || p.includes('stdio') || p.includes('bin/')) {
    matched.add('cli');
  }
  if (p.includes('perf') || p.includes('cache') || p.includes('worker')) {
    matched.add('performance');
  }

  return Array.from(matched);
}

function formatRuleLine(l: TasteLearning, compact: boolean): string {
  if (compact) {
    return `- [${l.category}|${l.confidence.toFixed(2)}] ${l.ruleText}`;
  }
  return `- [${l.category} | conf=${l.confidence.toFixed(2)} | scope=${l.scope}] ${l.ruleText} — ${l.rationale}`;
}

function formatMicroSkillLine(ms: MicroSkill, compact: boolean): string {
  if (compact) {
    return `- [${ms.category}] ${ms.triggerPattern}: ${ms.factText}`;
  }
  return `- [${ms.category} | verified x${ms.corroborations}] ${ms.triggerPattern}: ${ms.factText}`;
}

export function selectBudgetedLearnings(params: {
  learnings: TasteLearning[];
  microSkills?: MicroSkill[];
  filePath?: string | null;
  maxTokens?: number;
  compact?: boolean;
  includeHints?: boolean;
  includeMicroSkills?: boolean;
  categories?: TasteCategory[];
  scope?: TasteScope | 'all';
}): ContextBudgetResult {
  const maxTokens = Math.min(4000, Math.max(120, Math.round(params.maxTokens ?? 800)));
  const compact = params.compact ?? true;
  const includeHints = params.includeHints ?? true;
  const includeMicroSkills = params.includeMicroSkills ?? true;
  const matchedCategories = inferCategoriesFromFilePath(params.filePath);

  const activeAll = params.learnings.filter((l) => l.status !== 'archived');
  const verboseBaseline = [
    `# Active TasteCaliber Context (${activeAll.length} rules)`,
    ...activeAll.map((l) => formatRuleLine(l, false)),
    ...(params.microSkills ?? [])
      .filter((m) => m.status !== 'retired')
      .map((m) => formatMicroSkillLine(m, false)),
  ].join('\n');
  const baselineTokens = estimateTokens(verboseBaseline);

  const filtered = activeAll.filter((l) => {
    if (params.scope && params.scope !== 'all' && l.scope !== params.scope) return false;
    if (!includeHints && l.status === 'hint') return false;
    if (params.categories && params.categories.length > 0 && !params.categories.includes(l.category)) return false;
    return true;
  });

  const scored = filtered
    .map((l) => {
      const statusWeight = l.status === 'enforced' ? 1.0 : l.status === 'conflicted' ? 0.85 : 0.45;
      const scopeWeight = l.scope === 'project' ? 0.25 : l.scope === 'global' ? 0.15 : 0.1;
      const fileBoost = matchedCategories.includes(l.category) ? 0.55 : 0;
      const score = statusWeight + scopeWeight + fileBoost + l.confidence * 0.5;
      return { learning: l, score };
    })
    .sort((a, b) => b.score - a.score);

  const headerReserve = 42;
  const totalBudget = Math.max(40, maxTokens - headerReserve);

  const verifiedSkills = includeMicroSkills
    ? (params.microSkills ?? [])
        .filter((m) => m.status === 'verified' && (!params.scope || params.scope === 'all' || m.scope === params.scope))
        .sort((a, b) => b.corroborations - a.corroborations)
    : [];

  // Reserve up to 25% (capped at 120 tokens) for verified turn-1 repo micro-skills when present
  const microSkillReserve = verifiedSkills.length > 0 ? Math.min(120, Math.floor(totalBudget * 0.28)) : 0;
  let microSkillBudget = microSkillReserve;
  const injectedMicroSkills: MicroSkill[] = [];
  let microSkillUsed = 0;

  for (const ms of verifiedSkills) {
    const lineCost = estimateTokens(formatMicroSkillLine(ms, compact)) + 2;
    if (microSkillBudget - lineCost < 0 && injectedMicroSkills.length > 0) break;
    if (totalBudget - (microSkillUsed + lineCost) < 40) break;
    microSkillBudget -= lineCost;
    microSkillUsed += lineCost;
    injectedMicroSkills.push(ms);
  }

  let remainingTokens = Math.max(40, totalBudget - microSkillUsed);

  const enforced: TasteLearning[] = [];
  const hints: TasteLearning[] = [];
  const conflicted: TasteLearning[] = [];
  let omittedCount = 0;

  for (const item of scored) {
    const lineCost = estimateTokens(formatRuleLine(item.learning, compact)) + 2;
    if (remainingTokens - lineCost < 0 && enforced.length + hints.length + conflicted.length > 0) {
      omittedCount++;
      continue;
    }
    remainingTokens -= lineCost;
    if (item.learning.status === 'enforced') enforced.push(item.learning);
    else if (item.learning.status === 'conflicted') conflicted.push(item.learning);
    else hints.push(item.learning);
  }

  const lines: string[] = [
    `# TasteCaliber Context (${enforced.length + hints.length + conflicted.length} rules${omittedCount > 0 ? `, ${omittedCount} omitted by budget` : ''}${params.filePath ? ` · file=${params.filePath}` : ''})`,
  ];

  if (enforced.length > 0) {
    lines.push('', `## Enforced (${enforced.length})`, ...enforced.map((l) => formatRuleLine(l, compact)));
  }
  if (hints.length > 0) {
    lines.push('', `## Hints (${hints.length})`, ...hints.map((l) => formatRuleLine(l, compact)));
  }
  if (conflicted.length > 0) {
    lines.push(
      '',
      `## Conflicts Requiring Review (${conflicted.length})`,
      ...conflicted.map((l) => `- [CONFLICT ${l.id}] ${l.ruleText} (vs ${l.conflictsWithId})`),
    );
  }
  if (injectedMicroSkills.length > 0) {
    lines.push(
      '',
      `## Verified Repo Micro-Skills (${injectedMicroSkills.length})`,
      ...injectedMicroSkills.map((ms) => formatMicroSkillLine(ms, compact)),
    );
  }

  const markdownText = lines.join('\n');
  const injectedTokens = estimateTokens(markdownText);
  const tokensSaved = Math.max(0, baselineTokens - injectedTokens);
  const compressionRatioPct =
    baselineTokens > 0 ? Math.round(((baselineTokens - injectedTokens) / baselineTokens) * 1000) / 10 : 0;

  return {
    enforced,
    hints,
    conflicted,
    omittedCount,
    injectedMicroSkills,
    baselineTokens,
    injectedTokens,
    tokensSaved,
    compressionRatioPct,
    matchedCategories,
    markdownText,
  };
}

export function detectFailureLoop(params: {
  filePath?: string | null;
  ruleKey: string;
  signalType: SignalType;
  recentSignals: Array<Pick<TasteSignalRecord, 'filePath' | 'signalType' | 'taste1Decision'>>;
}): LoopGuardResult {
  if (params.signalType !== 'reject' && params.signalType !== 'edit' && params.signalType !== 'diff') {
    return { loopDetected: false, repeatCount: 0, triggerKey: params.ruleKey, interventionAdvice: null };
  }

  const normalizedPath = params.filePath?.trim().toLowerCase() || null;
  let matching = 0;

  for (const sig of params.recentSignals.slice(0, 12)) {
    const sameFile = Boolean(normalizedPath && sig.filePath && sig.filePath.trim().toLowerCase() === normalizedPath);
    const sameRule = sig.taste1Decision?.ruleKey === params.ruleKey;
    if (!sameFile && !sameRule) continue;

    // An explicit accept signal on the same file or rule breaks any prior failure streak
    if (sig.signalType === 'accept') break;
    if (sig.signalType === 'reject' || sig.signalType === 'edit' || sig.signalType === 'diff') {
      matching++;
    }
  }

  const repeatCount = matching + 1;
  if (repeatCount >= 3) {
    const target = normalizedPath ? `file "${params.filePath}"` : `rule "${params.ruleKey}"`;
    return {
      loopDetected: true,
      repeatCount,
      triggerKey: normalizedPath || params.ruleKey,
      interventionAdvice: `Failure-loop guard triggered (${repeatCount} consecutive corrective/reject signals on ${target}). Stop repeating similar patches — call taste_get_context or record a verified micro-skill before retrying.`,
    };
  }

  return {
    loopDetected: false,
    repeatCount,
    triggerKey: normalizedPath || params.ruleKey,
    interventionAdvice: null,
  };
}

export function recommendUnusedTools(
  allToolNames: string[],
  usageStats: ToolUsageStat[],
): UnusedToolRecommendation[] {
  const counts = new Map<string, number>();
  for (const stat of usageStats) {
    counts.set(stat.toolName, stat.callCount);
  }

  return allToolNames
    .map((toolName) => {
      const callCount = counts.get(toolName) ?? 0;
      return { toolName, callCount };
    })
    .filter((entry) => entry.callCount === 0)
    .map((entry) => ({
      toolName: entry.toolName,
      callCount: entry.callCount,
      estimatedSchemaTokensSaved: MCP_SCHEMA_TOKENS_PER_TOOL,
      recommendation: `Prune ${entry.toolName} from agent tool allowlist to reclaim ~${MCP_SCHEMA_TOKENS_PER_TOOL} system prompt tokens/turn.`,
    }));
}
