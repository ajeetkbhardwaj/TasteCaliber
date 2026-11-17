import { useState, type FormEvent } from 'react';
import { Play, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { PipelineStepTrace, SignalType, TasteScope } from '../engine/types';

interface SignalLabViewProps {
  onSignalProcessed: () => Promise<void>;
}

const PRESETS: Array<{
  label: string;
  signalType: SignalType;
  filePath: string;
  rawInput: string;
  diffBefore: string;
  diffAfter: string;
}> = [
  {
    label: 'Async/Await + Error Guard',
    signalType: 'edit',
    filePath: 'server/routes/users.ts',
    rawInput: 'Prefer async/await with explicit try/catch and early return guards',
    diffBefore: 'fetchUser(id).then(u => res.json(u)).catch(err => console.log(err));',
    diffAfter: 'try {\n  const user = await fetchUser(id);\n  if (!user) return res.status(404).json({ error: "Not found" });\n  return res.json(user);\n} catch (err) {\n  return res.status(500).json({ error: "Failed" });\n}',
  },
  {
    label: 'SQLite Parameterized Query',
    signalType: 'diff',
    filePath: 'server/db.ts',
    rawInput: 'Always use prepared parameterized SQLite statements instead of string interpolation',
    diffBefore: 'const row = db.exec(`SELECT * FROM learnings WHERE id = ${id}`);',
    diffAfter: 'const row = db.prepare("SELECT * FROM learnings WHERE id = ?").get(id);',
  },
  {
    label: 'Conflicting Rule (No Semicolons)',
    signalType: 'edit',
    filePath: 'src/utils/format.ts',
    rawInput: 'Omit semicolons across TypeScript modules',
    diffBefore: 'export const version = "1.0.0";',
    diffAfter: 'export const version = "1.0.0"',
  },
  {
    label: 'Noise Signal Test',
    signalType: 'prompt',
    filePath: '',
    rawInput: 'looks good',
    diffBefore: '',
    diffAfter: '',
  },
];

export function SignalLabView({ onSignalProcessed }: SignalLabViewProps) {
  const [signalType, setSignalType] = useState<SignalType>('edit');
  const [scope, setScope] = useState<TasteScope>('project');
  const [sourceAgent, setSourceAgent] = useState('Claude Code');
  const [filePath, setFilePath] = useState('');
  const [rawInput, setRawInput] = useState('');
  const [diffBefore, setDiffBefore] = useState('');
  const [diffAfter, setDiffAfter] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<PipelineStepTrace | null>(null);

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setSignalType(p.signalType);
    setFilePath(p.filePath);
    setRawInput(p.rawInput);
    setDiffBefore(p.diffBefore);
    setDiffAfter(p.diffAfter);
    setError(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!rawInput.trim() || rawInput.trim().length < 2) {
      setError('Please enter a preference statement or edit description before running the pipeline.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signalType,
          scope,
          sourceAgent,
          filePath: filePath.trim() || null,
          rawInput: rawInput.trim(),
          diffBefore: diffBefore.trim() || null,
          diffAfter: diffAfter.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Failed to process signal.');
        return;
      }
      setTrace(json as PipelineStepTrace);
      await onSignalProcessed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error submitting signal');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Input Form */}
      <section className="xl:col-span-6 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Signal &amp; Diff Ingestion Lab</h2>
          <p className="mt-1 text-xs text-slate-600">
            Simulate an accept, reject, or code diff from any coding agent and inspect all four pipeline steps.
          </p>
        </div>

        <div>
          <p className="text-xs font-medium text-slate-500 mb-2">Load Sample Scenario</p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p)}
                className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 whitespace-nowrap cursor-pointer"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="sig-type" className="block text-xs font-medium text-slate-700 mb-1">
                Signal Type
              </label>
              <select
                id="sig-type"
                value={signalType}
                onChange={(e) => setSignalType(e.target.value as SignalType)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
              >
                <option value="edit">Edit / Correction</option>
                <option value="diff">Commit Diff</option>
                <option value="accept">Accept (+1)</option>
                <option value="reject">Reject (-1)</option>
                <option value="prompt">Explicit Prompt</option>
              </select>
            </div>
            <div>
              <label htmlFor="sig-scope" className="block text-xs font-medium text-slate-700 mb-1">
                Target Scope
              </label>
              <select
                id="sig-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as TasteScope)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
              >
                <option value="project">Project Scope</option>
                <option value="global">Global Scope</option>
                <option value="remote">Remote Scope</option>
              </select>
            </div>
            <div>
              <label htmlFor="sig-agent" className="block text-xs font-medium text-slate-700 mb-1">
                Source Agent
              </label>
              <input
                id="sig-agent"
                type="text"
                value={sourceAgent}
                onChange={(e) => setSourceAgent(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          <div>
            <label htmlFor="sig-filepath" className="block text-xs font-medium text-slate-700 mb-1">
              File Path (optional)
            </label>
            <input
              id="sig-filepath"
              type="text"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder="e.g. server/db.ts"
              className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
            />
          </div>

          <div>
            <label htmlFor="sig-raw" className="block text-xs font-medium text-slate-700 mb-1">
              Preference / Correction Summary
            </label>
            <textarea
              id="sig-raw"
              rows={2}
              value={rawInput}
              onChange={(e) => setRawInput(e.target.value)}
              placeholder="Describe the coding choice or correction (e.g. Always validate API inputs with zod before touching SQLite)"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="sig-before" className="block text-xs font-medium text-slate-700 mb-1">
                Code Before (optional)
              </label>
              <textarea
                id="sig-before"
                rows={4}
                value={diffBefore}
                onChange={(e) => setDiffBefore(e.target.value)}
                placeholder="Original snippet..."
                className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label htmlFor="sig-after" className="block text-xs font-medium text-slate-700 mb-1">
                Code After (optional)
              </label>
              <textarea
                id="sig-after"
                rows={4}
                value={diffAfter}
                onChange={(e) => setDiffAfter(e.target.value)}
                placeholder="Edited snippet..."
                className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          {error && (
            <div role="alert" className="p-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 inline-flex items-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {submitting ? 'Running Pipeline...' : 'Analyze & Learn'}
            </button>
          </div>
        </form>
      </section>

      {/* Live 4-Step Pipeline Trace Output */}
      <section className="xl:col-span-6 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Pipeline Execution Trace</h2>
          <p className="mt-1 text-xs text-slate-600">
            Inspect each stage from raw input extraction to calibrated SQLite and taste.md storage.
          </p>
        </div>

        {!trace ? (
          <div className="py-10 border-t border-slate-200 text-center text-xs text-slate-500">
            Submit a signal on the left to observe Step 1 extraction, Step 2 taste-1 decision probabilities, Step 3 markdown output, and Step 4 SQLite RL update.
          </div>
        ) : (
          <div className="space-y-4" data-testid="pipeline-trace">
            {trace.dryRun && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                <span>
                  Taste learning is currently paused — trace evaluated in dry-run mode without writing to SQLite or taste.md.
                </span>
              </div>
            )}

            {trace.loopGuard?.loopDetected && (
              <div
                role="alert"
                className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900 flex items-start gap-2"
              >
                <AlertTriangle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Failure-Loop Guard Triggered</p>
                  <p className="mt-0.5">{trace.loopGuard.interventionAdvice}</p>
                </div>
              </div>
            )}

            {/* Step 1 */}
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-slate-900">Step 1 · Input Extraction</span>
                <span className="font-mono text-slate-500">
                  {trace.step1.extractorMode} · {trace.step1.modelUsed} ({trace.step1.latencyMs}ms)
                </span>
              </div>
              <p className="text-sm font-medium text-slate-900">{trace.step1.candidateRule}</p>
              <p className="text-xs text-slate-600">{trace.step1.rationale}</p>
              {trace.step1.fallbackChainUsed && trace.step1.fallbackChainUsed.length > 0 && (
                <p className="text-[11px] font-mono text-slate-500 pt-1">
                  Fallback chain: {trace.step1.fallbackChainUsed.join(' -> ')}
                </p>
              )}
            </div>

            {/* Step 2 */}
            <div className="p-4 bg-slate-900 text-slate-50 rounded-lg space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-white">Step 2 · taste-1 Decision Classifier</span>
                <span className="font-mono text-slate-300">
                  salience {trace.step2.salienceScore.toFixed(2)} · {trace.step2.polarity}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3 text-xs font-mono tabular-nums">
                <div>
                  <span className="text-slate-400 block">Preference?</span>
                  <span className={trace.step2.isPreference ? 'text-emerald-400' : 'text-amber-300'}>
                    {trace.step2.isPreference ? 'true (signal)' : 'false (noise)'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">Category</span>
                  <span className="text-white">{trace.step2.category}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Calibrated Conf</span>
                  <span className="text-white">{trace.step2.initialConfidence.toFixed(2)}</span>
                </div>
              </div>
              <div className="text-xs text-slate-300 flex flex-wrap gap-3 pt-2 border-t border-slate-700 font-mono">
                {trace.step2.topCategories.map((c) => (
                  <span key={c.category}>
                    {c.category}: {(c.score * 100).toFixed(0)}%
                  </span>
                ))}
              </div>
              {trace.step2.contradictsId && (
                <div className="p-2.5 bg-amber-950/70 border border-amber-700 rounded text-xs text-amber-200 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <span>{trace.step2.contradictionReason}</span>
                </div>
              )}
            </div>

            {/* Step 3 & 4 */}
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-900">Step 3 &amp; 4 · SQLite + taste.md Sync</span>
                <span className="text-emerald-700 font-mono inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {trace.step4.learning.status} ({trace.step4.learning.confidence.toFixed(2)})
                </span>
              </div>
              <p className="text-xs text-slate-600 font-mono tabular-nums">
                RL Reward {trace.step4.rlEpisode.reward >= 0 ? '+' : ''}
                {trace.step4.rlEpisode.reward.toFixed(2)} · KL {trace.step4.rlEpisode.klPenalty.toFixed(3)} ·
                Synced {trace.step4.syncedFiles.length} file(s)
              </p>
              <pre className="p-3 bg-slate-950 text-slate-100 rounded text-xs font-mono overflow-x-auto max-h-44 whitespace-pre-wrap">
                {trace.step3.markdownPreview}
              </pre>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
