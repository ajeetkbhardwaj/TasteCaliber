export const TASTE_CATEGORIES = [
  'typescript',
  'architecture',
  'cli',
  'react',
  'testing',
  'database',
  'error-handling',
  'formatting',
  'security',
  'api',
  'performance',
] as const;

export type CanonicalTasteCategory = (typeof TASTE_CATEGORIES)[number];
export type TasteCategory = string;

export interface DomainPack {
  id: string;
  slug: string;
  label: string;
  description: string;
  keywords: string[];
  fileExtensions: string[];
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TasteScope = 'project' | 'global' | 'remote';

export type LearningStatus = 'enforced' | 'hint' | 'conflicted' | 'archived';

export type SignalType = 'accept' | 'reject' | 'edit' | 'diff' | 'prompt';

export type ProviderKind = 'local' | 'nvidia' | 'openrouter' | 'custom';

export type ProviderRole = 'input_extractor' | 'output_writer' | 'both' | 'standby';

export interface ModelPreset {
  modelId: string;
  label: string;
  speedTier: 'ultra-fast' | 'fast' | 'reasoning';
  recommendedRole: 'input_extractor' | 'output_writer' | 'both';
}

export const NVIDIA_FAST_MODELS: ModelPreset[] = [
  {
    modelId: 'meta/llama-3.1-8b-instruct',
    label: 'Llama 3.1 8B Instruct (Ultra-Fast Step 1)',
    speedTier: 'ultra-fast',
    recommendedRole: 'input_extractor',
  },
  {
    modelId: 'nvidia/llama-3.1-nemotron-nano-8b-v1',
    label: 'Nemotron Nano 8B (Fast Agentic)',
    speedTier: 'ultra-fast',
    recommendedRole: 'both',
  },
  {
    modelId: 'qwen/qwen2.5-coder-32b-instruct',
    label: 'Qwen 2.5 Coder 32B (Code Diff Specialist)',
    speedTier: 'fast',
    recommendedRole: 'both',
  },
  {
    modelId: 'mistralai/codestral-22b-instruct-v0.1',
    label: 'Codestral 22B (Fast Code Extraction)',
    speedTier: 'fast',
    recommendedRole: 'input_extractor',
  },
  {
    modelId: 'meta/llama-3.3-70b-instruct',
    label: 'Llama 3.3 70B Instruct (Markdown Synthesis)',
    speedTier: 'fast',
    recommendedRole: 'output_writer',
  },
  {
    modelId: 'deepseek-ai/deepseek-r1-distill-qwen-32b',
    label: 'DeepSeek R1 Distill Qwen 32B (Reasoning)',
    speedTier: 'reasoning',
    recommendedRole: 'both',
  },
];

export const OPENROUTER_FREE_MODELS: ModelPreset[] = [
  {
    modelId: 'qwen/qwen-2.5-coder-32b-instruct:free',
    label: 'Qwen 2.5 Coder 32B (Free)',
    speedTier: 'fast',
    recommendedRole: 'both',
  },
  {
    modelId: 'meta-llama/llama-3.3-70b-instruct:free',
    label: 'Llama 3.3 70B Instruct (Free)',
    speedTier: 'fast',
    recommendedRole: 'output_writer',
  },
  {
    modelId: 'deepseek/deepseek-chat-v3-0324:free',
    label: 'DeepSeek V3 0324 (Free)',
    speedTier: 'fast',
    recommendedRole: 'both',
  },
];

export interface TasteLearning {
  id: string;
  packageId: string;
  scope: TasteScope;
  category: TasteCategory;
  ruleKey: string;
  ruleText: string;
  rationale: string;
  confidence: number;
  status: LearningStatus;
  rewardSum: number;
  acceptCount: number;
  rejectCount: number;
  klDivergence: number;
  evidenceCount: number;
  conflictsWithId: string | null;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExtractedSignal {
  candidateRule: string;
  rationale: string;
  ruleKey: string;
  diffSummary: string;
  extractorMode: 'llm' | 'deterministic';
  modelUsed: string;
  latencyMs: number;
  fallbackChainUsed?: string[];
}

export interface CategoryScore {
  category: TasteCategory;
  score: number;
}

export interface Taste1Decision {
  isPreference: boolean;
  salienceScore: number;
  category: TasteCategory;
  topCategories: CategoryScore[];
  ruleKey: string;
  polarity: 'prefer' | 'avoid';
  initialConfidence: number;
  recommendedStatus: LearningStatus;
  contradictsId: string | null;
  contradictionReason: string | null;
  symbolicChecks: {
    validCategory: boolean;
    hasActionableRule: boolean;
    noConflictOverwrite: boolean;
  };
}

export interface RlEpisode {
  id: string;
  learningId: string;
  reward: number;
  baselineProb: number;
  policyProb: number;
  klPenalty: number;
  objectiveScore: number;
  confidenceBefore: number;
  confidenceAfter: number;
  createdAt: string;
}

export interface TasteSignalRecord {
  id: string;
  sourceAgent: string;
  signalType: SignalType;
  filePath: string | null;
  rawInput: string;
  diffBefore: string | null;
  diffAfter: string | null;
  extractedSignal: ExtractedSignal;
  taste1Decision: Taste1Decision;
  rewardDelta: number;
  learningId: string | null;
  createdAt: string;
}

export interface TastePackage {
  id: string;
  name: string;
  scope: TasteScope;
  category: string;
  namespace: string;
  isPublic: boolean;
  stars: number;
  downloads: number;
  markdownContent: string;
  learningCount: number;
  updatedAt: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  envVarName: string;
  modelId: string;
  role: ProviderRole;
  isActive: boolean;
  hasKeyConfigured: boolean;
  lastStatus: 'unknown' | 'ready' | 'unreachable' | 'missing_key';
  lastLatencyMs: number | null;
  lastError: string | null;
}

export interface LintIssue {
  file: string;
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface LintFileResult {
  file: string;
  valid: boolean;
  errors: number;
  warnings: number;
  issues: LintIssue[];
}

export interface LoopGuardResult {
  loopDetected: boolean;
  repeatCount: number;
  triggerKey: string;
  interventionAdvice: string | null;
}

export const CORE_MICRO_SKILL_CATEGORIES = [
  'test',
  'build',
  'lint',
  'env',
  'db',
  'deploy',
  'pattern',
  'workflow',
  'ops',
  'docs',
  'tool',
  'data',
] as const;

export type MicroSkillCategory = string;
export type MicroSkillStatus = 'candidate' | 'verified' | 'retired';

export interface MicroSkill {
  id: string;
  scope: TasteScope;
  category: MicroSkillCategory;
  triggerPattern: string;
  factText: string;
  corroborations: number;
  status: MicroSkillStatus;
  estimatedTokensSaved: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EconomicsEventType =
  | 'context_pruned'
  | 'micro_skill_hit'
  | 'loop_prevented'
  | 'tool_pruned';

export interface EconomicsEvent {
  id: string;
  eventType: EconomicsEventType;
  agentName: string;
  filePath: string | null;
  baselineTokens: number;
  injectedTokens: number;
  tokensSaved: number;
  details: string;
  createdAt: string;
}

export interface ToolUsageStat {
  toolName: string;
  callCount: number;
  avgResponseTokens: number;
  lastCalledAt: string | null;
}

export interface UnusedToolRecommendation {
  toolName: string;
  callCount: number;
  estimatedSchemaTokensSaved: number;
  recommendation: string;
}

export interface EconomicsSummary {
  totalTokensSaved: number;
  totalBaselineTokens: number;
  totalInjectedTokens: number;
  compressionRatioPct: number;
  loopsPrevented: number;
  verifiedMicroSkills: number;
  candidateMicroSkills: number;
  toolUsage: ToolUsageStat[];
  unusedToolRecommendations: UnusedToolRecommendation[];
  prunedAllowlistSnippet?: Record<string, boolean>;
  recentEvents: EconomicsEvent[];
}

export interface ContextBudgetResult {
  enforced: TasteLearning[];
  hints: TasteLearning[];
  conflicted: TasteLearning[];
  omittedCount: number;
  injectedMicroSkills: MicroSkill[];
  baselineTokens: number;
  injectedTokens: number;
  tokensSaved: number;
  compressionRatioPct: number;
  matchedCategories: TasteCategory[];
  markdownText: string;
}

export interface PatchViolation {
  severity: 'error' | 'warning';
  learningId: string;
  category: TasteCategory;
  ruleText: string;
  confidence: number;
  reason: string;
}

export interface PatchVerificationResult {
  compliant: boolean;
  checkedRulesCount: number;
  violations: PatchViolation[];
  warnings: PatchViolation[];
  relevantMicroSkills: Array<{
    id: string;
    category: MicroSkillCategory;
    triggerPattern: string;
    factText: string;
  }>;
  summary: string;
}

export interface PipelineStepTrace {
  dryRun?: boolean;
  loopGuard?: LoopGuardResult;
  step1: ExtractedSignal;
  step2: Taste1Decision;
  step3: {
    markdownPreview: string;
    writerMode: 'llm' | 'deterministic';
    modelUsed: string;
    latencyMs: number;
  };
  step4: {
    learning: TasteLearning;
    rlEpisode: RlEpisode;
    lint: LintFileResult;
    syncedFiles: string[];
  };
}

