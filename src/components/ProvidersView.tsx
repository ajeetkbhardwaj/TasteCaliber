import { useState, type FormEvent } from 'react';
import { Activity, Plus, CheckCircle2, AlertCircle, Zap, SlidersHorizontal, Trash2 } from 'lucide-react';
import { ModelPreset, ProviderConfig, ProviderKind, ProviderRole } from '../engine/types';

interface ProvidersViewProps {
  providers: ProviderConfig[];
  nvidiaFastModels: ModelPreset[];
  openRouterFreeModels: ModelPreset[];
  metaRlConfig: {
    betaNS: number;
    gammaNS: number;
    enforcedThreshold: number;
    hintThreshold: number;
    noiseThreshold: number;
  };
  onRefresh: () => Promise<void>;
}

export function ProvidersView({
  providers,
  nvidiaFastModels,
  openRouterFreeModels,
  metaRlConfig,
  onRefresh,
}: ProvidersViewProps) {
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [editModelId, setEditModelId] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');

  // Add custom local / OpenAI-compatible provider form
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProviderKind>('local');
  const [baseUrl, setBaseUrl] = useState('http://localhost:8000/v1');
  const [modelId, setModelId] = useState('qwen2.5-coder-7b-instruct');
  const [envVarName, setEnvVarName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleActivate = async (id: string, role: ProviderRole, overrideModelId?: string) => {
    await fetch(`/api/providers/${id}/activate`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, modelId: overrideModelId }),
    });
    await onRefresh();
  };

  const handleApplyPreset = async (preset: ModelPreset, targetKind: 'nvidia' | 'openrouter') => {
    const existing =
      providers.find((p) => p.kind === targetKind && p.modelId === preset.modelId) ??
      providers.find((p) => p.kind === targetKind);
    if (!existing) return;
    await handleActivate(existing.id, preset.recommendedRole, preset.modelId);
  };

  const handleSaveProviderEdit = async (id: string) => {
    if (!editModelId.trim() || !editBaseUrl.trim()) return;
    await fetch(`/api/providers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: editModelId.trim(), baseUrl: editBaseUrl.trim() }),
    });
    setEditingProviderId(null);
    await onRefresh();
  };

  const handleDeleteProvider = async (id: string) => {
    await fetch(`/api/providers/${id}`, { method: 'DELETE' });
    await onRefresh();
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const res = await fetch(`/api/providers/${id}/test`, { method: 'POST' });
      const json = await res.json();
      setTestResult({ id, ok: Boolean(json.ok), message: json.message || 'Checked' });
      await onRefresh();
    } finally {
      setTestingId(null);
    }
  };

  const handleAddProvider = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim() || !baseUrl.trim() || !modelId.trim()) {
      setFormError('Provider name, Base URL, and Model ID are required.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          baseUrl: baseUrl.trim(),
          modelId: modelId.trim(),
          envVarName: envVarName.trim(),
          role: 'standby',
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setFormError(json.error || 'Could not add provider.');
        return;
      }
      setName('');
      await onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const nvidiaKeyConfigured = providers.some((p) => p.kind === 'nvidia' && p.hasKeyConfigured);

  return (
    <div className="space-y-6">
      {/* Step 2 Immutable Core Spec */}
      <section className="bg-slate-900 text-slate-50 rounded-lg p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-xs font-mono text-slate-300">Step 2 · Non-Swappable Decision Model</p>
            <h2 className="mt-1 text-base font-semibold text-white">taste-1 Meta Neuro-Symbolic Classifier</h2>
            <p className="mt-1.5 text-xs text-slate-300 leading-relaxed">
              LLMs only handle text extraction (Step 1) and markdown synthesis (Step 3). taste-1 runs locally with zero token cost, fixed taxonomy enforcement, and calibrated Meta-RL confidence bounds.
            </p>
          </div>
          <div className="grid grid-cols-3 divide-x divide-slate-700 text-xs font-mono tabular-nums pt-1">
            <div className="pr-4">
              <span className="text-slate-400 block">Enforce &ge;</span>
              <span className="text-white font-semibold">{metaRlConfig.enforcedThreshold.toFixed(2)}</span>
            </div>
            <div className="px-4">
              <span className="text-slate-400 block">Hint &ge;</span>
              <span className="text-white font-semibold">{metaRlConfig.hintThreshold.toFixed(2)}</span>
            </div>
            <div className="pl-4">
              <span className="text-slate-400 block">KL &beta; / &gamma;</span>
              <span className="text-white font-semibold">
                {metaRlConfig.betaNS} / {metaRlConfig.gammaNS}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Curated Fast NVIDIA NIM & OpenRouter Presets */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <Zap className="w-4 h-4 text-slate-700" />
              Fast NVIDIA NIM &amp; Free Model Presets
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              One-click model routing for Step 1 (low-latency extraction) and Step 3 (markdown compilation), also manageable by any agent via <span className="font-mono">taste_set_provider</span>.
            </p>
          </div>
          <span className="text-xs font-mono text-slate-600">
            {nvidiaKeyConfigured ? 'NVIDIA_API_KEY ready' : 'Set NVIDIA_API_KEY in server env for NIM'}
          </span>
        </div>

        <div className="space-y-3">
          <p className="text-xs font-semibold text-slate-700">NVIDIA NIM Fast Endpoints (integrate.api.nvidia.com/v1)</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {nvidiaFastModels.map((preset) => {
              const isSelected = providers.some(
                (p) => p.kind === 'nvidia' && p.isActive && p.modelId === preset.modelId,
              );
              return (
                <button
                  key={preset.modelId}
                  type="button"
                  onClick={() => handleApplyPreset(preset, 'nvidia')}
                  className={`p-3.5 text-left rounded-lg border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50/70 text-slate-900 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                    <span className={isSelected ? 'text-emerald-300' : 'text-slate-500'}>
                      {preset.speedTier} · {preset.recommendedRole}
                    </span>
                    {isSelected && <span className="font-semibold text-emerald-300">ACTIVE</span>}
                  </div>
                  <p className="mt-1 text-xs font-semibold">{preset.label}</p>
                  <p className={`mt-0.5 text-[11px] font-mono truncate ${isSelected ? 'text-slate-300' : 'text-slate-600'}`}>
                    {preset.modelId}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 space-y-2">
          <p className="text-xs font-semibold text-slate-700">OpenRouter Free Models</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {openRouterFreeModels.map((preset) => {
              const isSelected = providers.some(
                (p) => p.kind === 'openrouter' && p.isActive && p.modelId === preset.modelId,
              );
              return (
                <button
                  key={preset.modelId}
                  type="button"
                  onClick={() => handleApplyPreset(preset, 'openrouter')}
                  className={`p-3 text-left rounded-lg border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50/70 text-slate-900 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className={isSelected ? 'text-emerald-300' : 'text-slate-500'}>
                      {preset.recommendedRole}
                    </span>
                    {isSelected && <span className="font-semibold text-emerald-300">ACTIVE</span>}
                  </div>
                  <p className="mt-1 text-xs font-semibold">{preset.label}</p>
                  <p className={`mt-0.5 text-[11px] font-mono truncate ${isSelected ? 'text-slate-300' : 'text-slate-600'}`}>
                    {preset.modelId}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Feature Models List (Step 1 & Step 3) */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Configured Engines &amp; Fallback Chain
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Assign separate models to Step 1 (Extractor) and Step 3 (Writer). Automatic fallback switches to local or deterministic parsing if an endpoint fails.
            </p>
          </div>
          <span className="text-xs text-slate-500 font-mono">Offline fallback always ready</span>
        </div>

        <ul className="divide-y divide-slate-200">
          {providers.map((p) => {
            const statusText =
              p.lastStatus === 'ready'
                ? `Connected (${p.lastLatencyMs ?? 0}ms)`
                : p.lastStatus === 'missing_key'
                  ? `Needs env ${p.envVarName}`
                  : p.lastStatus === 'unreachable'
                    ? 'Offline (fallback chain active)'
                    : p.kind === 'local'
                      ? 'Local endpoint (not tested yet)'
                      : 'Env secret configured';
            const isEditing = editingProviderId === p.id;

            return (
              <li key={p.id} className="p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="space-y-1 min-w-[240px] flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="text-sm font-semibold text-slate-900">{p.name}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-slate-700">{p.kind}</span>
                      <span aria-hidden="true">·</span>
                      <span className={p.isActive ? 'text-emerald-700 font-semibold' : 'text-slate-500'}>
                        {p.isActive ? `Active (${p.role})` : 'Standby'}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-slate-600 break-all">
                      {p.baseUrl} · model: {p.modelId}
                      {p.envVarName ? ` · secret: ${p.envVarName}` : ' · no key required'}
                    </div>
                    <p className="text-xs text-slate-500">{statusText}</p>
                    {testResult?.id === p.id && (
                      <div
                        className={`mt-2 text-xs flex items-center gap-1.5 ${
                          testResult.ok ? 'text-emerald-700' : 'text-amber-800'
                        }`}
                      >
                        {testResult.ok ? (
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        )}
                        <span>{testResult.message}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={testingId === p.id}
                      onClick={() => handleTest(p.id)}
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 inline-flex items-center gap-1 whitespace-nowrap cursor-pointer disabled:opacity-50"
                    >
                      <Activity className="w-3.5 h-3.5" />
                      {testingId === p.id ? 'Testing...' : 'Test'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (isEditing) {
                          setEditingProviderId(null);
                        } else {
                          setEditingProviderId(p.id);
                          setEditModelId(p.modelId);
                          setEditBaseUrl(p.baseUrl);
                        }
                      }}
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1 whitespace-nowrap cursor-pointer"
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5" />
                      Model
                    </button>
                    <button
                      type="button"
                      onClick={() => handleActivate(p.id, 'input_extractor')}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
                        p.isActive && p.role === 'input_extractor'
                          ? 'bg-slate-900 text-white'
                          : 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      Step 1
                    </button>
                    <button
                      type="button"
                      onClick={() => handleActivate(p.id, 'output_writer')}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
                        p.isActive && p.role === 'output_writer'
                          ? 'bg-slate-900 text-white'
                          : 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      Step 3
                    </button>
                    <button
                      type="button"
                      onClick={() => handleActivate(p.id, 'both')}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
                        p.isActive && p.role === 'both'
                          ? 'bg-slate-900 text-white'
                          : 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      Both
                    </button>
                    {!p.isActive && providers.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleDeleteProvider(p.id)}
                        aria-label={`Remove ${p.name}`}
                        title="Remove provider"
                        className="p-1.5 text-slate-400 hover:text-red-700 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {isEditing && (
                  <div className="pt-3 border-t border-slate-100 grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
                    <div className="md:col-span-2">
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">Model ID</label>
                      <input
                        type="text"
                        value={editModelId}
                        onChange={(e) => setEditModelId(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-md"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">Base URL</label>
                      <input
                        type="text"
                        value={editBaseUrl}
                        onChange={(e) => setEditBaseUrl(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-md"
                      />
                    </div>
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setEditingProviderId(null)}
                        className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-md cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveProviderEdit(p.id)}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md cursor-pointer"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Add Custom Local / Free OpenAI-Compatible Endpoint */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <h3 className="text-sm font-semibold text-slate-900">Register Local or OpenAI-Compatible Engine</h3>
        <p className="mt-1 text-xs text-slate-600">
          Add llama.cpp, vLLM, Ollama, NVIDIA NIM, or OpenRouter endpoints. API keys are read strictly from server environment variables (never stored in browser state).
        </p>

        <form onSubmit={handleAddProvider} className="mt-4 grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
          <div className="md:col-span-2">
            <label htmlFor="prov-name" className="block text-xs font-medium text-slate-700 mb-1">
              Display Name
            </label>
            <input
              id="prov-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="vLLM Local Server"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
            />
          </div>
          <div className="md:col-span-1">
            <label htmlFor="prov-kind" className="block text-xs font-medium text-slate-700 mb-1">
              Engine Kind
            </label>
            <select
              id="prov-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as ProviderKind)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
            >
              <option value="local">Local</option>
              <option value="nvidia">NVIDIA NIM</option>
              <option value="openrouter">OpenRouter</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div className="md:col-span-3">
            <label htmlFor="prov-url" className="block text-xs font-medium text-slate-700 mb-1">
              Base URL
            </label>
            <input
              id="prov-url"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
            />
          </div>
          <div className="md:col-span-3">
            <label htmlFor="prov-model" className="block text-xs font-medium text-slate-700 mb-1">
              Model ID
            </label>
            <input
              id="prov-model"
              type="text"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="qwen2.5-coder:7b"
              className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
            />
          </div>
          <div className="md:col-span-3">
            <label htmlFor="prov-env" className="block text-xs font-medium text-slate-700 mb-1">
              Env Var Secret Name (optional)
            </label>
            <div className="flex gap-2">
              <input
                id="prov-env"
                type="text"
                value={envVarName}
                onChange={(e) => setEnvVarName(e.target.value)}
                placeholder="OPENROUTER_API_KEY"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
              />
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </div>
          </div>
        </form>

        {formError && (
          <p role="alert" className="mt-3 text-xs text-red-700">
            {formError}
          </p>
        )}
      </section>
    </div>
  );
}
