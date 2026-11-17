import { useState } from 'react';
import { ArrowRight, CheckCircle2, AlertTriangle, GitBranch, Download, Pause, Play } from 'lucide-react';
import { OverviewData } from '../types/api';

interface OverviewViewProps {
  data: OverviewData;
  onNavigate: (tab: 'overview' | 'profile' | 'signals' | 'economics' | 'providers' | 'mcp') => void;
  onRefresh: () => Promise<void>;
}

export function OverviewView({ data, onNavigate, onRefresh }: OverviewViewProps) {
  const [toggling, setToggling] = useState(false);
  const [exporting, setExporting] = useState(false);

  const learningEnabled =
    data.settings?.tasteLearningProject !== 'false' && data.settings?.tasteLearningUser !== 'false';

  const handleToggleLearning = async () => {
    setToggling(true);
    try {
      const next = !learningEnabled;
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasteLearningProject: next, tasteLearningUser: next }),
      });
      await onRefresh();
    } finally {
      setToggling(false);
    }
  };

  const handleExportJson = async () => {
    setExporting(true);
    try {
      const res = await fetch('/api/export');
      if (!res.ok) return;
      const payload = await res.json();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tastecaliber-profile.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const activeLearnings = data.learnings.filter((l) => l.status !== 'archived');
  const enforcedCount = activeLearnings.filter((l) => l.status === 'enforced').length;
  const conflictCount = activeLearnings.filter((l) => l.status === 'conflicted').length;
  const activeInputProvider =
    data.providers.find((p) => p.isActive && (p.role === 'input_extractor' || p.role === 'both')) ??
    data.providers[0];
  const activeOutputProvider =
    data.providers.find((p) => p.isActive && (p.role === 'output_writer' || p.role === 'both')) ??
    data.providers[0];

  const categoryCounts = new Map<string, number>();
  for (const l of activeLearnings) {
    categoryCounts.set(l.category, (categoryCounts.get(l.category) ?? 0) + 1);
  }
  const sortedCategories = Array.from(categoryCounts.entries()).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-8">
      {/* KPI Strip */}
      <section aria-label="Taste profile metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">Active Learnings</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums font-mono">
            {activeLearnings.length}
          </p>
          <p className="mt-1 text-xs text-slate-500">Stored in local SQLite</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">Enforced Rules</p>
          <p className="mt-2 text-2xl font-semibold text-emerald-700 tabular-nums font-mono">
            {enforcedCount}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Confidence &ge; {data.metaRlConfig.enforcedThreshold.toFixed(2)}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">Flagged Conflicts</p>
          <p
            className={`mt-2 text-2xl font-semibold tabular-nums font-mono ${
              conflictCount > 0 ? 'text-amber-700' : 'text-slate-900'
            }`}
          >
            {conflictCount}
          </p>
          <p className="mt-1 text-xs text-slate-500">Protected by symbolic rules</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">Meta-RL Episodes</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums font-mono">
            {data.episodes.length}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            &beta;<sub>NS</sub> = {data.metaRlConfig.betaNS} · &gamma;<sub>NS</sub> = {data.metaRlConfig.gammaNS}
          </p>
        </div>
      </section>

      {/* TokenEconomizer Snapshot */}
      <section className="bg-white border border-slate-200 rounded-lg px-5 py-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-6 text-xs">
          <div>
            <span className="text-slate-500 block">Tokens Saved</span>
            <span className="font-mono font-semibold text-slate-900 text-sm tabular-nums">
              {data.economics.totalTokensSaved.toLocaleString()} tok ({data.economics.compressionRatioPct.toFixed(1)}% pruned)
            </span>
          </div>
          <div>
            <span className="text-slate-500 block">Verified Micro-Skills</span>
            <span className="font-mono font-semibold text-slate-900 text-sm tabular-nums">
              {data.economics.verifiedMicroSkills} active
            </span>
          </div>
          <div>
            <span className="text-slate-500 block">Failure Loops Prevented</span>
            <span className="font-mono font-semibold text-slate-900 text-sm tabular-nums">
              {data.economics.loopsPrevented}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('economics')}
          className="text-xs font-medium text-blue-700 hover:underline inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
        >
          Inspect Token Economics <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </section>

      {/* 4-Step Pipeline Architecture */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Four-Step Neuro-Symbolic Pipeline</h2>
            <p className="mt-1 text-sm text-slate-600">
              LLMs process raw code diffs and markdown prose at steps 1 and 3; taste-1 performs calibrated non-generative decisions at step 2.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={toggling}
              onClick={handleToggleLearning}
              className={`px-3 py-2 text-xs font-medium rounded-lg border inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50 ${
                learningEnabled
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                  : 'bg-amber-50 text-amber-900 border-amber-200 hover:bg-amber-100'
              }`}
            >
              {learningEnabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {learningEnabled ? 'Learning Active' : 'Learning Paused'}
            </button>
            <button
              type="button"
              disabled={exporting}
              onClick={handleExportJson}
              className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              Export JSON
            </button>
            <button
              type="button"
              onClick={() => onNavigate('signals')}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Run Signal Trace
            </button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 md:grid-cols-4 border border-slate-200 rounded-lg overflow-hidden divide-y md:divide-y-0 md:divide-x divide-slate-200">
          <div className="p-5 bg-slate-50/70 flex flex-col justify-between">
            <div>
              <p className="text-xs font-medium text-slate-500">01. Input Extractor</p>
              <h3 className="mt-1 text-sm font-semibold text-slate-900">Configurable LLM</h3>
              <p className="mt-2 text-xs text-slate-600 leading-relaxed">
                Converts raw prompts, accepts, rejects, and correction diffs into structured candidate signals.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-200 text-xs text-slate-700 font-mono truncate">
              {activeInputProvider ? activeInputProvider.name : 'Deterministic Fallback'}
            </div>
          </div>

          <div className="p-5 bg-slate-900 text-slate-50 flex flex-col justify-between">
            <div>
              <p className="text-xs font-medium text-slate-300">02. Decision Core</p>
              <h3 className="mt-1 text-sm font-semibold text-white">
                <span className="font-mono tracking-normal mr-1">taste-1</span>Classifier
              </h3>
              <p className="mt-2 text-xs text-slate-300 leading-relaxed">
                Neural salience intuition + symbolic taxonomy &amp; conflict check + continuous Meta-RL calibration.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-700 text-xs text-slate-200 font-mono">
              Immutable · Non-generative
            </div>
          </div>

          <div className="p-5 bg-slate-50/70 flex flex-col justify-between">
            <div>
              <p className="text-xs font-medium text-slate-500">03. Output Writer</p>
              <h3 className="mt-1 text-sm font-semibold text-slate-900">Markdown Compiler</h3>
              <p className="mt-2 text-xs text-slate-600 leading-relaxed">
                Merges calibrated rules into readable, lint-checked category sections without overwriting conflicts.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-200 text-xs text-slate-700 font-mono truncate">
              {activeOutputProvider ? activeOutputProvider.name : 'Markdown Compiler v1'}
            </div>
          </div>

          <div className="p-5 bg-slate-50/70 flex flex-col justify-between">
            <div>
              <p className="text-xs font-medium text-slate-500">04. Local Store</p>
              <h3 className="mt-1 text-sm font-semibold text-slate-900">SQLite &amp; taste.md</h3>
              <p className="mt-2 text-xs text-slate-600 leading-relaxed">
                Persists rules, RL episodes, and syncs .tastecaliber/taste/ markdown files for any MCP agent.
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-200 text-xs text-slate-700 font-mono">
              WAL SQLite · {data.packages.length} packages
            </div>
          </div>
        </div>
      </section>

      {/* Meta-NeuroSymbolic Objective + Recent RL Episodes */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-base font-semibold text-slate-900">Meta-NeuroSymbolic RL Objective</h2>
              <span className="text-xs text-slate-500 font-mono">
                KL &beta;={data.metaRlConfig.betaNS} · Pretrain &gamma;={data.metaRlConfig.gammaNS}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Balances symbolic reward against KL-divergence from baseline policy so single noisy edits cannot destabilize established taste.
            </p>
            <div className="mt-4 bg-black rounded-lg p-4 border border-slate-800 overflow-hidden">
              <img
                src="/assets/aistudio/image_8a9b1aa8.png"
                alt="Meta-NeuroSymbolic Objective mathematical formulation"
                referrerPolicy="no-referrer"
                className="w-full h-auto object-contain max-h-24 mx-auto"
              />
            </div>
          </div>

          <div className="mt-6">
            <h3 className="text-xs font-semibold text-slate-700 mb-3">Recent RL Calibration Episodes</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-3 font-medium">Learning ID</th>
                    <th className="py-2 px-3 font-medium text-right">Reward</th>
                    <th className="py-2 px-3 font-medium text-right">KL Penalty</th>
                    <th className="py-2 px-3 font-medium text-right">Objective</th>
                    <th className="py-2 pl-3 font-medium text-right">Confidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                  {data.episodes.slice(0, 5).map((ep) => (
                    <tr key={ep.id} className="hover:bg-slate-50">
                      <td className="py-2 pr-3 text-slate-800 truncate max-w-[140px]">{ep.learningId}</td>
                      <td
                        className={`py-2 px-3 text-right ${
                          ep.reward >= 0 ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {ep.reward >= 0 ? `+${ep.reward.toFixed(2)}` : ep.reward.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 text-right text-slate-600">{ep.klPenalty.toFixed(3)}</td>
                      <td className="py-2 px-3 text-right text-slate-800">{ep.objectiveScore.toFixed(3)}</td>
                      <td className="py-2 pl-3 text-right text-slate-900">
                        {ep.confidenceBefore.toFixed(2)} &rarr; {ep.confidenceAfter.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Category Coverage & Connected Agents */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between space-y-6">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">Symbolic Taxonomy Coverage</h2>
              <button
                type="button"
                onClick={() => onNavigate('profile')}
                className="text-xs font-medium text-blue-700 hover:underline inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
              >
                Inspect Rules <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="mt-4 space-y-2.5">
              {sortedCategories.slice(0, 6).map(([cat, count]) => {
                const pct = Math.round((count / Math.max(1, activeLearnings.length)) * 100);
                return (
                  <div key={cat} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-800">{cat}</span>
                      <span className="text-slate-500 font-mono tabular-nums">
                        {count} rule{count === 1 ? '' : 's'} ({pct}%)
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-slate-800 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="pt-5 border-t border-slate-200">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Connected Coding Agents</h3>
              <button
                type="button"
                onClick={() => onNavigate('mcp')}
                className="text-xs font-medium text-blue-700 hover:underline whitespace-nowrap cursor-pointer"
              >
                MCP Setup
              </button>
            </div>
            <ul className="mt-3 divide-y divide-slate-100 text-xs">
              {data.agents.map((ag) => (
                <li key={ag.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <GitBranch className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="font-medium text-slate-800 truncate">{ag.agent_name}</span>
                    <span className="text-slate-400">·</span>
                    <span className="text-slate-500 font-mono">{ag.transport}</span>
                  </div>
                  <span className="text-slate-600 font-mono tabular-nums shrink-0">
                    {ag.call_count} calls
                  </span>
                </li>
              ))}
            </ul>
            {conflictCount > 0 && (
              <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs text-amber-900">
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                  <span>
                    {conflictCount} symbolic contradiction{conflictCount === 1 ? '' : 's'} awaiting review
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('profile')}
                  className="text-xs font-semibold text-amber-900 hover:underline whitespace-nowrap cursor-pointer"
                >
                  Resolve
                </button>
              </div>
            )}
            {conflictCount === 0 && (
              <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-2 text-xs text-emerald-900">
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                <span>All taste learnings are consistent with zero conflicts.</span>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
