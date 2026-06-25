import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadConfig } from '../config';
import type { LineageData } from '../useLineage';
import type { FocusRequest } from '../App';
import { FabricService } from '../services/fabricService';
import type { TableEdge, ColumnEdge, DatasetColumn, RunInfo } from '../services/lineageService';
import { parseDataset, lakehouseLabel } from '../utils/dataset';
import { lakehouseColor } from '../utils/colors';
import { notebookForJob, notebookNameForJob } from '../utils/notebook';
import { timeAgo, formatDateTime } from '../utils/format';
import { ShowCodeDrawer } from '../components/ShowCodeDrawer';
import { AccessCheckDrawer, type AccessOverlay } from '../components/AccessCheckDrawer';

const NODE_W = 210;
const HEADER_H = 46;
const ROW_H = 20;
const COL_GAP = 80;
const ROW_GAP = 30;
const COLS_PAD = 4;

const colKey = (id: string, col: string) => `${id}\u0000${col}`;

/** Workspace id parsed from an OpenLineage abfss namespace, if present. */
function workspaceOf(ns: string): string {
  const m = /abfss:\/\/([^@]+)@/i.exec(ns);
  return m ? m[1] : '';
}

interface NodeMeta {
  id: string;
  label: string;
  namespace: string;
  name: string;
  lakehouse: string;
  workspace: string;
  job?: string;
}
interface Placed extends NodeMeta {
  x: number;
  y: number;
  h: number;
  cols: DatasetColumn[];
}
interface Menu {
  x: number;
  y: number;
  nodeId: string;
}
interface Hover {
  x: number;
  y: number;
  nodeId: string;
}
interface HoverCol {
  nodeId: string;
  column: string;
}
interface CodePanel {
  table: string;
  notebook: string;
  source?: string;
}
interface Pos {
  x: number;
  y: number;
}

/** Lineage graph tab — interactive layered table/column lineage. */
export function LineagePage({ data, focus }: { data: LineageData; focus?: FocusRequest }) {
  const config = useMemo(() => loadConfig(), []);
  const fabric = useMemo(
    () => new FabricService(config.workspaceId, config.fabricPortalUrl),
    [config.workspaceId, config.fabricPortalUrl],
  );
  const { tableEdges, columnEdges, columns, runs, jobRuns, loading, error, configured, reload, lakehouseNames } =
    data;

  const [search, setSearch] = useState('');
  const [columnFilter, setColumnFilter] = useState('');
  const [colorBy, setColorBy] = useState<'flow' | 'lakehouse'>('flow');
  const [lakehouseFilter, setLakehouseFilter] = useState('');
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const [selected, setSelected] = useState<string>();
  const [menu, setMenu] = useState<Menu>();
  const [hover, setHover] = useState<Hover>();
  const [hoverCol, setHoverCol] = useState<HoverCol>();
  const [code, setCode] = useState<CodePanel>();
  const [access, setAccess] = useState<string>();
  const [accessOverlay, setAccessOverlay] = useState<AccessOverlay>();
  const [minimized, setMinimized] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [positions, setPositions] = useState<Map<string, Pos>>(new Map());
  const [zoom, setZoom] = useState(0.9);
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number }>();

  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  const pendingCenterRef = useRef<string | null>(null);
  const lastFocusTs = useRef(0);
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // All nodes (from every dataset that has columns, plus edge endpoints).
  const nodeMeta = useMemo(() => buildNodeMeta(tableEdges, columns), [tableEdges, columns]);

  // job per node (the latest job touching it) — used by Show code.
  const nodeJob = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of tableEdges) {
      if (e.jobName) {
        if (!m.has(e.dstId)) m.set(e.dstId, e.jobName);
        if (!m.has(e.srcId)) m.set(e.srcId, e.jobName);
      }
    }
    return m;
  }, [tableEdges]);

  // Latest run per notebook stem — used to show "Last run" on a node.
  const jobLastRun = useMemo(() => {
    const m = new Map<string, RunInfo>();
    const source = jobRuns.length ? jobRuns : runs;
    for (const r of source) {
      const stem = notebookNameForJob(r.jobName);
      if (!stem) continue;
      const cur = m.get(stem);
      const t = r.endTime ?? r.startTime ?? '';
      const ct = cur ? (cur.endTime ?? cur.startTime ?? '') : '';
      if (!cur || t > ct) m.set(stem, r);
    }
    return m;
  }, [jobRuns, runs]);

  const lastRunForNode = useCallback(
    (id: string): RunInfo | undefined => {
      const job = nodeJob.get(id);
      if (!job) return undefined;
      return jobLastRun.get(notebookNameForJob(job));
    },
    [nodeJob, jobLastRun],
  );

  const visibleNodeIds = useMemo(() => {
    const q = search.trim().toLowerCase();
    const passFilters = (id: string) => {
      const m = nodeMeta.get(id);
      if (!m) return false;
      if (lakehouseFilter && m.lakehouse !== lakehouseFilter) return false;
      if (workspaceFilter && m.workspace !== workspaceFilter) return false;
      return true;
    };
    const ids = [...nodeMeta.keys()].filter((id) => !hidden.has(id) && passFilters(id));
    if (!q) return new Set(ids);
    // Keep matches plus their direct neighbors for context.
    const base = new Set(ids);
    const match = new Set(ids.filter((id) => (nodeMeta.get(id)?.label ?? '').toLowerCase().includes(q)));
    for (const e of tableEdges) {
      if (match.has(e.srcId) && base.has(e.dstId)) match.add(e.dstId);
      if (match.has(e.dstId) && base.has(e.srcId)) match.add(e.srcId);
    }
    return new Set([...match]);
  }, [nodeMeta, hidden, search, tableEdges, lakehouseFilter, workspaceFilter]);

  // Distinct lakehouses / workspaces for the second filter row.
  const lakehouses = useMemo(() => {
    const s = new Set<string>();
    for (const m of nodeMeta.values()) if (m.lakehouse) s.add(m.lakehouse);
    return [...s].sort();
  }, [nodeMeta]);
  const workspaces = useMemo(() => {
    const s = new Set<string>();
    for (const m of nodeMeta.values()) if (m.workspace) s.add(m.workspace);
    return [...s].sort();
  }, [nodeMeta]);

  // Tables for the access-check drawer (id/label/lakehouse/workspace).
  const accessTables = useMemo(
    () =>
      [...nodeMeta.values()]
        .map((m) => ({
          id: m.id,
          label: m.label,
          lakehouse: lakehouseLabel(m.lakehouse, lakehouseNames),
          workspace: m.workspace,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [nodeMeta, lakehouseNames],
  );

  // Autosuggest sources for the toolbar inputs.
  const tableSuggestions = useMemo(() => {
    const s = new Set<string>();
    for (const m of nodeMeta.values()) if (m.label) s.add(m.label);
    return [...s].sort();
  }, [nodeMeta]);
  const columnSuggestions = useMemo(() => {
    const s = new Set<string>();
    for (const cols of columns.values()) for (const c of cols) if (c.name) s.add(c.name);
    return [...s].sort();
  }, [columns]);

  const visibleEdges = useMemo(
    () => tableEdges.filter((e) => visibleNodeIds.has(e.srcId) && visibleNodeIds.has(e.dstId)),
    [tableEdges, visibleNodeIds],
  );

  const colFilterLc = columnFilter.trim().toLowerCase();
  const layout = useMemo(
    () =>
      computeLayout(
        [...visibleNodeIds].map((id) => nodeMeta.get(id)!).filter(Boolean),
        visibleEdges,
        columns,
        minimized,
        nodeJob,
        colFilterLc,
      ),
    [visibleNodeIds, nodeMeta, visibleEdges, columns, minimized, nodeJob, colFilterLc],
  );

  const connected = useMemo(
    () => (selected ? relatedNodes(selected, visibleEdges) : undefined),
    [selected, visibleEdges],
  );

  // Effective node position: a manual (dragged) override, or the computed layout.
  const posOf = useCallback(
    (id: string): Pos | undefined => {
      const m = positions.get(id);
      if (m) return m;
      const p = layout.placed.get(id);
      return p ? { x: p.x, y: p.y } : undefined;
    },
    [positions, layout],
  );

  // Scroll-area size grows to contain dragged nodes.
  const bounds = useMemo(() => {
    let w = layout.width;
    let h = layout.height;
    for (const [id, p] of positions) {
      const placed = layout.placed.get(id);
      const nh = placed ? placed.h : HEADER_H;
      w = Math.max(w, p.x + NODE_W + 40);
      h = Math.max(h, p.y + nh + 40);
    }
    return { width: w, height: h };
  }, [layout, positions]);

  // Column-dependency closure for the hovered column (upstream + downstream).
  const colHi = useMemo(() => {
    if (!hoverCol) return undefined;
    const down = new Map<string, string[]>();
    const up = new Map<string, string[]>();
    for (const e of columnEdges) {
      const s = colKey(e.srcId, e.srcColumn);
      const d = colKey(e.dstId, e.dstColumn);
      (down.get(s) ?? down.set(s, []).get(s)!).push(d);
      (up.get(d) ?? up.set(d, []).get(d)!).push(s);
    }
    const start = colKey(hoverCol.nodeId, hoverCol.column);
    const keys = new Set<string>([start]);
    const walk = (adj: Map<string, string[]>) => {
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const nx of adj.get(cur) ?? []) {
          if (!keys.has(nx)) {
            keys.add(nx);
            stack.push(nx);
          }
        }
      }
    };
    walk(down);
    walk(up);
    const edges = columnEdges.filter(
      (e) => keys.has(colKey(e.srcId, e.srcColumn)) && keys.has(colKey(e.dstId, e.dstColumn)),
    );
    return { keys, edges };
  }, [hoverCol, columnEdges]);

  const closeMenu = useCallback(() => setMenu(undefined), []);
  useEffect(() => {
    if (!menu) return;
    const onDown = () => closeMenu();
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && closeMenu();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, closeMenu]);

  // Center the canvas viewport on a node (used by Explore / Isolate / focus).
  const centerNode = useCallback(
    (id: string) => {
      const el = scrollRef.current;
      const pos = posOf(id);
      const placed = layout.placed.get(id);
      if (!el || !pos || !placed) return;
      const z = zoomRef.current;
      el.scrollLeft = (pos.x + NODE_W / 2) * z - el.clientWidth / 2;
      el.scrollTop = (pos.y + placed.h / 2) * z - el.clientHeight / 2;
    },
    [posOf, layout],
  );

  // After a layout change, if a center request is pending, fulfil it.
  useEffect(() => {
    const id = pendingCenterRef.current;
    if (id && layout.placed.has(id)) {
      centerNode(id);
      pendingCenterRef.current = null;
    }
  }, [layout, centerNode]);

  // Wheel over the canvas zooms (centered on the cursor) instead of scrolling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const z1 = zoomRef.current;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const z2 = Math.min(2, Math.max(0.2, +(z1 * factor).toFixed(3)));
      if (z2 === z1) return;
      const contentX = (el.scrollLeft + px) / z1;
      const contentY = (el.scrollTop + py) / z1;
      setZoom(z2);
      requestAnimationFrame(() => {
        el.scrollLeft = contentX * z2 - px;
        el.scrollTop = contentY * z2 - py;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Focus request from the Overview tab: isolate to the target and center it.
  useEffect(() => {
    if (!focus || focus.ts === lastFocusTs.current) return;
    if (nodeMeta.size === 0) return; // data not loaded yet — retry when it is
    lastFocusTs.current = focus.ts;
    let keep: Set<string>;
    if (focus.kind === 'table') {
      if (!nodeMeta.has(focus.target)) return;
      keep = relatedNodes(focus.target, tableEdges);
      setSelected(focus.target);
      pendingCenterRef.current = focus.target;
    } else {
      keep = new Set(
        [...nodeMeta.keys()].filter((id) => nodeMeta.get(id)!.lakehouse === focus.target),
      );
      setSelected(undefined);
      pendingCenterRef.current = [...keep][0] ?? null;
    }
    setHidden(new Set([...nodeMeta.keys()].filter((id) => !keep.has(id))));
    setSearch('');
    setColumnFilter('');
    setLakehouseFilter('');
    setWorkspaceFilter('');
    setMinimized(new Set());
    setPositions(new Map());
  }, [focus, nodeMeta, tableEdges]);

  if (!configured) {
    return (
      <div className="card">
        <div className="message-bar">
          <strong>Eventhouse not configured</strong>
          <div>Open Settings and set the Eventhouse cluster URI and database name.</div>
        </div>
      </div>
    );
  }

  const toggleMin = (id: string) =>
    setMinimized((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const expandAll = () => setMinimized(new Set());
  const collapseAll = () => setMinimized(new Set(nodeMeta.keys()));
  const resetView = () => {
    setHidden(new Set());
    setMinimized(new Set());
    setPositions(new Map());
    setSelected(undefined);
    setMultiSel(new Set());
    setSearch('');
    setColumnFilter('');
  };
  const resetLayout = () => setPositions(new Map());
  const fitToScreen = () => {
    const el = scrollRef.current;
    if (!el) return;
    const z = Math.min(
      (el.clientWidth - 24) / bounds.width,
      (el.clientHeight - 24) / bounds.height,
      1.5,
    );
    setZoom(Math.max(0.2, +z.toFixed(2)));
  };

  // Drag a node by its header; suppresses the click-select that follows a drag.
  const startDrag = (ev: React.MouseEvent, id: string) => {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    const base = posOf(id);
    if (!base) return;
    dragRef.current = {
      id,
      startX: ev.clientX,
      startY: ev.clientY,
      baseX: base.x,
      baseY: base.y,
      moved: false,
    };
    const onMove = (m: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (m.clientX - d.startX) / zoom;
      const dy = (m.clientY - d.startY) / zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
      setPositions((p) => new Map(p).set(d.id, { x: d.baseX + dx, y: d.baseY + dy }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // keep `moved` until after the click handler runs, then clear.
      setTimeout(() => {
        dragRef.current = null;
      }, 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Pan the canvas by dragging the background with the right or middle button.
  const startPan = (ev: React.MouseEvent) => {
    if (ev.button !== 2 && ev.button !== 1) return;
    if ((ev.target as HTMLElement).closest('.gnode')) return; // node interactions win
    const el = scrollRef.current;
    if (!el) return;
    ev.preventDefault();
    panRef.current = { startX: ev.clientX, startY: ev.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.classList.add('panning');
    const onMove = (m: MouseEvent) => {
      const p = panRef.current;
      if (!p) return;
      el.scrollLeft = p.left - (m.clientX - p.startX);
      el.scrollTop = p.top - (m.clientY - p.startY);
    };
    const onUp = () => {
      panRef.current = null;
      el.classList.remove('panning');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Left-drag on the empty canvas draws a selection rectangle (marquee).
  const startMarquee = (ev: React.MouseEvent) => {
    if (ev.button !== 0) return;
    const target = ev.target as HTMLElement;
    if (target.closest('.gnode')) return; // node interactions win
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const z = zoomRef.current;
    const toContent = (cx: number, cy: number): Pos => ({
      x: (cx - rect.left + el.scrollLeft) / z,
      y: (cy - rect.top + el.scrollTop) / z,
    });
    const start = toContent(ev.clientX, ev.clientY);
    const end = { x: start.x, y: start.y };
    let moved = false;
    setMarquee({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });
    const onMove = (m: MouseEvent) => {
      const p = toContent(m.clientX, m.clientY);
      end.x = p.x;
      end.y = p.y;
      if (Math.abs(p.x - start.x) > 3 || Math.abs(p.y - start.y) > 3) moved = true;
      setMarquee({ x0: start.x, y0: start.y, x1: p.x, y1: p.y });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setMarquee(undefined);
      if (!moved) {
        // A plain click on empty canvas clears selection.
        setMultiSel(new Set());
        setSelected(undefined);
        return;
      }
      const x0 = Math.min(start.x, end.x);
      const y0 = Math.min(start.y, end.y);
      const x1 = Math.max(start.x, end.x);
      const y1 = Math.max(start.y, end.y);
      const hit = new Set<string>();
      for (const n of layout.placed.values()) {
        const pos = posOf(n.id);
        if (!pos) continue;
        if (pos.x < x1 && pos.x + NODE_W > x0 && pos.y < y1 && pos.y + n.h > y0) hit.add(n.id);
      }
      setMultiSel(hit);
      setSelected(hit.size ? [...hit][0] : undefined);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onCanvasMouseDown = (ev: React.MouseEvent) => {
    if (ev.button === 0) startMarquee(ev);
    else startPan(ev);
  };

  const neighbors = (id: string, dir: 'up' | 'down'): string[] => {
    const out: string[] = [];
    for (const e of tableEdges) {
      if (dir === 'down' && e.srcId === id) out.push(e.dstId);
      if (dir === 'up' && e.dstId === id) out.push(e.srcId);
    }
    return out;
  };
  const showNodes = (ids: string[]) =>
    setHidden((h) => {
      const n = new Set(h);
      ids.forEach((i) => n.delete(i));
      return n;
    });

  const onMenuAction = async (action: string, node: NodeMeta) => {
    closeMenu();
    switch (action) {
      case 'down1':
        showNodes(neighbors(node.id, 'down').slice(0, 1));
        break;
      case 'downAll':
        showNodes([...relatedNodes(node.id, tableEdges, 'down')]);
        break;
      case 'up1':
        showNodes(neighbors(node.id, 'up').slice(0, 1));
        break;
      case 'upAll':
        showNodes([...relatedNodes(node.id, tableEdges, 'up')]);
        break;
      case 'both':
        showNodes([...relatedNodes(node.id, tableEdges)]);
        break;
      case 'isolate': {
        // Show ONLY this table (drop all up/downstream) and center it.
        setHidden(new Set([...nodeMeta.keys()].filter((i) => i !== node.id)));
        setSelected(node.id);
        pendingCenterRef.current = node.id;
        break;
      }
      case 'delete':
        setHidden((h) => new Set(h).add(node.id));
        if (selected === node.id) setSelected(undefined);
        setHover(undefined);
        break;
      case 'reset':
        resetView();
        break;
      case 'collapse':
        toggleMin(node.id);
        break;
      case 'code': {
        const nb = notebookForJob(nodeJob.get(node.id));
        setCode({ table: node.label, notebook: nb.name, source: nb.source });
        break;
      }
      case 'lakehouse': {
        const portal = (config.fabricPortalUrl || 'https://app.fabric.microsoft.com').replace(/\/+$/, '');
        const ws = node.workspace || config.workspaceId;
        const url =
          node.lakehouse && node.lakehouse !== '(unspecified)'
            ? `${portal}/groups/${ws}/lakehouses/${node.lakehouse}`
            : `${portal}/groups/${ws}`;
        window.open(url, '_blank', 'noopener');
        break;
      }
      case 'access':
        setAccess(node.lakehouse || node.label);
        break;
      case 'monitoring': {
        const portal = (config.fabricPortalUrl || 'https://app.fabric.microsoft.com').replace(/\/+$/, '');
        window.open(`${portal}/monitoringhub`, '_blank', 'noopener');
        break;
      }
    }
  };

  const menuNode = menu ? nodeMeta.get(menu.nodeId) : undefined;
  const hoverNode = hover ? layout.placed.get(hover.nodeId) : undefined;

  /** Access state for a node under the current overlay: undefined when off. */
  const accessOf = (workspace: string): boolean | undefined =>
    accessOverlay ? !!accessOverlay.roleByWs.get(workspace || '') : undefined;

  const colAnchorY = (placed: Placed, py: number, col: string): number => {
    const idx = placed.cols.findIndex((c) => c.name === col);
    if (minimized.has(placed.id) || idx < 0) return py + HEADER_H / 2;
    return py + HEADER_H + COLS_PAD + idx * ROW_H + ROW_H / 2;
  };

  // Allowed / denied counts for the overlay legend banner (cheap; not memoized).
  let accAllowed = 0;
  let accDenied = 0;
  const accLakehouses: { lakehouse: string; allowed: boolean; tables: number }[] = [];
  if (accessOverlay) {
    for (const id of visibleNodeIds) {
      const m = nodeMeta.get(id);
      if (!m) continue;
      if (accessOf(m.workspace)) accAllowed++;
      else accDenied++;
    }
    // Group every table by its lakehouse to summarise access at the lakehouse level.
    const byLh = new Map<string, { lakehouse: string; allowed: boolean; tables: number }>();
    for (const m of nodeMeta.values()) {
      if (!m.lakehouse) continue;
      const label = lakehouseLabel(m.lakehouse, lakehouseNames);
      const cur = byLh.get(m.lakehouse) ?? {
        lakehouse: label,
        allowed: !!accessOf(m.workspace),
        tables: 0,
      };
      cur.tables++;
      byLh.set(m.lakehouse, cur);
    }
    accLakehouses.push(
      ...[...byLh.values()].sort(
        (a, b) => Number(b.allowed) - Number(a.allowed) || a.lakehouse.localeCompare(b.lakehouse),
      ),
    );
  }

  return (
    <div className="lineage">
      <div className="lin-toolbar">
        <span className="lin-logo">Lineage</span>
        <span className="pill">{visibleNodeIds.size} / {nodeMeta.size} tables</span>
        <input
          className="grow"
          placeholder="Search tables or columns…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          list="lin-table-suggest"
        />
        <datalist id="lin-table-suggest">
          {tableSuggestions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <input
          placeholder="Filter by column…"
          value={columnFilter}
          onChange={(e) => setColumnFilter(e.target.value)}
          list="lin-column-suggest"
        />
        <datalist id="lin-column-suggest">
          {columnSuggestions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <button className="btn secondary" onClick={expandAll}>Expand all</button>
        <button className="btn secondary" onClick={collapseAll}>Collapse all</button>
        <span className="muted">Color by</span>
        <select value={colorBy} onChange={(e) => setColorBy(e.target.value as 'flow' | 'lakehouse')}>
          <option value="flow">None (flow)</option>
          <option value="lakehouse">Lakehouse</option>
        </select>
        <button className="btn secondary" onClick={() => setAccess(lakehouseFilter || 'All lakehouses')}>
          ⛉ Access check
        </button>
        <button className="btn secondary" onClick={resetView}>Reset</button>
        <button className="btn secondary" onClick={reload} disabled={loading}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        <div className="zoom">
          <button className="icon-btn" onClick={fitToScreen} title="Fit to screen">⤡ Fit</button>
          <button className="icon-btn" onClick={resetLayout} title="Reset layout">Reset layout</button>
          <button className="icon-btn" onClick={() => setZoom((z) => Math.max(0.3, +(z - 0.1).toFixed(2)))}>−</button>
          <span className="muted">{Math.round(zoom * 100)}%</span>
          <button className="icon-btn" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))}>+</button>
          <button className="icon-btn" onClick={() => setZoom(0.9)} title="Reset zoom">⤢</button>
        </div>
      </div>

      <div className="lin-filters">
        <span className="muted">Lakehouse</span>
        <select value={lakehouseFilter} onChange={(e) => setLakehouseFilter(e.target.value)}>
          <option value="">All lakehouses</option>
          {lakehouses.map((lh) => (
            <option key={lh} value={lh}>{lakehouseLabel(lh, lakehouseNames)}</option>
          ))}
        </select>
        {lakehouseFilter && (
          <button className="link-btn small" onClick={() => setLakehouseFilter('')}>Clear lakehouse filter</button>
        )}
        <span className="muted">Workspace</span>
        <select value={workspaceFilter} onChange={(e) => setWorkspaceFilter(e.target.value)}>
          <option value="">All workspaces</option>
          {workspaces.map((ws) => (
            <option key={ws} value={ws}>{ws}</option>
          ))}
        </select>
        {workspaceFilter && (
          <button className="link-btn small" onClick={() => setWorkspaceFilter('')}>Clear workspace filter</button>
        )}
      </div>

      {accessOverlay && (
        <div className="access-legend">
          <span className="acc-ico">👤</span>
          <span className="acc-legend-name">{accessOverlay.name}</span>
          {accessOverlay.upn && <span className="muted">{accessOverlay.upn}</span>}
          <span className="acc-legend-chip allow">✓ {accAllowed} allowed</span>
          <span className="acc-legend-chip deny">✕ {accDenied} denied</span>
          <button className="btn secondary" onClick={() => setAccess(lakehouseFilter || 'All lakehouses')}>
            Change user
          </button>
          <button className="link-btn small" onClick={() => setAccessOverlay(undefined)}>
            Clear access check
          </button>
        </div>
      )}

      {error && (
        <div className="message-bar error">
          <strong>Could not load lineage</strong>
          <div>{error}</div>
        </div>
      )}

      {!loading && visibleNodeIds.size === 0 && !error && (
        <div className="message-bar">
          <strong>No tables to display</strong>
          <div>
            {nodeMeta.size === 0
              ? 'Run the medallion notebooks (bronze → silver → gold) at least once to emit OpenLineage events, then refresh.'
              : 'No tables match the current filters. Adjust the search or filters, or reset the view.'}
          </div>
        </div>
      )}

      <div className="lin-body">
        <div
          className="graph-scroll"
          ref={scrollRef}
          onMouseDown={onCanvasMouseDown}
          onContextMenu={(e) => {
            // Suppress the browser menu on the empty canvas (right-drag pans).
            if (!(e.target as HTMLElement).closest('.gnode')) e.preventDefault();
          }}
        >
          <div
            className="graph-scale"
            style={{ width: bounds.width * zoom, height: bounds.height * zoom }}
          >
            <div className="graph-inner" style={{ width: bounds.width, height: bounds.height, transform: `scale(${zoom})` }}>
              <svg className="edge-layer" width={bounds.width} height={bounds.height}>
                {visibleEdges.map((e, i) => {
                  const a = layout.placed.get(e.srcId);
                  const b = layout.placed.get(e.dstId);
                  const pa = posOf(e.srcId);
                  const pb = posOf(e.dstId);
                  if (!a || !b || !pa || !pb) return null;
                  const active = connected ? connected.has(e.srcId) && connected.has(e.dstId) : false;
                  const faded = (connected !== undefined && !active) || hoverCol !== undefined;
                  const x1 = pa.x + NODE_W;
                  const y1 = pa.y + HEADER_H / 2;
                  const x2 = pb.x;
                  const y2 = pb.y + HEADER_H / 2;
                  const dx = Math.max(40, (x2 - x1) / 2);
                  return (
                    <path
                      key={i}
                      d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke={active ? '#2899f5' : '#39414d'}
                      strokeWidth={active ? 2 : 1.25}
                      opacity={faded ? 0.12 : 1}
                    />
                  );
                })}

                {colHi?.edges.map((e, i) => {
                  const a = layout.placed.get(e.srcId);
                  const b = layout.placed.get(e.dstId);
                  const pa = posOf(e.srcId);
                  const pb = posOf(e.dstId);
                  if (!a || !b || !pa || !pb) return null;
                  const x1 = pa.x + NODE_W;
                  const y1 = colAnchorY(a, pa.y, e.srcColumn);
                  const x2 = pb.x;
                  const y2 = colAnchorY(b, pb.y, e.dstColumn);
                  const dx = Math.max(40, (x2 - x1) / 2);
                  return (
                    <path
                      key={`c-${i}`}
                      d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke="#d2a8ff"
                      strokeWidth={2}
                    />
                  );
                })}
              </svg>

              {[...layout.placed.values()].map((n) => {
                const pos = posOf(n.id)!;
                const isSel = n.id === selected || multiSel.has(n.id);
                const dim =
                  (connected !== undefined && !connected.has(n.id)) ||
                  (hoverCol !== undefined && !nodeHasHiCol(n, colHi));
                const accent = colorBy === 'lakehouse' ? lakehouseColor(n.lakehouse) : undefined;
                const acc = accessOf(n.workspace);
                const accClass = acc === undefined ? '' : acc ? ' acc-allow' : ' acc-deny';
                return (
                  <div
                    key={n.id}
                    className={`gnode${isSel ? ' sel' : ''}${dim ? ' dim' : ''}${accClass}`}
                    style={{ left: pos.x, top: pos.y, width: NODE_W }}
                    onClick={() => {
                      if (dragRef.current?.moved) return;
                      setMultiSel(new Set());
                      setSelected(n.id === selected ? undefined : n.id);
                    }}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      setSelected(n.id);
                      setMenu({ nodeId: n.id, x: ev.clientX, y: ev.clientY });
                    }}
                  >
                    <div
                      className="gnode-head"
                      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
                      onMouseDown={(ev) => startDrag(ev, n.id)}
                      onMouseEnter={(ev) => setHover({ nodeId: n.id, x: ev.clientX, y: ev.clientY })}
                      onMouseMove={(ev) => setHover({ nodeId: n.id, x: ev.clientX, y: ev.clientY })}
                      onMouseLeave={() => setHover(undefined)}
                      title="Drag to move"
                    >
                      <div className="gnode-title">{n.label}</div>
                      <div className="gnode-actions">
                        <span className="col-count">{n.cols.length} col</span>
                        <button
                          className="mini"
                          onMouseDown={(ev) => ev.stopPropagation()}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            toggleMin(n.id);
                          }}
                        >
                          {minimized.has(n.id) ? '+' : '–'}
                        </button>
                      </div>
                      <div className="gnode-sub" title={n.lakehouse}>
                        {lakehouseLabel(n.lakehouse, lakehouseNames)}
                      </div>
                    </div>
                    {!minimized.has(n.id) && (
                      <div className="gnode-cols">
                        {n.cols.map((c) => {
                          const hi = colHi?.keys.has(colKey(n.id, c.name));
                          const filterHit = colFilterLc && c.name.toLowerCase().includes(colFilterLc);
                          return (
                            <div
                              className={`gcol${filterHit ? ' hit' : ''}${hi ? ' col-hi' : ''}`}
                              key={c.name}
                              onMouseEnter={() => setHoverCol({ nodeId: n.id, column: c.name })}
                              onMouseLeave={() => setHoverCol(undefined)}
                            >
                              <span className="gcol-name">{c.name}</span>
                              <span className="gcol-type">{c.type}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {marquee && (
                <div
                  className="marquee"
                  style={{
                    left: Math.min(marquee.x0, marquee.x1),
                    top: Math.min(marquee.y0, marquee.y1),
                    width: Math.abs(marquee.x1 - marquee.x0),
                    height: Math.abs(marquee.y1 - marquee.y0),
                  }}
                />
              )}
            </div>
          </div>
        </div>

        {accessOverlay && accLakehouses.length > 0 && (
          <div className="access-summary">
            <div className="access-summary-head">
              <span>Lakehouse access</span>
              <button className="link-btn small" onClick={() => setAccessOverlay(undefined)}>
                Clear
              </button>
            </div>
            <div className="access-summary-user" title={accessOverlay.upn}>
              {accessOverlay.name}
            </div>
            <ul className="access-summary-list">
              {accLakehouses.map((lh) => (
                <li key={lh.lakehouse} className={lh.allowed ? 'allow' : 'deny'}>
                  <span className="acc-dot" />
                  <span className="acc-lh-name" title={lh.lakehouse}>{lh.lakehouse}</span>
                  <span className="acc-lh-meta">
                    {lh.allowed ? 'Access' : 'No access'} · {lh.tables} {lh.tables === 1 ? 'table' : 'tables'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {selected && nodeMeta.get(selected) && (
          <DetailPanel
            node={nodeMeta.get(selected)!}
            columns={columns.get(selected) ?? []}
            columnEdges={columnEdges}
            nodeMeta={nodeMeta}
            lakehouseLabelText={lakehouseLabel(nodeMeta.get(selected)!.lakehouse, lakehouseNames)}
            lastRun={lastRunForNode(selected)}
            onClose={() => setSelected(undefined)}
            onShowCode={() => {
              const node = nodeMeta.get(selected)!;
              const nb = notebookForJob(nodeJob.get(selected));
              setCode({ table: node.label, notebook: nb.name, source: nb.source });
            }}
            onCheckAccess={() => {
              const node = nodeMeta.get(selected)!;
              setAccess(node.lakehouse || node.label);
            }}
          />
        )}
      </div>

      {hover && hoverNode && (() => {
        const lastRun = lastRunForNode(hoverNode.id);
        return (
          <div className="node-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
            <strong>{hoverNode.label}</strong>
            <div>{hoverNode.cols.length} columns</div>
            <div className="muted">Lakehouse: {lakehouseLabel(hoverNode.lakehouse, lakehouseNames)}</div>
            {hoverNode.job && <div className="muted">Latest job: {shortJob(hoverNode.job)}</div>}
            {lastRun && (
              <div className="muted">
                Last run: {timeAgo(lastRun.endTime ?? lastRun.startTime)}
                {lastRun.status ? ` · ${lastRun.status}` : ''}
              </div>
            )}
            {lastRun && formatDateTime(lastRun.endTime ?? lastRun.startTime) && (
              <div className="muted">Updated: {formatDateTime(lastRun.endTime ?? lastRun.startTime)}</div>
            )}
          </div>
        );
      })()}

      {menu && menuNode && (() => {
        const downN = neighbors(menuNode.id, 'down').length;
        const upN = neighbors(menuNode.id, 'up').length;
        const dirty =
          hidden.size > 0 ||
          minimized.size > 0 ||
          positions.size > 0 ||
          !!selected ||
          !!search ||
          !!columnFilter ||
          !!lakehouseFilter ||
          !!workspaceFilter;
        const item = (action: string, label: string, disabled = false) => (
          <li
            className={disabled ? 'disabled' : undefined}
            onClick={disabled ? undefined : () => void onMenuAction(action, menuNode)}
          >
            {label}
          </li>
        );
        return (
          <ul className="context-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
            <li className="context-title">{menuNode.label}</li>
            {item('down1', `Expand 1 downstream (${downN})`, downN === 0)}
            {item('downAll', 'Expand all downstream', downN === 0)}
            {item('up1', `Expand 1 upstream (${upN})`, upN === 0)}
            {item('upAll', 'Expand all upstream', upN === 0)}
            {item('both', 'Expand all (both)', downN === 0 && upN === 0)}
            <li className="sep" />
            {item('isolate', 'Isolate this table')}
            {item('delete', 'Delete from view')}
            {item('reset', 'Reset view', !dirty)}
            {item('collapse', minimized.has(menuNode.id) ? 'Expand columns' : 'Collapse columns')}
            <li className="sep" />
            {item('code', 'Show code')}
            {item('lakehouse', 'Open lakehouse')}
            {item('monitoring', 'Open monitoring hub')}
          </ul>
        );
      })()}

      {code && (
        <ShowCodeDrawer
          table={code.table}
          notebook={code.notebook}
          source={code.source}
          onClose={() => setCode(undefined)}
        />
      )}

      {access && (
        <AccessCheckDrawer
          context={access}
          tables={accessTables}
          fabric={fabric}
          onApply={setAccessOverlay}
          onClose={() => setAccess(undefined)}
        />
      )}
    </div>
  );
}

/** True when a node contains at least one column in the hovered closure. */
function nodeHasHiCol(node: Placed, colHi?: { keys: Set<string> }): boolean {
  if (!colHi) return false;
  return node.cols.some((c) => colHi.keys.has(colKey(node.id, c.name)));
}

function shortJob(job: string): string {
  return job.length > 60 ? job.slice(0, 59) + '…' : job;
}

/** Side panel: selected table's columns + column-level lineage. */
function DetailPanel({
  node,
  columns,
  columnEdges,
  nodeMeta,
  lakehouseLabelText,
  lastRun,
  onClose,
  onShowCode,
  onCheckAccess,
}: {
  node: NodeMeta;
  columns: DatasetColumn[];
  columnEdges: ColumnEdge[];
  nodeMeta: Map<string, NodeMeta>;
  lakehouseLabelText: string;
  lastRun?: RunInfo;
  onClose: () => void;
  onShowCode: () => void;
  onCheckAccess: () => void;
}) {
  const incoming = columnEdges.filter((e) => e.dstId === node.id);
  const outgoing = columnEdges.filter((e) => e.srcId === node.id);
  const label = (id: string) => nodeMeta.get(id)?.label ?? id.split('|').pop() ?? id;

  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <div>
          <div className="detail-title">{node.label}</div>
          <div className="muted detail-sub" title={node.name}>{lakehouseLabelText}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {lastRun && (
        <div className="detail-lastrun muted">
          Last run {timeAgo(lastRun.endTime ?? lastRun.startTime)}
          {lastRun.status ? ` · ${lastRun.status}` : ''}
          {formatDateTime(lastRun.endTime ?? lastRun.startTime) && (
            <div className="detail-lastrun-abs">
              Updated {formatDateTime(lastRun.endTime ?? lastRun.startTime)}
            </div>
          )}
        </div>
      )}

      <button className="btn secondary full" onClick={onShowCode}>&lt;/&gt; Show code</button>
      <button className="btn secondary full" onClick={onCheckAccess}>Check lakehouse access</button>

      <h4>Columns ({columns.length})</h4>
      {columns.length === 0 && <div className="muted">No schema captured for this table yet.</div>}
      {columns.length > 0 && (
        <ul className="col-list">
          {columns.map((c) => (
            <li key={c.name}>
              <span className="col-name">{c.name}</span>
              {c.type && <span className="col-type">{c.type}</span>}
            </li>
          ))}
        </ul>
      )}

      {(incoming.length > 0 || outgoing.length > 0) && (
        <>
          <h4>Column lineage</h4>
          {incoming.length > 0 && (
            <div className="col-edges">
              <div className="muted col-edges-head">Incoming</div>
              {incoming.map((e, i) => (
                <div key={`in-${i}`} className="col-edge">
                  <span className="muted">{label(e.srcId)}.</span>
                  {e.srcColumn} → <strong>{e.dstColumn}</strong>
                </div>
              ))}
            </div>
          )}
          {outgoing.length > 0 && (
            <div className="col-edges">
              <div className="muted col-edges-head">Outgoing</div>
              {outgoing.map((e, i) => (
                <div key={`out-${i}`} className="col-edge">
                  <strong>{e.srcColumn}</strong> → <span className="muted">{label(e.dstId)}.</span>
                  {e.dstColumn}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </aside>
  );
}

// --- graph helpers ---

function buildNodeMeta(
  edges: TableEdge[],
  columns: Map<string, DatasetColumn[]>,
): Map<string, NodeMeta> {
  const m = new Map<string, NodeMeta>();
  const add = (id: string, ns: string, name: string) => {
    if (m.has(id)) return;
    const { lakehouse, table } = parseDataset(ns, name);
    m.set(id, { id, label: table || name, namespace: ns, name, lakehouse, workspace: workspaceOf(ns) });
  };
  for (const e of edges) {
    add(e.srcId, e.srcNamespace, e.srcName);
    add(e.dstId, e.dstNamespace, e.dstName);
  }
  for (const id of columns.keys()) {
    if (m.has(id)) continue;
    const [ns, name] = id.split('|');
    add(id, ns ?? '', name ?? '');
  }
  return m;
}

/** Upstream + downstream (or one direction) closure of a node over edges. */
function relatedNodes(start: string, edges: TableEdge[], dir?: 'up' | 'down'): Set<string> {
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const e of edges) {
    down.set(e.srcId, [...(down.get(e.srcId) ?? []), e.dstId]);
    up.set(e.dstId, [...(up.get(e.dstId) ?? []), e.srcId]);
  }
  const result = new Set<string>([start]);
  const walk = (adj: Map<string, string[]>) => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const next of adj.get(cur) ?? []) {
        if (!result.has(next)) {
          result.add(next);
          stack.push(next);
        }
      }
    }
  };
  if (dir !== 'down') walk(up);
  if (dir !== 'up') walk(down);
  return result;
}

function computeLayout(
  nodes: NodeMeta[],
  edges: TableEdge[],
  columns: Map<string, DatasetColumn[]>,
  minimized: Set<string>,
  nodeJob: Map<string, string>,
  colFilter: string,
): { placed: Map<string, Placed>; width: number; height: number } {
  const incoming = new Map<string, string[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (ids.has(e.srcId) && ids.has(e.dstId)) {
      incoming.set(e.dstId, [...(incoming.get(e.dstId) ?? []), e.srcId]);
    }
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = (incoming.get(id) ?? []).filter((p) => ids.has(p));
    const d = parents.length ? Math.max(...parents.map((p) => depthOf(p) + 1)) : 0;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  const byCol = new Map<number, NodeMeta[]>();
  let maxCol = 0;
  for (const n of nodes) {
    const d = depthOf(n.id);
    maxCol = Math.max(maxCol, d);
    byCol.set(d, [...(byCol.get(d) ?? []), n]);
  }

  const nodeHeight = (id: string): number => {
    if (minimized.has(id)) return HEADER_H;
    let cols = columns.get(id) ?? [];
    if (colFilter) cols = cols.filter((c) => c.name.toLowerCase().includes(colFilter));
    return HEADER_H + Math.max(0, cols.length) * ROW_H + (cols.length ? 8 : 0);
  };

  const placed = new Map<string, Placed>();
  let width = 0;
  let height = 0;
  for (let c = 0; c <= maxCol; c++) {
    const colNodes = (byCol.get(c) ?? []).sort((a, b) => a.label.localeCompare(b.label));
    const x = 20 + c * (NODE_W + COL_GAP);
    let y = 20;
    for (const n of colNodes) {
      let cols = columns.get(n.id) ?? [];
      if (colFilter) cols = cols.filter((cc) => cc.name.toLowerCase().includes(colFilter));
      const h = nodeHeight(n.id);
      placed.set(n.id, { ...n, x, y, h, cols, job: nodeJob.get(n.id) });
      y += h + ROW_GAP;
    }
    width = Math.max(width, x + NODE_W + 20);
    height = Math.max(height, y);
  }
  return { placed, width: Math.max(width, 640), height: Math.max(height, 320) };
}
