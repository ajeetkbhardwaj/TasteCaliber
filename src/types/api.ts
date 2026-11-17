import {
  EconomicsSummary,
  LintFileResult,
  MicroSkill,
  ModelPreset,
  ProviderConfig,
  RlEpisode,
  TasteLearning,
  TastePackage,
  TasteSignalRecord,
} from '../engine/types';

export interface AgentConnection {
  id: string;
  agent_name: string;
  transport: string;
  last_seen_at: string;
  call_count: number;
}

export interface OverviewData {
  metaRlConfig: {
    betaNS: number;
    gammaNS: number;
    enforcedThreshold: number;
    hintThreshold: number;
    noiseThreshold: number;
    learningRate: number;
  };
  nvidiaFastModels: ModelPreset[];
  openRouterFreeModels: ModelPreset[];
  learnings: TasteLearning[];
  packages: TastePackage[];
  signals: TasteSignalRecord[];
  episodes: RlEpisode[];
  providers: ProviderConfig[];
  settings: Record<string, string>;
  lintResults: LintFileResult[];
  microSkills: MicroSkill[];
  economics: EconomicsSummary;
  agents: AgentConnection[];
}

