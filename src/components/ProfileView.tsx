import { useState, type FormEvent } from 'react';
import {
  ThumbsUp,
  ThumbsDown,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Search,
  Pencil,
  Archive,
  Sparkles,
} from 'lucide-react';
import {
  LintFileResult,
  TASTE_CATEGORIES,
  TasteCategory,
  TasteLearning,
  TastePackage,
  TasteScope,
} from '../engine/types';

interface ProfileViewProps {
  learnings: TasteLearning[];
  packages: TastePackage[];
  lintResults: LintFileResult[];
  onFeedback: (learningId: string, feedback: 'accept' | 'reject') => Promise<void>;
  onResolveConflict: (
    learningId: string,
    resolution: 'keep_existing' | 'accept_new' | 'keep_both',
  ) => Promise<void>;
  onSyncPackages: (action: 'push' | 'pull', fromScope: TasteScope, toScope: TasteScope) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function ProfileView({
  learnings,
  packages,
  lintResults,
  onFeedback,
  onResolveConflict,
  onSyncPackages,
  onRefresh,
}: ProfileViewProps) {
  const [scopeFilter, setScopeFilter] = useState<'all' | TasteScope>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enforced' | 'hint' | 'conflicted' | 'archived'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [selectedPkgScope, setSelectedPkgScope] = useState<TasteScope>('project');

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRuleText, setEditRuleText] = useState('');
  const [editRationale, setEditRationale] = useState('');
  const [editCategory, setEditCategory] = useState<TasteCategory>('typescript');

  // Bootstrap (/learn-taste) state
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [bootstrapText, setBootstrapText] = useState('');
  const [bootstrapScope, setBootstrapScope] = useState<TasteScope>('project');
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapNotice, setBootstrapNotice] = useState<string | null>(null);

  const filtered = learnings.filter((l) => {
    if (statusFilter === 'all' && l.status === 'archived') return false;
    if (scopeFilter !== 'all' && l.scope !== scopeFilter) return false;
    if (statusFilter !== 'all' && l.status !== statusFilter) return false;
    if (categoryFilter !== 'all' && l.category !== categoryFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        l.ruleText.toLowerCase().includes(q) ||
        l.rationale.toLowerCase().includes(q) ||
        l.category.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const handleFeedback = async (id: string, feedback: 'accept' | 'reject') => {
    setBusyId(id);
    try {
      await onFeedback(id, feedback);
    } finally {
      setBusyId(null);
    }
  };

  const handleResolve = async (
    id: string,
    resolution: 'keep_existing' | 'accept_new' | 'keep_both',
  ) => {
    setBusyId(id);
    try {
      await onResolveConflict(id, resolution);
    } finally {
      setBusyId(null);
    }
  };

  const startEdit = (item: TasteLearning) => {
    setEditingId(item.id);
    setEditRuleText(item.ruleText);
    setEditRationale(item.rationale);
    setEditCategory(item.category);
  };

  const handleSaveEdit = async (id: string) => {
    if (!editRuleText.trim()) return;
    setBusyId(id);
    try {
      await fetch(`/api/learnings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ruleText: editRuleText.trim(),
          rationale: editRationale.trim(),
          category: editCategory,
        }),
      });
      setEditingId(null);
      await onRefresh();
    } finally {
      setBusyId(null);
    }
  };

  const handleArchive = async (id: string) => {
    setBusyId(id);
    try {
      await fetch(`/api/learnings/${id}`, { method: 'DELETE' });
      await onRefresh();
    } finally {
      setBusyId(null);
    }
  };

  const handleRestore = async (id: string) => {
    setBusyId(id);
    try {
      await fetch(`/api/learnings/${id}/restore`, { method: 'POST' });
      await onRefresh();
    } finally {
      setBusyId(null);
    }
  };

  const handleBootstrap = async (e: FormEvent) => {
    e.preventDefault();
    if (bootstrapText.trim().length < 10) {
      setBootstrapNotice('Paste at least 10 characters of coding guidelines or notes.');
      return;
    }
    setBootstrapping(true);
    setBootstrapNotice(null);
    try {
      const res = await fetch('/api/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: bootstrapText.trim(),
          scope: bootstrapScope,
          sourceAgent: 'TasteCaliber Workbench',
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setBootstrapNotice(json.error || 'Bootstrap failed.');
        return;
      }
      const learnedCount = Array.isArray(json.learned) ? json.learned.length : Number(json.learned ?? 0);
      setBootstrapNotice(
        `Processed ${json.processedCount ?? 0} statement(s): ${learnedCount} learned/updated, ${json.skippedNoise ?? 0} noise filtered.`,
      );
      setBootstrapText('');
      await onRefresh();
    } finally {
      setBootstrapping(false);
    }
  };

  const handleSync = async (action: 'push' | 'pull', fromScope: TasteScope, toScope: TasteScope) => {
    setSyncMessage('Synchronizing...');
    try {
      await onSyncPackages(action, fromScope, toScope);
      setSyncMessage(`Completed ${action}: ${fromScope} -> ${toScope}`);
    } catch {
      setSyncMessage('Sync failed.');
    }
  };

  const activePackage = packages.find((p) => p.scope === selectedPkgScope) ?? packages[0];
  const allLintErrors = lintResults.reduce((sum, r) => sum + r.errors, 0);

  return (
    <div className="space-y-6">
      {/* Filter & Search Bar */}
      <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg" role="group" aria-label="Scope filter">
            {(['all', 'project', 'global', 'remote'] as const).map((sc) => (
              <button
                key={sc}
                type="button"
                onClick={() => setScopeFilter(sc)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  scopeFilter === sc
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {sc === 'all' ? 'All Scopes' : sc.charAt(0).toUpperCase() + sc.slice(1)}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg" role="group" aria-label="Status filter">
              {(['all', 'enforced', 'hint', 'conflicted', 'archived'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    statusFilter === st
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st === 'all' ? 'All Active' : st.charAt(0).toUpperCase() + st.slice(1)}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShowBootstrap((v) => !v)}
              className="px-3 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {showBootstrap ? 'Close Bootstrap' : 'Bootstrap Rules'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2 relative">
            <label htmlFor="taste-search" className="sr-only">
              Search learnings
            </label>
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="taste-search"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter learnings by rule, rationale, or keyword..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>
          <div>
            <label htmlFor="taste-category-select" className="sr-only">
              Filter by category
            </label>
            <select
              id="taste-category-select"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option value="all">All Categories</option>
              {TASTE_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>
        </div>

        {showBootstrap && (
          <form onSubmit={handleBootstrap} className="pt-4 border-t border-slate-200 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-slate-900">
                  Batch Bootstrap Guidelines (/learn-taste)
                </h3>
                <p className="text-xs text-slate-600">
                  Paste bulleted conventions, ESLint notes, or code review guidelines to extract and classify them via taste-1.
                </p>
              </div>
              <select
                aria-label="Bootstrap target scope"
                value={bootstrapScope}
                onChange={(e) => setBootstrapScope(e.target.value as TasteScope)}
                className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg bg-white"
              >
                <option value="project">Project Scope</option>
                <option value="global">Global Scope</option>
              </select>
            </div>
            <textarea
              rows={3}
              value={bootstrapText}
              onChange={(e) => setBootstrapText(e.target.value)}
              placeholder="- Always validate API bodies with zod schemas&#10;- Prefer async/await over raw .then() chains&#10;- Use parameterized SQLite queries exclusively"
              className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              {bootstrapNotice ? (
                <span className="text-xs text-emerald-800">{bootstrapNotice}</span>
              ) : (
                <span className="text-xs text-slate-500">Semantic deduplication merges overlapping rules automatically.</span>
              )}
              <button
                type="submit"
                disabled={bootstrapping}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                {bootstrapping ? 'Extracting...' : 'Extract & Learn Batch'}
              </button>
            </div>
          </form>
        )}
      </section>

      {/* Learnings List + Markdown Preview Split */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <section className="xl:col-span-7 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              Learned Preferences ({filtered.length})
            </h2>
            <span className="text-xs text-slate-500">Accept/Reject recalibrates via Meta-RL</span>
          </div>

          {filtered.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm font-medium text-slate-800">No learnings match your current filters</p>
              <p className="mt-1 text-xs text-slate-500">
                Reset filters or record a new signal in the Signal &amp; Diff Lab.
              </p>
              <button
                type="button"
                onClick={() => {
                  setScopeFilter('all');
                  setStatusFilter('all');
                  setCategoryFilter('all');
                  setSearchQuery('');
                }}
                className="mt-4 px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 cursor-pointer"
              >
                Clear Filters
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-slate-200" data-testid="learnings-list">
              {filtered.map((item) => {
                const statusColor =
                  item.status === 'enforced'
                    ? 'text-emerald-700'
                    : item.status === 'conflicted'
                      ? 'text-amber-700'
                      : item.status === 'archived'
                        ? 'text-slate-400'
                        : 'text-slate-600';
                const statusLabel =
                  item.status === 'enforced'
                    ? 'Enforced'
                    : item.status === 'conflicted'
                      ? 'Conflict'
                      : item.status === 'archived'
                        ? 'Archived'
                        : 'Hint';
                const isEditing = editingId === item.id;

                return (
                  <li key={item.id} className="p-5 hover:bg-slate-50/70 transition-colors">
                    {isEditing ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <div className="sm:col-span-2">
                            <label className="block text-[11px] font-medium text-slate-600 mb-1">
                              Rule Text
                            </label>
                            <input
                              type="text"
                              value={editRuleText}
                              onChange={(e) => setEditRuleText(e.target.value)}
                              className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-slate-600 mb-1">
                              Category
                            </label>
                            <select
                              value={editCategory}
                              onChange={(e) => setEditCategory(e.target.value as TasteCategory)}
                              className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                            >
                              {TASTE_CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div>
                          <label className="block text-[11px] font-medium text-slate-600 mb-1">
                            Rationale
                          </label>
                          <input
                            type="text"
                            value={editRationale}
                            onChange={(e) => setEditRationale(e.target.value)}
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md"
                          />
                        </div>
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 rounded hover:bg-slate-200 cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => handleSaveEdit(item.id)}
                            className="px-3 py-1 text-xs font-medium text-white bg-slate-900 rounded hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                          >
                            Save Changes
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="space-y-1.5 flex-1 min-w-[220px]">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span className="font-mono font-medium text-slate-700">{item.category}</span>
                            <span aria-hidden="true">·</span>
                            <span>{item.scope}</span>
                            <span aria-hidden="true">·</span>
                            <span className={`font-semibold ${statusColor}`}>{statusLabel}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums text-slate-800">
                              conf {item.confidence.toFixed(2)}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              +{item.acceptCount} / -{item.rejectCount}
                            </span>
                          </div>
                          <p className="text-sm font-medium text-slate-900 leading-snug">{item.ruleText}</p>
                          {item.rationale && (
                            <p className="text-xs text-slate-600 leading-relaxed">{item.rationale}</p>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => handleFeedback(item.id, 'accept')}
                            aria-label={`Reinforce "${item.ruleText}"`}
                            className="px-2.5 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100 inline-flex items-center gap-1 whitespace-nowrap cursor-pointer disabled:opacity-50"
                          >
                            <ThumbsUp className="w-3.5 h-3.5" />
                            Accept
                          </button>
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => handleFeedback(item.id, 'reject')}
                            aria-label={`Reject "${item.ruleText}"`}
                            className="px-2.5 py-1.5 text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 inline-flex items-center gap-1 whitespace-nowrap cursor-pointer disabled:opacity-50"
                          >
                            <ThumbsDown className="w-3.5 h-3.5" />
                            Reject
                          </button>
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => startEdit(item)}
                            aria-label={`Edit "${item.ruleText}"`}
                            title="Edit rule"
                            className="p-1.5 text-slate-600 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 hover:text-slate-900 cursor-pointer disabled:opacity-50"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {item.status === 'archived' ? (
                            <button
                              type="button"
                              disabled={busyId === item.id}
                              onClick={() => handleRestore(item.id)}
                              aria-label={`Restore "${item.ruleText}"`}
                              className="px-2.5 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 whitespace-nowrap cursor-pointer disabled:opacity-50"
                            >
                              Restore
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busyId === item.id}
                              onClick={() => handleArchive(item.id)}
                              aria-label={`Archive "${item.ruleText}"`}
                              title="Archive rule"
                              className="p-1.5 text-slate-600 bg-slate-100 border border-slate-200 rounded-md hover:bg-red-50 hover:text-red-700 hover:border-red-200 cursor-pointer disabled:opacity-50"
                            >
                              <Archive className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {item.status === 'conflicted' && (
                      <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-xs text-amber-900">
                          <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                          <span>
                            Contradicts existing rule <span className="font-mono">{item.conflictsWithId}</span>
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => handleResolve(item.id, 'keep_existing')}
                            className="px-2.5 py-1 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                          >
                            Keep Existing
                          </button>
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => handleResolve(item.id, 'accept_new')}
                            className="px-2.5 py-1 text-xs font-medium text-white bg-slate-900 rounded hover:bg-slate-800 whitespace-nowrap cursor-pointer"
                          >
                            Accept New
                          </button>
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => handleResolve(item.id, 'keep_both')}
                            className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-amber-100 rounded hover:bg-amber-200 whitespace-nowrap cursor-pointer"
                          >
                            Keep as Hint
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Live taste.md Package & Lint Inspector */}
        <section className="xl:col-span-5 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Taste Packages &amp; taste.md</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {allLintErrors === 0 ? 'Lint valid (0 errors)' : `${allLintErrors} lint error(s)`}
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(['project', 'global', 'remote'] as const).map((sc) => (
                <button
                  key={sc}
                  type="button"
                  onClick={() => setSelectedPkgScope(sc)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
                    selectedPkgScope === sc ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                  }`}
                >
                  {sc}
                </button>
              ))}
            </div>
          </div>

          <div className="p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100">
              <div className="text-xs text-slate-600 font-mono">
                {selectedPkgScope === 'project'
                  ? '.tastecaliber/taste/taste.md'
                  : selectedPkgScope === 'global'
                    ? '~/.tastecaliber/taste/typescript/taste.md'
                    : `tastecaliber.dev/${activePackage?.namespace ?? 'local'}/taste`}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleSync('push', 'project', 'global')}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200 inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" /> Push to Global
                </button>
                <button
                  type="button"
                  onClick={() => handleSync('pull', 'remote', 'project')}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200 inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                >
                  Pull Remote
                </button>
              </div>
            </div>

            {syncMessage && (
              <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-3 py-2 flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>{syncMessage}</span>
              </div>
            )}

            <pre className="p-4 bg-slate-950 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto max-h-[380px] leading-relaxed whitespace-pre-wrap">
              {activePackage?.markdownContent || '# No taste.md content generated yet'}
            </pre>

            <div className="pt-2 border-t border-slate-200">
              <h3 className="text-xs font-semibold text-slate-800 mb-2">Package Lint Summary</h3>
              <ul className="space-y-1.5 text-xs">
                {lintResults.map((res) => (
                  <li key={res.file} className="flex items-center justify-between font-mono">
                    <span className="text-slate-700 truncate pr-2">{res.file}</span>
                    <span className={res.valid ? 'text-emerald-700 shrink-0' : 'text-red-700 shrink-0'}>
                      {res.valid ? 'valid' : `${res.errors} err`} · {res.warnings} warn
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
