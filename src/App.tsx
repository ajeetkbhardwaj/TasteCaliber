import { useCallback, useEffect, useState } from 'react';
import {
  Layers,
  BookOpen,
  FlaskConical,
  Cpu,
  Plug,
  Menu,
  X,
  Plus,
} from 'lucide-react';
import { OverviewData } from './types/api';
import { OverviewView } from './components/OverviewView';
import { ProfileView } from './components/ProfileView';
import { SignalLabView } from './components/SignalLabView';
import { ProvidersView } from './components/ProvidersView';
import { McpConnectView } from './components/McpConnectView';
import { TasteScope } from './engine/types';

type ActiveTab = 'overview' | 'profile' | 'signals' | 'providers' | 'mcp';

const NAV_ITEMS: Array<{ id: ActiveTab; label: string; icon: typeof Layers }> = [
  { id: 'overview', label: 'Overview', icon: Layers },
  { id: 'profile', label: 'Taste Profile', icon: BookOpen },
  { id: 'signals', label: 'Signal Lab', icon: FlaskConical },
  { id: 'providers', label: 'Providers', icon: Cpu },
  { id: 'mcp', label: 'MCP Connect', icon: Plug },
];

function readHashTab(): ActiveTab {
  if (typeof window === 'undefined') return 'overview';
  const h = window.location.hash.replace(/^#/, '') as ActiveTab;
  return NAV_ITEMS.some((n) => n.id === h) ? h : 'overview';
}

export default function App() {
  const [activeTab, setActiveTabState] = useState<ActiveTab>(readHashTab);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setActiveTab = useCallback((tab: ActiveTab) => {
    setActiveTabState(tab);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${tab}`);
    }
  }, []);

  const fetchOverview = useCallback(async () => {
    try {
      const res = await fetch('/api/overview');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as OverviewData;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load TasteCaliber workspace');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  useEffect(() => {
    const onHashChange = () => setActiveTabState(readHashTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleFeedback = async (learningId: string, feedback: 'accept' | 'reject') => {
    await fetch(`/api/learnings/${learningId}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback }),
    });
    await fetchOverview();
  };

  const handleResolveConflict = async (
    learningId: string,
    resolution: 'keep_existing' | 'accept_new' | 'keep_both',
  ) => {
    await fetch(`/api/learnings/${learningId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution }),
    });
    await fetchOverview();
  };

  const handleSyncPackages = async (
    action: 'push' | 'pull',
    fromScope: TasteScope,
    toScope: TasteScope,
  ) => {
    await fetch('/api/packages/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, fromScope, toScope }),
    });
    await fetchOverview();
  };

  const activeNavLabel = NAV_ITEMS.find((n) => n.id === activeTab)?.label ?? 'Overview';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-white border-r border-slate-200">
        <div className="h-16 px-6 flex items-center border-b border-slate-200">
          <a
            href="#overview"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('overview');
            }}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            TasteCaliber
          </a>
        </div>

        <nav aria-label="Primary navigation" className="flex-1 px-3 py-5 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 text-xs text-slate-500 space-y-1">
          <p className="font-medium text-slate-700">Local SQLite Storage</p>
          <p className="font-mono text-[11px] truncate">data/taste.db · WAL</p>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative z-50 w-64 bg-white h-full border-r border-slate-200 flex flex-col">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200">
              <span className="text-lg font-bold tracking-tight text-slate-900">TasteCaliber</span>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 text-slate-500 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav aria-label="Mobile navigation" className="p-3 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg whitespace-nowrap cursor-pointer ${
                      isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-8 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm truncate">
              <span className="text-slate-400 hidden sm:inline">TasteCaliber</span>
              <span className="text-slate-300 hidden sm:inline">/</span>
              <h1 className="font-semibold text-slate-900 truncate">{activeNavLabel}</h1>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setActiveTab('signals')}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Record Signal
          </button>
        </header>

        <main className="flex-1 p-4 sm:p-8 max-w-[1280px] w-full mx-auto">
          {loading && !data ? (
            <div className="space-y-4">
              <div className="h-24 bg-white border border-slate-200 rounded-lg animate-pulse" />
              <div className="h-64 bg-white border border-slate-200 rounded-lg animate-pulse" />
            </div>
          ) : error && !data ? (
            <div role="alert" className="p-6 bg-white border border-red-200 rounded-lg text-sm text-red-800">
              {error}
            </div>
          ) : data ? (
            <>
              {activeTab === 'overview' && (
                <OverviewView data={data} onNavigate={setActiveTab} onRefresh={fetchOverview} />
              )}
              {activeTab === 'profile' && (
                <ProfileView
                  learnings={data.learnings}
                  packages={data.packages}
                  lintResults={data.lintResults}
                  onFeedback={handleFeedback}
                  onResolveConflict={handleResolveConflict}
                  onSyncPackages={handleSyncPackages}
                  onRefresh={fetchOverview}
                />
              )}
              {activeTab === 'signals' && <SignalLabView onSignalProcessed={fetchOverview} />}
              {activeTab === 'providers' && (
                <ProvidersView
                  providers={data.providers}
                  nvidiaFastModels={data.nvidiaFastModels}
                  openRouterFreeModels={data.openRouterFreeModels}
                  metaRlConfig={data.metaRlConfig}
                  onRefresh={fetchOverview}
                />
              )}
              {activeTab === 'mcp' && <McpConnectView onSignalProcessed={fetchOverview} />}
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
