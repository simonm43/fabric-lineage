import { useMemo, useState } from 'react';
import type { LineageData } from '../useLineage';
import { parseDataset, lakehouseLabel } from '../utils/dataset';
import { shortLabel, timeAgo, formatDateTime } from '../utils/format';
import { statusColor } from '../theme';
import { lakehouseColor } from '../utils/colors';
import { loadConfig } from '../config';

type ExploreFn = (target: string, kind: 'table' | 'lakehouse') => void;

/** Overview tab — health, lakehouse tree, top tables, activity and recent runs. */
export function OverviewPage({
  data,
  autoRefresh,
  onAutoRefresh,
  onExplore,
}: {
  data: LineageData;
  autoRefresh: boolean;
  onAutoRefresh: (on: boolean) => void;
  onExplore: ExploreFn;
}) {
  const { stats, tableEdges, columns, runs, loading, error, loadedAt, configured, lakehouseNames } =
    data;

  if (!configured) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Overview</h2>
        <div className="message-bar">
          <strong>Eventhouse not configured</strong>
          <div>
            Open <strong>Settings</strong> and set the Eventhouse cluster URI and KQL database
            name first.
          </div>
        </div>
      </div>
    );
  }

  const successRate =
    stats && stats.runs > 0 ? Math.round((stats.succeeded / stats.runs) * 100) : 100;
  const healthy = !stats || stats.failed === 0;

  return (
    <div className="overview">
      <div className="page-head">
        <h1>Overview</h1>
        <div className="page-head-actions">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => onAutoRefresh(e.target.checked)}
            />
            Auto-refresh (30s)
          </label>
          <button
            className="link-btn"
            onClick={() => {
              const portal = (loadConfig().fabricPortalUrl || 'https://app.fabric.microsoft.com').replace(
                /\/+$/,
                '',
              );
              window.open(`${portal}/monitoringhub`, '_blank', 'noopener');
            }}
          >
            Open Monitoring hub
          </button>
        </div>
      </div>

      {error && (
        <div className="message-bar error">
          <strong>Could not load lineage</strong>
          <div>{error}</div>
        </div>
      )}

      <section className="stat-band">
        <div className="health">
          <div className={`health-pill${healthy ? '' : ' warn'}`}>
            <span className="dot" /> {healthy ? 'Healthy' : 'Attention'}
          </div>
          <div className="health-rate">{successRate}%</div>
          <div className="muted">Run success rate</div>
          <div className="progress">
            <span style={{ width: `${successRate}%` }} />
          </div>
        </div>
        <div className="stat-cells">
          <StatCell label="Tables" value={stats?.tables} />
          <StatCell label="Columns" value={stats?.columns} />
          <StatCell
            label="Edges"
            value={stats?.tableEdges}
            sub={stats ? `${stats.columnEdges} column` : undefined}
          />
          <StatCell
            label="Runs"
            value={stats?.runs}
            sub={stats ? `${stats.succeeded}✓ ${stats.failed}✕` : undefined}
          />
          <div className="stat-cell">
            <div className="stat-cell-label">Last activity</div>
            <div className="stat-cell-value">{stats?.lastRun ? timeAgo(stats.lastRun) : '—'}</div>
            {stats?.lastRun && formatDateTime(stats.lastRun) && (
              <div className="stat-cell-sub muted">{formatDateTime(stats.lastRun)}</div>
            )}
          </div>
        </div>
        <div className="stat-refresh">
          <button className="btn" onClick={data.reload} disabled={loading}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
          {loadedAt && (
            <div className="muted snapshot">Snapshot loaded {loadedAt.toLocaleTimeString()}</div>
          )}
        </div>
      </section>

      <div className="overview-body">
        <div className="overview-left">
          <LakehouseTree columns={columns} onExplore={onExplore} lakehouseNames={lakehouseNames} />
        </div>
        <div className="overview-right">
          <TopTables edges={tableEdges} />
          <Activity runs={runs} />
        </div>
      </div>

      <RecentRuns runs={runs} />
    </div>
  );
}

function StatCell({ label, value, sub }: { label: string; value?: number; sub?: string }) {
  return (
    <div className="stat-cell">
      <div className="stat-cell-label">{label}</div>
      <div className="stat-cell-value">{value?.toLocaleString() ?? '—'}</div>
      {sub && <div className="stat-cell-sub muted">{sub}</div>}
    </div>
  );
}

interface TreeTable {
  id: string;
  table: string;
  cols: number;
}
interface TreeSchema {
  schema: string;
  tables: TreeTable[];
  cols: number;
}
interface TreeLakehouse {
  lakehouse: string;
  schemas: TreeSchema[];
  tableCount: number;
  cols: number;
}

function buildTree(columns: Map<string, { name: string }[]>): TreeLakehouse[] {
  const lakehouses = new Map<string, Map<string, Map<string, { id: string; cols: number }>>>();
  for (const [id, cols] of columns) {
    const [ns, name] = id.split('|');
    const { lakehouse, schema, table } = parseDataset(ns ?? '', name ?? '');
    if (!lakehouses.has(lakehouse)) lakehouses.set(lakehouse, new Map());
    const schemas = lakehouses.get(lakehouse)!;
    if (!schemas.has(schema)) schemas.set(schema, new Map());
    schemas.get(schema)!.set(table, { id, cols: cols.length });
  }
  const result: TreeLakehouse[] = [];
  for (const [lakehouse, schemas] of lakehouses) {
    const schemaList: TreeSchema[] = [];
    let tableCount = 0;
    let lhCols = 0;
    for (const [schema, tables] of schemas) {
      const tableList: TreeTable[] = [];
      let schemaCols = 0;
      for (const [table, info] of tables) {
        tableList.push({ id: info.id, table, cols: info.cols });
        schemaCols += info.cols;
      }
      tableList.sort((a, b) => a.table.localeCompare(b.table));
      schemaList.push({ schema, tables: tableList, cols: schemaCols });
      tableCount += tableList.length;
      lhCols += schemaCols;
    }
    schemaList.sort((a, b) => a.schema.localeCompare(b.schema));
    result.push({ lakehouse, schemas: schemaList, tableCount, cols: lhCols });
  }
  result.sort((a, b) => a.lakehouse.localeCompare(b.lakehouse));
  return result;
}

function LakehouseTree({
  columns,
  onExplore,
  lakehouseNames,
}: {
  columns: Map<string, { name: string }[]>;
  onExplore: ExploreFn;
  lakehouseNames: Map<string, string>;
}) {
  const tree = useMemo(() => buildTree(columns), [columns]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; target: string; kind: 'table' | 'lakehouse'; label: string }>();
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const openMenu = (e: React.MouseEvent, target: string, kind: 'table' | 'lakehouse', label: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, target, kind, label });
  };

  return (
    <div className="panel" onClick={() => menu && setMenu(undefined)}>
      <div className="panel-head">
        <h3>Lakehouses &amp; schemas</h3>
        <span className="muted">
          Drill into each lakehouse to inspect schemas and tables. Right-click a table or
          lakehouse to explore its lineage.
        </span>
      </div>
      {tree.length === 0 && <div className="muted pad">No datasets captured yet.</div>}
      {tree.map((lh) => {
        const lhOpen = open[lh.lakehouse] ?? true;
        const lhLabel = lakehouseLabel(lh.lakehouse, lakehouseNames);
        return (
          <div className="tree-lh" key={lh.lakehouse}>
            <button
              className="tree-row"
              onClick={() => toggle(lh.lakehouse)}
              onContextMenu={(e) => openMenu(e, lh.lakehouse, 'lakehouse', lhLabel)}
            >
              <span className={`chev${lhOpen ? ' open' : ''}`}>▸</span>
              <span className="dot" style={{ background: lakehouseColor(lh.lakehouse) }} />
              <strong>{lhLabel}</strong>
              <span className="pill">{lh.schemas.length} schema</span>
              <span className="pill">{lh.tableCount} tables</span>
              <span className="pill ghost">{lh.cols} cols</span>
            </button>
            {lhOpen &&
              lh.schemas.map((s) => {
                const key = `${lh.lakehouse}/${s.schema}`;
                const sOpen = open[key] ?? false;
                return (
                  <div className="tree-schema" key={key}>
                    <button className="tree-row indent" onClick={() => toggle(key)}>
                      <span className={`chev${sOpen ? ' open' : ''}`}>▸</span>
                      <span>{s.schema}</span>
                      <span className="pill">{s.tables.length} tables</span>
                      <span className="pill ghost">{s.cols} cols</span>
                    </button>
                    {sOpen &&
                      s.tables.map((t) => (
                        <button
                          className="tree-row indent2 table-row"
                          key={t.id}
                          onClick={() => onExplore(t.id, 'table')}
                          onContextMenu={(e) => openMenu(e, t.id, 'table', t.table)}
                          title="Click or right-click to explore lineage"
                        >
                          <span className="table-name">{t.table}</span>
                          <span className="pill ghost">{t.cols} cols</span>
                        </button>
                      ))}
                  </div>
                );
              })}
          </div>
        );
      })}

      {menu && (
        <ul
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <li className="context-title">{menu.label}</li>
          <li
            onClick={() => {
              onExplore(menu.target, menu.kind);
              setMenu(undefined);
            }}
          >
            Explore lineage
          </li>
        </ul>
      )}
    </div>
  );
}

function TopTables({ edges }: { edges: { srcId: string; dstId: string; srcLabel: string; dstLabel: string }[] }) {
  const top = useMemo(() => {
    const inDeg = new Map<string, number>();
    const outDeg = new Map<string, number>();
    const label = new Map<string, string>();
    for (const e of edges) {
      outDeg.set(e.srcId, (outDeg.get(e.srcId) ?? 0) + 1);
      inDeg.set(e.dstId, (inDeg.get(e.dstId) ?? 0) + 1);
      label.set(e.srcId, e.srcLabel);
      label.set(e.dstId, e.dstLabel);
    }
    const ids = new Set([...inDeg.keys(), ...outDeg.keys()]);
    return [...ids]
      .map((id) => ({
        id,
        label: label.get(id) ?? shortLabel(id),
        in: inDeg.get(id) ?? 0,
        out: outDeg.get(id) ?? 0,
      }))
      .sort((a, b) => b.in + b.out - (a.in + a.out))
      .slice(0, 10);
  }, [edges]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Top tables by impact</h3>
        <span className="muted">Most connected (incoming + outgoing edges).</span>
      </div>
      {top.length === 0 && <div className="muted pad">No edges yet.</div>}
      {top.map((t) => (
        <div className="top-row" key={t.id}>
          <span className="dot" style={{ background: lakehouseColor(t.label) }} />
          <span className="top-name">{t.label}</span>
          <span className="muted top-deg">↑{t.in} ↓{t.out}</span>
        </div>
      ))}
    </div>
  );
}

function Activity({ runs }: { runs: { startTime?: string; endTime?: string }[] }) {
  const days = 14;
  const buckets = useMemo(() => {
    const out = new Array(days).fill(0);
    const now = Date.now();
    for (const r of runs) {
      const t = r.endTime || r.startTime;
      if (!t) continue;
      const ageDays = Math.floor((now - new Date(t).getTime()) / 86_400_000);
      if (ageDays >= 0 && ageDays < days) out[days - 1 - ageDays] += 1;
    }
    return out;
  }, [runs]);
  const total = buckets.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...buckets);
  const w = 240;
  const h = 60;
  const step = w / (days - 1);
  const pts = buckets.map((v, i) => `${i * step},${h - (v / max) * (h - 6) - 2}`);
  const area = `0,${h} ${pts.join(' ')} ${w},${h}`;

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Activity</h3>
        <span className="muted">last {days} days · {total} runs</span>
      </div>
      <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <polygon points={area} fill="rgba(40,153,245,0.18)" />
        <polyline points={pts.join(' ')} fill="none" stroke="#2899f5" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

function RecentRuns({ runs }: { runs: { runId: string; jobName: string; status: string; startTime?: string; endTime?: string }[] }) {
  if (runs.length === 0) return null;
  return (
    <div className="panel recent">
      <div className="panel-head">
        <h3>Recent runs</h3>
        <span className="muted">30 most recent</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Status</th>
            <th>Started</th>
            <th>Ended</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.runId}>
              <td className="job-cell" title={r.jobName}>{r.jobName}</td>
              <td>
                <span className="status-pill" style={{ color: statusColor(r.status) }}>
                  {r.status}
                </span>
              </td>
              <td className="muted">{r.startTime ? timeAgo(r.startTime) : '—'}</td>
              <td className="muted">{r.endTime ? timeAgo(r.endTime) : '—'}</td>
              <td className="muted">{duration(r.startTime, r.endTime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function duration(start?: string, end?: string): string {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
