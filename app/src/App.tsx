import { useMemo, useState } from 'react';
import { loadConfig } from './config';
import { useLineage } from './useLineage';
import { OverviewPage } from './pages/OverviewPage';
import { LineagePage } from './pages/LineagePage';
import { SettingsPage } from './pages/SettingsPage';
import { currentAccountName, signOut } from './services/auth';

type Tab = 'overview' | 'lineage';

/** A request to focus the lineage graph on a table/lakehouse (from Overview). */
export interface FocusRequest {
  /** Node id (`ns|name`) for a table, or a lakehouse id to show its tables. */
  target: string;
  kind: 'table' | 'lakehouse';
  /** Bumped each time so repeated requests re-trigger the effect. */
  ts: number;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'lineage', label: 'Lineage graph' },
];

/**
 * Single-page shell: dark header (title + database pill + Settings + Sign out)
 * and two tabs — Overview and Lineage graph — over one shared lineage snapshot.
 */
export function App() {
  const config = useMemo(() => loadConfig(), []);
  const [tab, setTab] = useState<Tab>('overview');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [focus, setFocus] = useState<FocusRequest>();

  const data = useLineage(autoRefresh);
  const account = currentAccountName();

  const explore = (target: string, kind: 'table' | 'lakehouse') => {
    setFocus({ target, kind, ts: Date.now() });
    setTab('lineage');
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <LineageGlyph />
          <span className="app-title">Column-level Lineage</span>
          {config.databaseName && <span className="db-pill">{config.databaseName}</span>}
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <button className="link-btn" onClick={() => setSettingsOpen(true)}>
            <GearGlyph /> Settings
          </button>
          <button className="link-btn" onClick={() => void signOut()} title={account}>
            Sign out
          </button>
        </div>
      </header>

      <main className="app-main">
        {tab === 'overview' && (
          <OverviewPage
            data={data}
            autoRefresh={autoRefresh}
            onAutoRefresh={setAutoRefresh}
            onExplore={explore}
          />
        )}
        {tab === 'lineage' && <LineagePage data={data} focus={focus} />}
      </main>

      {settingsOpen && (
        <div className="modal-overlay" onMouseDown={() => setSettingsOpen(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <SettingsPage onClose={() => setSettingsOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

function LineageGlyph() {
  return (
    <svg className="brand-glyph" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="6" r="2.4" />
      <circle cx="5" cy="18" r="2.4" />
      <circle cx="19" cy="12" r="2.4" />
      <path d="M7 6.6 Q14 9 17 11.2 M7 17.4 Q14 15 17 12.8" fill="none" strokeWidth="1.8" />
    </svg>
  );
}

function GearGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 4a7.5 7.5 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2l-.4-2.6H9.9l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7.5 7.5 0 0 0 3 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2l.4 2.6h4.2l.4-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />
    </svg>
  );
}
