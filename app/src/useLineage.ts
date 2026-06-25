import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadConfig, isConfigured } from './config';
import {
  LineageService,
  type TableEdge,
  type ColumnEdge,
  type LineageStats,
  type RunInfo,
  type DatasetColumn,
} from './services/lineageService';
import { FabricService } from './services/fabricService';

export interface LineageData {
  stats?: LineageStats;
  tableEdges: TableEdge[];
  columnEdges: ColumnEdge[];
  columns: Map<string, DatasetColumn[]>;
  runs: RunInfo[];
  /** Latest run per job (one row per job_name) — for per-table "last run". */
  jobRuns: RunInfo[];
  /** Lakehouse GUID (lower-case) → friendly display name (best-effort). */
  lakehouseNames: Map<string, string>;
  loading: boolean;
  error?: string;
  loadedAt?: Date;
  configured: boolean;
  reload: () => void;
}

/** Loads the full lineage snapshot once and (optionally) auto-refreshes. */
export function useLineage(autoRefresh: boolean): LineageData {
  const config = useMemo(() => loadConfig(), []);
  const configured = isConfigured(config);
  const svc = useMemo(
    () => new LineageService(config.clusterUri, config.databaseName),
    [config.clusterUri, config.databaseName],
  );
  const fabric = useMemo(
    () => new FabricService(config.workspaceId, config.fabricPortalUrl),
    [config.workspaceId, config.fabricPortalUrl],
  );

  const [stats, setStats] = useState<LineageStats>();
  const [tableEdges, setTableEdges] = useState<TableEdge[]>([]);
  const [columnEdges, setColumnEdges] = useState<ColumnEdge[]>([]);
  const [columns, setColumns] = useState<Map<string, DatasetColumn[]>>(new Map());
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [jobRuns, setJobRuns] = useState<RunInfo[]>([]);
  const [lakehouseNames, setLakehouseNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [loadedAt, setLoadedAt] = useState<Date>();
  const inFlight = useRef(false);
  const namesEscalated = useRef(false);

  const resolveNames = useCallback(() => {
    // First try the silent map (never prompts). If it comes back empty and we
    // have not yet tried once, escalate to an interactive acquire — this fixes
    // returning users whose Fabric consent predates the current scopes.
    void fabric
      .getLakehouseNamesSilent()
      .then((m) => {
        if (m.size) {
          setLakehouseNames(m);
          return;
        }
        if (namesEscalated.current) return;
        namesEscalated.current = true;
        void fabric
          .getLakehouseNames()
          .then((mm) => mm.size && setLakehouseNames(mm))
          .catch(() => undefined);
      })
      .catch(() => undefined);
  }, [fabric]);

  const reload = useCallback(async () => {
    if (!configured || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const [s, e, c, cols, r, jr] = await Promise.all([
        svc.getStats(),
        svc.getTableEdges(),
        svc.getColumnEdges(),
        svc.getAllColumns(),
        svc.getRecentRuns(30),
        svc.getLastRunPerJob().catch(() => [] as RunInfo[]),
      ]);
      setStats(s);
      setTableEdges(e.edges);
      setColumnEdges(c);
      setColumns(cols);
      setRuns(r);
      setJobRuns(jr);
      setLoadedAt(new Date());
      resolveNames();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [svc, configured, resolveNames]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!autoRefresh || !configured) return;
    const id = setInterval(() => void reload(), 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, configured, reload]);

  return {
    stats,
    tableEdges,
    columnEdges,
    columns,
    runs,
    jobRuns,
    lakehouseNames,
    loading,
    error,
    loadedAt,
    configured,
    reload: () => void reload(),
  };
}
