import { useState, type FormEvent } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { EconomicsSummary, MicroSkill, MicroSkillCategory, TasteScope } from '../engine/types';

interface EconomicsViewProps {
  economics: EconomicsSummary;
  microSkills: MicroSkill[];
  onRefresh: () => Promise<void>;
}

const CATEGORIES: MicroSkillCategory[] = ['test', 'build', 'lint', 'env', 'db', 'deploy', 'pattern'];

export function EconomicsView({ economics, microSkills, onRefresh }: EconomicsViewProps) {
  const [triggerPattern, setTriggerPattern] = useState('');
  const [factText, setFactText] = useState('');
  const [category, setCategory] = useState<MicroSkillCategory>('test');
  const [scope, setScope] = useState<TasteScope>('project');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (triggerPattern.trim().length < 3 || factText.trim().length < 5) {
      setError('Trigger pattern (min 3 chars) and verified fact (min 5 chars) are required.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/micro-skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          category,
          triggerPattern: triggerPattern.trim(),
          factText: factText.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Failed to save micro-skill');
        return;
      }
      setTriggerPattern('');
      setFactText('');
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error saving micro-skill');
    } finally {
      setSaving(false);
    }
  };

  const handleCorroborate = async (id: string) => {
    setBusyId(id);
    try {
      await fetch(`/api/micro-skills/${id}/corroborate`, { method: 'POST' });
      await onRefresh();
    } finally {
      setBusyId(null);
    }
  };

  const handleRetire = async (id: string) => {
    setBusyId(id);
    try {
      await fetch(`/api/micro-skills/${id}`, { method: 'DELETE' });
      await onRefresh();
    } finally {
      setBusyId(null);
    }
  };

  const potentialSchemaSavings = economics.unusedToolRecommendations.reduce(
    (sum, r) => sum + r.estimatedSchemaTokensSaved,
    0,
  );

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">Total Tokens Saved</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900 tabular-nums">
            {economics.totalTokensSaved.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            {economics.totalInjectedTokens.toLocaleString()} injected vs{' '}
            {economics.totalBaselineTokens.toLocaleString()} baseline
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">Context Compression</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900 tabular-nums">
            {economics.compressionRatioPct.toFixed(1)}%
          </p>
          <p className="mt-1 text-xs text-slate-500">File-aware 800-token budget enforcement</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">Verified Micro-Skills</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900 tabular-nums">
            {economics.verifiedMicroSkills}
          </p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            {economics.candidateMicroSkills} candidate awaiting corroboration
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <p className="text-xs font-medium text-slate-500">Failure Loops Prevented</p>
          <p className="mt-2 text-2xl font-bold tracking-tight text-slate-900 tabular-nums">
            {economics.loopsPrevented}
          </p>
          <p className="mt-1 text-xs text-slate-500">3+ corrective-churn guard triggers</p>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Repository Micro-Skills */}
        <section className="xl:col-span-7 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Repository Micro-Skills</h2>
            <p className="mt-1 text-xs text-slate-600">
              Verified operational repo facts injected on turn 1 once corroborated (&ge;2 sessions). Eliminates repetitive codebase exploration turns.
            </p>
          </div>

          <form onSubmit={handleCreate} className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="ms-category" className="block text-xs font-medium text-slate-700 mb-1">
                  Category
                </label>
                <select
                  id="ms-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as MicroSkillCategory)}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ms-scope" className="block text-xs font-medium text-slate-700 mb-1">
                  Scope
                </label>
                <select
                  id="ms-scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as TasteScope)}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
                >
                  <option value="project">project</option>
                  <option value="global">global</option>
                  <option value="remote">remote</option>
                </select>
              </div>
              <div>
                <label htmlFor="ms-trigger" className="block text-xs font-medium text-slate-700 mb-1">
                  Trigger Context
                </label>
                <input
                  id="ms-trigger"
                  type="text"
                  value={triggerPattern}
                  onChange={(e) => setTriggerPattern(e.target.value)}
                  placeholder="e.g. running API smoke tests"
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
                />
              </div>
            </div>

            <div>
              <label htmlFor="ms-fact" className="block text-xs font-medium text-slate-700 mb-1">
                Operational Fact / Command
              </label>
              <input
                id="ms-fact"
                type="text"
                value={factText}
                onChange={(e) => setFactText(e.target.value)}
                placeholder="e.g. Start server with npx tsx server.ts --port 3000 before curl /mcp checks"
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-white"
              />
            </div>

            {error && (
              <div role="alert" className="p-2.5 text-xs text-red-800 bg-red-50 border border-red-200 rounded">
                {error}
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" />
                {saving ? 'Saving...' : 'Add Micro-Skill'}
              </button>
            </div>
          </form>

          <div className="divide-y divide-slate-200 border-t border-slate-200">
            {microSkills.map((ms) => (
              <div key={ms.id} className="py-3.5 flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={`font-semibold ${
                        ms.status === 'verified'
                          ? 'text-emerald-700'
                          : ms.status === 'candidate'
                            ? 'text-amber-700'
                            : 'text-slate-400'
                      }`}
                    >
                      {ms.status}
                    </span>
                    <span className="text-slate-300">&middot;</span>
                    <span className="font-mono text-slate-600">{ms.category}</span>
                    <span className="text-slate-300">&middot;</span>
                    <span className="font-mono text-slate-500 tabular-nums">
                      x{ms.corroborations} corroborations · ~{ms.estimatedTokensSaved} tok saved/hit
                    </span>
                  </div>
                  <p className="text-sm font-medium text-slate-900">{ms.triggerPattern}</p>
                  <p className="text-xs text-slate-600 font-mono">{ms.factText}</p>
                </div>

                {ms.status !== 'retired' && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={busyId === ms.id}
                      onClick={() => handleCorroborate(ms.id)}
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded hover:bg-slate-200 inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                      title="Corroborate across another session"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Corroborate
                    </button>
                    <button
                      type="button"
                      disabled={busyId === ms.id}
                      onClick={() => handleRetire(ms.id)}
                      aria-label={`Retire ${ms.triggerPattern}`}
                      className="p-1.5 text-slate-400 hover:text-red-700 cursor-pointer disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* MCP Tool Pruning & Savings Ledger */}
        <section className="xl:col-span-5 space-y-6">
          <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <div className="flex items-baseline justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-900">MCP Tool Pruning Advisor</h2>
                <p className="mt-1 text-xs text-slate-600">
                  Disable unused MCP tool schemas in agent configs to reclaim system-prompt tokens.
                </p>
              </div>
              <span className="text-xs font-mono font-semibold text-slate-900 tabular-nums shrink-0">
                +{potentialSchemaSavings} tok/turn
              </span>
            </div>

            {economics.unusedToolRecommendations.length === 0 ? (
              <p className="text-xs text-emerald-700 border-t border-slate-200 pt-3">
                All registered MCP tools are actively utilized in this workspace.
              </p>
            ) : (
              <div className="divide-y divide-slate-200 border-t border-slate-200 max-h-56 overflow-y-auto">
                {economics.unusedToolRecommendations.map((rec) => (
                  <div key={rec.toolName} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                    <span className="font-mono text-slate-800 truncate">{rec.toolName}</span>
                    <span className="font-mono text-slate-500 tabular-nums shrink-0">
                      0 calls · ~{rec.estimatedSchemaTokensSaved} tok
                    </span>
                  </div>
                ))}
              </div>
            )}

            {economics.toolUsage.length > 0 && (
              <div className="pt-3 border-t border-slate-200 space-y-2">
                <p className="text-xs font-semibold text-slate-700">Active Tool Telemetry</p>
                <div className="space-y-1.5">
                  {economics.toolUsage.slice(0, 6).map((tu) => (
                    <div key={tu.toolName} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-slate-700">{tu.toolName}</span>
                      <span className="font-mono text-slate-500 tabular-nums">
                        {tu.callCount} calls · avg {tu.avgResponseTokens} tok
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-3">
            <h2 className="text-base font-semibold text-slate-900">Recent Token Savings Ledger</h2>
            <div className="divide-y divide-slate-200 border-t border-slate-200 max-h-72 overflow-y-auto">
              {economics.recentEvents.map((ev) => (
                <div key={ev.id} className="py-3 space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono font-semibold text-slate-800">{ev.eventType}</span>
                    <span className="font-mono text-emerald-700 font-semibold tabular-nums">
                      -{ev.tokensSaved} tok
                    </span>
                  </div>
                  <p className="text-xs text-slate-600">{ev.details}</p>
                  <p className="text-[11px] font-mono text-slate-400">
                    {ev.agentName}
                    {ev.filePath ? ` · ${ev.filePath}` : ''}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
