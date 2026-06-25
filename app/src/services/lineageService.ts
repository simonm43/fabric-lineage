/**
 * LineageService — queries the Eventhouse (Kusto) for OpenLineage data.
 *
 * Backing KQL stored functions (in database `lineage_eh`):
 *   lin_table_edges_active(), lin_column_edges_active(), lin_runs(), lin_datasets()
 */
import { getKustoToken, TokenError } from './auth';
import { authErrorMessage, shortLabel, toCount, toDate } from '../utils/format';

function uuid(): string {
  return (crypto as Crypto & { randomUUID?: () => string }).randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}

interface KustoColumn {
  ColumnName: string;
  ColumnType?: string;
}
interface KustoTable {
  TableName?: string;
  Columns?: KustoColumn[];
  Rows?: unknown[][];
}
interface KustoResponse {
  Tables?: KustoTable[];
}
interface QueryResult {
  columns: KustoColumn[];
  rows: unknown[][];
}

export interface TableEdge {
  srcId: string;
  dstId: string;
  srcLabel: string;
  dstLabel: string;
  srcNamespace: string;
  srcName: string;
  dstNamespace: string;
  dstName: string;
  jobName?: string;
}
export interface ColumnEdge {
  srcId: string;
  dstId: string;
  srcColumn: string;
  dstColumn: string;
  transformation?: string;
}
export interface DatasetColumn {
  name: string;
  type?: string;
  description?: string;
}
export interface LineageStats {
  tables: number;
  columns: number;
  tableEdges: number;
  columnEdges: number;
  runs: number;
  succeeded: number;
  failed: number;
  aborted: number;
  running: number;
  lastRun?: string;
}
export interface RunInfo {
  runId: string;
  jobName: string;
  status: string;
  startTime?: string;
  endTime?: string;
}

export class LineageService {
  private readonly queryUri: string;
  private readonly databaseName: string;

  constructor(clusterUri: string, databaseName: string) {
    this.queryUri = (clusterUri || '').replace(/\/+$/, '');
    this.databaseName = databaseName;
  }

  async getTableEdges(limit = 500): Promise<{ edges: TableEdge[]; truncated: boolean }> {
    const csl = `lin_table_edges_active()
| summarize job_name = take_any(job_name) by src_namespace, src_name, dst_namespace, dst_name
| order by dst_name asc, src_name asc
| take ${limit + 1}`;
    const { columns, rows } = await this.query(csl);
    const idx = this.columnIndex(columns, [
      'src_namespace',
      'src_name',
      'dst_namespace',
      'dst_name',
      'job_name',
    ]);
    const truncated = rows.length > limit;
    return {
      edges: rows.slice(0, limit).map((r) => {
        const srcNs = String(r[idx.src_namespace] ?? '');
        const srcName = String(r[idx.src_name] ?? '');
        const dstNs = String(r[idx.dst_namespace] ?? '');
        const dstName = String(r[idx.dst_name] ?? '');
        return {
          srcId: `${srcNs}|${srcName}`,
          dstId: `${dstNs}|${dstName}`,
          srcLabel: shortLabel(srcName),
          dstLabel: shortLabel(dstName),
          srcNamespace: srcNs,
          srcName,
          dstNamespace: dstNs,
          dstName,
          jobName: String(r[idx.job_name] ?? '') || undefined,
        };
      }),
      truncated,
    };
  }

  /** Column-to-column lineage edges (optionally for one target dataset). */
  async getColumnEdges(limit = 2000): Promise<ColumnEdge[]> {
    const csl = `lin_column_edges_active()
| summarize transformation = take_any(transformation) by src_namespace, src_name, src_column, dst_namespace, dst_name, dst_column
| take ${limit}`;
    const { columns, rows } = await this.query(csl);
    const idx = this.columnIndex(columns, [
      'src_namespace',
      'src_name',
      'src_column',
      'dst_namespace',
      'dst_name',
      'dst_column',
      'transformation',
    ]);
    return rows.map((r) => ({
      srcId: `${String(r[idx.src_namespace] ?? '')}|${String(r[idx.src_name] ?? '')}`,
      dstId: `${String(r[idx.dst_namespace] ?? '')}|${String(r[idx.dst_name] ?? '')}`,
      srcColumn: String(r[idx.src_column] ?? ''),
      dstColumn: String(r[idx.dst_column] ?? ''),
      transformation: String(r[idx.transformation] ?? '') || undefined,
    }));
  }

  /**
   * All columns for every dataset in one query (used to render node cards).
   * Returns a map keyed by `${ds_namespace}|${ds_name}`.
   */
  async getAllColumns(): Promise<Map<string, DatasetColumn[]>> {
    const csl = `lin_datasets()
| project ds_namespace, ds_name, column_name, column_type
| order by ds_name asc, column_name asc`;
    const { columns, rows } = await this.query(csl);
    const idx = this.columnIndex(columns, [
      'ds_namespace',
      'ds_name',
      'column_name',
      'column_type',
    ]);
    const map = new Map<string, DatasetColumn[]>();
    for (const r of rows) {
      const id = `${String(r[idx.ds_namespace] ?? '')}|${String(r[idx.ds_name] ?? '')}`;
      const col: DatasetColumn = {
        name: String(r[idx.column_name] ?? ''),
        type: String(r[idx.column_type] ?? '') || undefined,
      };
      const list = map.get(id);
      if (list) list.push(col);
      else map.set(id, [col]);
    }
    return map;
  }

  /** Columns (schema) for a single dataset/table. */
  async getColumns(namespace: string, name: string): Promise<DatasetColumn[]> {
    const csl = `lin_datasets()
| where ds_namespace == ns and ds_name == nm
| project column_name, column_type, column_description
| order by column_name asc`;
    const { columns, rows } = await this.query(csl, {
      ns: namespace,
      nm: name,
    });
    const idx = this.columnIndex(columns, [
      'column_name',
      'column_type',
      'column_description',
    ]);
    return rows.map((r) => ({
      name: String(r[idx.column_name] ?? ''),
      type: String(r[idx.column_type] ?? '') || undefined,
      description: String(r[idx.column_description] ?? '') || undefined,
    }));
  }

  async getStats(): Promise<LineageStats> {
    const datasetsCsl = `lin_datasets()
| summarize columns = count(), tables = count_distinct(strcat(ds_namespace, '|', ds_name))`;
    const tableEdgesCsl = 'lin_table_edges_active() | count';
    const columnEdgesCsl = 'lin_column_edges_active() | count';
    const runsCsl = `lin_runs()
| summarize runs = count(),
    succeeded = countif(status == 'COMPLETE'),
    failed = countif(status == 'FAIL'),
    aborted = countif(status == 'ABORT'),
    running = countif(status == 'RUNNING'),
    last_run = max(coalesce(end_time, start_time))`;

    const [datasets, tableEdges, columnEdges, runs] = await Promise.all([
      this.query(datasetsCsl),
      this.query(tableEdgesCsl),
      this.query(columnEdgesCsl),
      this.query(runsCsl),
    ]);

    const dIdx = this.columnIndex(datasets.columns, ['columns', 'tables']);
    const dRow = datasets.rows[0] || [];
    const rIdx = this.columnIndex(runs.columns, [
      'runs',
      'succeeded',
      'failed',
      'aborted',
      'running',
      'last_run',
    ]);
    const rRow = runs.rows[0] || [];

    return {
      tables: toCount(dRow[dIdx.tables]),
      columns: toCount(dRow[dIdx.columns]),
      tableEdges: this.scalar(tableEdges),
      columnEdges: this.scalar(columnEdges),
      runs: toCount(rRow[rIdx.runs]),
      succeeded: toCount(rRow[rIdx.succeeded]),
      failed: toCount(rRow[rIdx.failed]),
      aborted: toCount(rRow[rIdx.aborted]),
      running: toCount(rRow[rIdx.running]),
      lastRun: toDate(rRow[rIdx.last_run]),
    };
  }

  async getLastRunPerJob(): Promise<RunInfo[]> {
    const csl = `lin_runs()
| summarize arg_max(coalesce(end_time, start_time), run_id, status, start_time, end_time) by job_name
| project run_id, job_name, status, start_time, end_time`;
    const { columns, rows } = await this.query(csl);
    const idx = this.columnIndex(columns, [
      'run_id',
      'job_name',
      'status',
      'start_time',
      'end_time',
    ]);
    return rows.map((r) => ({
      runId: String(r[idx.run_id] ?? ''),
      jobName: String(r[idx.job_name] ?? ''),
      status: String(r[idx.status] ?? ''),
      startTime: toDate(r[idx.start_time]),
      endTime: toDate(r[idx.end_time]),
    }));
  }

  async getRecentRuns(n = 8): Promise<RunInfo[]> {
    const take = Math.max(1, Math.min(50, Math.floor(n)));
    const csl = `lin_runs()
| order by coalesce(end_time, start_time) desc
| take ${take}
| project run_id, job_name, status, start_time, end_time`;
    const { columns, rows } = await this.query(csl);
    const idx = this.columnIndex(columns, [
      'run_id',
      'job_name',
      'status',
      'start_time',
      'end_time',
    ]);
    return rows.map((r) => ({
      runId: String(r[idx.run_id] ?? ''),
      jobName: String(r[idx.job_name] ?? ''),
      status: String(r[idx.status] ?? ''),
      startTime: toDate(r[idx.start_time]),
      endTime: toDate(r[idx.end_time]),
    }));
  }

  // --- internals ---

  private async query(csl: string, params?: Record<string, string>): Promise<QueryResult> {
    if (!this.queryUri || !this.databaseName) {
      throw new Error(
        'Eventhouse query URI or database name is missing — provision the backend first.',
      );
    }
    let token: string;
    try {
      token = await getKustoToken(this.queryUri);
    } catch (e) {
      throw e instanceof TokenError
        ? new Error(authErrorMessage(e))
        : new Error(
            `Could not acquire an access token for the Eventhouse. The first time you query this Kusto cluster, the app redirects you to sign in and consent — after returning, the lineage data loads automatically. If this persists, your Entra app may be missing consent for the cluster's user_impersonation scope. Details: ${authErrorMessage(e)}`,
          );
    }
    if (!token) {
      throw new Error(
        'No access token was returned for the Eventhouse query (consent may have been declined).',
      );
    }
    // Bind any client-side values as Kusto query parameters (prevents injection).
    let finalCsl = csl;
    const body: Record<string, unknown> = { db: this.databaseName };
    if (params && Object.keys(params).length) {
      const decl = Object.keys(params)
        .map((k) => `${k}:string`)
        .join(', ');
      finalCsl = `declare query_parameters(${decl});\n${csl}`;
      body.properties = { Parameters: params };
    }
    body.csl = finalCsl;
    const response = await fetch(`${this.queryUri}/v1/rest/query`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-ms-client-request-id': 'Lineage-' + uuid(),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Eventhouse query failed (${response.status}): ${text.slice(0, 500)}`);
    }
    let parsed: KustoResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Eventhouse returned a response that could not be parsed as JSON.');
    }
    const table = this.selectPrimaryTable(parsed);
    if (!table) throw new Error('Eventhouse query returned no result table.');
    return { columns: table.Columns || [], rows: table.Rows || [] };
  }

  private selectPrimaryTable(response: KustoResponse): KustoTable | undefined {
    const tables = response.Tables || [];
    if (tables.length === 0) return undefined;
    if (tables.length === 1) return tables[0];
    const toc = tables[tables.length - 1];
    const names = (toc.Columns || []).map((c) => c.ColumnName);
    const ordinalIdx = names.indexOf('Ordinal');
    const kindIdx = names.indexOf('Kind');
    if (ordinalIdx >= 0 && kindIdx >= 0 && toc.Rows) {
      const row = toc.Rows.find((r) => String(r[kindIdx]) === 'QueryResult');
      if (row) {
        const ord = Number(row[ordinalIdx]);
        if (!isNaN(ord) && tables[ord]) return tables[ord];
      }
    }
    const skip = new Set(['@ExtendedProperties', 'QueryStatus', 'TableOfContents']);
    return tables.find((t) => !skip.has(t.TableName || '')) || tables[0];
  }

  private columnIndex(columns: KustoColumn[], names: string[]): Record<string, number> {
    const lookup: Record<string, number> = {};
    columns.forEach((c, i) => {
      lookup[c.ColumnName] = i;
    });
    const result: Record<string, number> = {};
    for (const name of names) result[name] = lookup[name] ?? -1;
    return result;
  }

  private scalar(result: QueryResult): number {
    const row = result.rows[0];
    return row ? toCount(row[0]) : 0;
  }
}
