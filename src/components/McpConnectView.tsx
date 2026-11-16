import { useState } from 'react';
import { Copy, Check, Terminal, Play, Bot } from 'lucide-react';

type AgentClientId = 'opencode' | 'claude-code' | 'cursor' | 'windsurf' | 'cline' | 'zed';

const MCP_TOOLS = [
  {
    name: 'taste_get_context',
    description: 'Fetch active enforced rules & low-confidence hints',
    sampleArgs: { scope: 'all', includeHints: true, agentName: 'Workbench Inspector' },
  },
  {
    name: 'taste_query_learnings',
    description: 'Search SQLite taste learnings by category or status',
    sampleArgs: { scope: 'project', status: 'enforced' },
  },
  {
    name: 'taste_record_signal',
    description: 'Ingest a coding preference or diff through the 4-step pipeline',
    sampleArgs: {
      signalType: 'edit',
      rawInput: 'Prefer explicit zod validation on all API request bodies',
      filePath: 'server.ts',
      scope: 'project',
      agentName: 'MCP Inspector',
    },
  },
  {
    name: 'taste_reinforce',
    description: 'Apply +1/-1 Meta-RL reward calibration to a rule',
    sampleArgs: { learningId: 'learn-1', feedback: 'accept' },
  },
  {
    name: 'taste_resolve_conflict',
    description: 'Resolve a flagged symbolic contradiction',
    sampleArgs: { conflictedLearningId: 'learn-conflict', resolution: 'keep_both' },
  },
  {
    name: 'taste_lint',
    description: 'Validate all compiled taste.md files',
    sampleArgs: {},
  },
  {
    name: 'taste_push_pull',
    description: 'Sync taste packages between project, global, and remote scopes',
    sampleArgs: { action: 'push', fromScope: 'project', toScope: 'global', overwrite: false },
  },
  {
    name: 'taste_list_providers',
    description: 'List local, NVIDIA NIM fast models, and OpenRouter providers',
    sampleArgs: {},
  },
  {
    name: 'taste_set_provider',
    description: 'Assign active Step 1 / Step 3 model provider or NVIDIA fast model',
    sampleArgs: {
      providerId: 'prov-nvidia-fast',
      role: 'input_extractor',
      modelId: 'meta/llama-3.1-8b-instruct',
    },
  },
  {
    name: 'taste_configure_settings',
    description: 'Pause or resume TasteCaliber project/user learning',
    sampleArgs: { tasteLearningProject: true },
  },
  {
    name: 'taste_bootstrap',
    description: 'Batch extract coding preferences from guidelines (/learn-taste)',
    sampleArgs: {
      text: '- Always validate Express inputs with zod\n- Prefer parameterized SQLite queries',
      scope: 'project',
      agentName: 'MCP Bootstrap',
    },
  },
];

export function McpConnectView({ onSignalProcessed }: { onSignalProcessed: () => Promise<void> }) {
  const [selectedAgent, setSelectedAgent] = useState<AgentClientId>('opencode');
  const [transportMode, setTransportMode] = useState<'http' | 'stdio'>('http');
  const [copied, setCopied] = useState(false);

  // Live MCP Inspector state
  const [selectedTool, setSelectedTool] = useState(MCP_TOOLS[0].name);
  const [rpcArgsJson, setRpcArgsJson] = useState(JSON.stringify(MCP_TOOLS[0].sampleArgs, null, 2));
  const [rpcResponse, setRpcResponse] = useState<string | null>(null);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [simulating, setSimulating] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const httpUrl = `${origin}/mcp`;

  const getConfigSnippet = (): string => {
    if (selectedAgent === 'opencode') {
      if (transportMode === 'stdio') {
        return JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            mcp: {
              tastecaliber: {
                type: 'local',
                command: ['npx', 'tsx', 'mcp-stdio.ts'],
                environment: { TASTE_DB_PATH: './data/taste.db' },
                enabled: true,
              },
            },
          },
          null,
          2,
        );
      }
      return JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: {
            tastecaliber: {
              type: 'remote',
              url: httpUrl,
              enabled: true,
            },
          },
        },
        null,
        2,
      );
    }

    if (transportMode === 'stdio') {
      if (selectedAgent === 'zed') {
        return JSON.stringify(
          {
            context_servers: {
              tastecaliber: {
                command: { path: 'npx', args: ['tsx', 'mcp-stdio.ts'] },
              },
            },
          },
          null,
          2,
        );
      }
      return JSON.stringify(
        {
          mcpServers: {
            tastecaliber: {
              command: 'npx',
              args: ['tsx', 'mcp-stdio.ts'],
              env: { TASTE_DB_PATH: './data/taste.db' },
            },
          },
        },
        null,
        2,
      );
    }

    if (selectedAgent === 'claude-code') {
      return `claude mcp add --transport http tastecaliber ${httpUrl}`;
    }

    return JSON.stringify(
      {
        mcpServers: {
          tastecaliber: {
            type: 'http',
            url: httpUrl,
          },
        },
      },
      null,
      2,
    );
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(getConfigSnippet()).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleSelectTool = (toolName: string) => {
    setSelectedTool(toolName);
    const found = MCP_TOOLS.find((t) => t.name === toolName);
    if (found) {
      setRpcArgsJson(JSON.stringify(found.sampleArgs, null, 2));
    }
    setRpcError(null);
  };

  const executeMcpCall = async (method: 'tools/list' | 'tools/call') => {
    setRpcError(null);
    let parsedArgs: Record<string, unknown> = {};
    if (method === 'tools/call') {
      try {
        parsedArgs = JSON.parse(rpcArgsJson);
      } catch {
        setRpcError('Arguments must be valid JSON.');
        return;
      }
    }

    setRunning(true);
    try {
      const payload =
        method === 'tools/list'
          ? { jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} }
          : {
              jsonrpc: '2.0',
              id: Date.now(),
              method: 'tools/call',
              params: { name: selectedTool, arguments: parsedArgs },
            };

      const res = await fetch('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      try {
        const parsed = JSON.parse(text);
        setRpcResponse(JSON.stringify(parsed, null, 2));
      } catch {
        setRpcResponse(text);
      }

      if (selectedTool === 'taste_record_signal' || method === 'tools/call') {
        await onSignalProcessed();
      }
    } catch (err) {
      setRpcError(err instanceof Error ? err.message : 'Failed to call /mcp endpoint');
    } finally {
      setRunning(false);
    }
  };

  const runOpenCodeSessionTest = async () => {
    setRpcError(null);
    setSimulating(true);
    const agentLabel =
      selectedAgent === 'opencode'
        ? 'OpenCode CLI'
        : selectedAgent === 'claude-code'
          ? 'Claude Code'
          : selectedAgent.charAt(0).toUpperCase() + selectedAgent.slice(1);
    const traceLog: Array<{ step: string; latencyMs: number; summary: unknown }> = [];

    const callRpc = async (method: string, params: Record<string, unknown>) => {
      const t0 = performance.now();
      const res = await fetch('/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      const json = await res.json();
      return { json, latencyMs: Math.round(performance.now() - t0) };
    };

    try {
      const init = await callRpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: selectedAgent, version: '1.0.0' },
      });
      traceLog.push({
        step: `1. initialize (${agentLabel})`,
        latencyMs: init.latencyMs,
        summary: init.json?.result?.serverInfo ?? init.json,
      });

      const ctx = await callRpc('tools/call', {
        name: 'taste_get_context',
        arguments: { scope: 'all', includeHints: true, agentName: agentLabel },
      });
      traceLog.push({
        step: '2. taste_get_context',
        latencyMs: ctx.latencyMs,
        summary: ctx.json?.result?.content?.[0]?.text?.split('\n').slice(0, 6).join('\n'),
      });

      const rec = await callRpc('tools/call', {
        name: 'taste_record_signal',
        arguments: {
          signalType: 'edit',
          rawInput: 'Prefer named exports and strict TypeScript return types on exported helpers',
          filePath: 'src/utils/format.ts',
          diffBefore: 'export default function fmt(v: any) { return String(v); }',
          diffAfter: 'export function fmt(v: unknown): string { return String(v); }',
          scope: 'project',
          agentName: agentLabel,
        },
      });
      const recParsed = JSON.parse(rec.json?.result?.content?.[0]?.text || '{}');
      traceLog.push({
        step: '3. taste_record_signal',
        latencyMs: rec.latencyMs,
        summary: recParsed,
      });

      if (recParsed.learningId) {
        const reinf = await callRpc('tools/call', {
          name: 'taste_reinforce',
          arguments: { learningId: recParsed.learningId, feedback: 'accept' },
        });
        const reinfParsed = JSON.parse(reinf.json?.result?.content?.[0]?.text || '{}');
        traceLog.push({
          step: '4. taste_reinforce (+1 Meta-RL)',
          latencyMs: reinf.latencyMs,
          summary: {
            confidence: reinfParsed.learning?.confidence,
            status: reinfParsed.learning?.status,
            klPenalty: reinfParsed.episode?.klPenalty,
          },
        });
      }

      const lint = await callRpc('tools/call', { name: 'taste_lint', arguments: {} });
      traceLog.push({
        step: '5. taste_lint',
        latencyMs: lint.latencyMs,
        summary: JSON.parse(lint.json?.result?.content?.[0]?.text || '{}'),
      });

      setRpcResponse(JSON.stringify({ agent: agentLabel, steps: traceLog }, null, 2));
      await onSignalProcessed();
    } catch (err) {
      setRpcError(err instanceof Error ? err.message : 'Agent simulation failed');
    } finally {
      setSimulating(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Agent Configuration Generator */}
      <section className="xl:col-span-6 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Connect Any Coding Agent</h2>
          <p className="mt-1 text-xs text-slate-600">
            TasteCaliber exposes both a Streamable HTTP endpoint (<span className="font-mono">/mcp</span>) and a local stdio runner (<span className="font-mono">mcp-stdio.ts</span>) backed by the same SQLite database.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg" role="group" aria-label="Coding agent selector">
            {(
              [
                ['opencode', 'OpenCode'],
                ['claude-code', 'Claude Code'],
                ['cursor', 'Cursor'],
                ['windsurf', 'Windsurf'],
                ['cline', 'Cline'],
                ['zed', 'Zed'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setSelectedAgent(id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
                  selectedAgent === id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg" role="group" aria-label="Transport selector">
            <button
              type="button"
              onClick={() => setTransportMode('http')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
                transportMode === 'http' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              Streamable HTTP
            </button>
            <button
              type="button"
              onClick={() => setTransportMode('stdio')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap cursor-pointer ${
                transportMode === 'stdio' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              Local Stdio
            </button>
          </div>
        </div>

        <div className="relative">
          <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900 text-slate-300 rounded-t-lg border-b border-slate-800 text-xs font-mono">
            <span className="inline-flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5" />
              {transportMode === 'http' ? httpUrl : 'npx tsx mcp-stdio.ts'}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-100 rounded inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="p-4 bg-slate-950 text-slate-100 rounded-b-lg text-xs font-mono overflow-x-auto leading-relaxed">
            {getConfigSnippet()}
          </pre>
        </div>

        <div className="pt-2 border-t border-slate-200 space-y-2">
          <h3 className="text-xs font-semibold text-slate-800">Exposed MCP Capabilities (11 Tools + 3 Resources)</h3>
          <ul className="space-y-1.5 text-xs text-slate-600">
            <li>
              <span className="font-mono text-slate-900">taste_get_context</span> · Injects enforced rules &amp; hints before code generation
            </li>
            <li>
              <span className="font-mono text-slate-900">taste_record_signal</span> · Runs 4-step pipeline on edits, diffs, accepts &amp; rejects
            </li>
            <li>
              <span className="font-mono text-slate-900">taste_list_providers</span> &amp; <span className="font-mono text-slate-900">taste_set_provider</span> · Switch NVIDIA NIM fast models, OpenRouter, or local inference engines from your agent
            </li>
            <li>
              <span className="font-mono text-slate-900">taste_bootstrap</span> &amp; <span className="font-mono text-slate-900">taste_configure_settings</span> · Batch import guidelines or pause/resume learning
            </li>
            <li>
              <span className="font-mono text-slate-900">taste://profile/project</span> · Live MCP markdown resource
            </li>
          </ul>
        </div>
      </section>

      {/* Live MCP JSON-RPC 2.0 Inspector */}
      <section className="xl:col-span-6 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Live MCP JSON-RPC Inspector</h2>
            <p className="mt-1 text-xs text-slate-600">
              Invoke real Model Context Protocol calls directly against <span className="font-mono">POST /mcp</span>.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={running || simulating}
              onClick={runOpenCodeSessionTest}
              className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <Bot className="w-3.5 h-3.5" />
              {simulating ? 'Simulating...' : 'Run Agent E2E Session'}
            </button>
            <button
              type="button"
              disabled={running || simulating}
              onClick={() => executeMcpCall('tools/list')}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 whitespace-nowrap cursor-pointer"
            >
              List Tools (tools/list)
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label htmlFor="mcp-tool-select" className="block text-xs font-medium text-slate-700 mb-1">
              MCP Tool Name
            </label>
            <select
              id="mcp-tool-select"
              value={selectedTool}
              onChange={(e) => handleSelectTool(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg bg-white"
            >
              {MCP_TOOLS.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} — {t.description}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="mcp-tool-args" className="block text-xs font-medium text-slate-700 mb-1">
              Tool Arguments (JSON)
            </label>
            <textarea
              id="mcp-tool-args"
              rows={5}
              value={rpcArgsJson}
              onChange={(e) => setRpcArgsJson(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg"
            />
          </div>

          {rpcError && (
            <div role="alert" className="p-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg">
              {rpcError}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              disabled={running}
              onClick={() => executeMcpCall('tools/call')}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 inline-flex items-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {running ? 'Calling /mcp...' : 'Execute JSON-RPC'}
            </button>
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-slate-700 mb-2">JSON-RPC 2.0 Response</p>
          <pre
            data-testid="mcp-rpc-response"
            className="p-4 bg-slate-950 text-slate-100 rounded-lg text-xs font-mono overflow-x-auto max-h-72 leading-relaxed whitespace-pre-wrap"
          >
            {rpcResponse || '// Execute tools/list or tools/call to inspect live MCP server output'}
          </pre>
        </div>
      </section>
    </div>
  );
}
