/**
 * Parse an OpenLineage dataset (namespace + name) into lakehouse / schema /
 * table parts. Fabric emits a few shapes, so this is best-effort:
 *   - dotted friendly name: `taxi_lh.silver_yellow_taxi` or `demo_lh.dbo.input`
 *   - OneLake path: `abfss://…|/<lakehouseId>/Tables/<table>` (or `…/<schema>/<table>`)
 */
export interface DatasetParts {
  lakehouse: string;
  schema: string;
  table: string;
}

export function parseDataset(namespace: string, name: string): DatasetParts {
  const raw = (name || '').trim();

  const tablesIdx = raw.toLowerCase().indexOf('/tables/');
  if (tablesIdx >= 0) {
    const before = raw.slice(0, tablesIdx).replace(/^\/+/, '');
    const lakehouse = before.split('/').filter(Boolean).pop() || lakehouseFromNamespace(namespace);
    const rest = raw
      .slice(tablesIdx + '/tables/'.length)
      .split('/')
      .filter(Boolean);
    const table = rest.pop() || raw;
    const schema = rest.pop() || '(default)';
    return { lakehouse, schema, table };
  }

  const parts = raw.split('.').filter(Boolean);
  if (parts.length >= 3) {
    return { lakehouse: parts[0], schema: parts[1], table: parts.slice(2).join('.') };
  }
  if (parts.length === 2) {
    return { lakehouse: parts[0], schema: '(default)', table: parts[1] };
  }
  return { lakehouse: lakehouseFromNamespace(namespace), schema: '(default)', table: raw };
}

function lakehouseFromNamespace(namespace: string): string {
  const ns = (namespace || '').trim();
  const m = /([A-Za-z0-9_-]+)\.lakehouse/i.exec(ns);
  if (m) return m[1];
  const last = ns.split(/[/\\@]/).filter(Boolean).pop();
  return last || '(unknown)';
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Friendly lakehouse label: resolve a lakehouse GUID to its display name via
 * the provided name map, falling back to a shortened GUID (`lh-xxxxxxxx`) when
 * unresolved so the UI never shows a raw 36-char GUID.
 */
export function lakehouseLabel(lakehouse: string, names?: Map<string, string>): string {
  const key = (lakehouse || '').toLowerCase();
  const name = names?.get(key);
  if (name) return name;
  if (GUID_RE.test(lakehouse)) return `lh-${lakehouse.slice(0, 8)}`;
  return lakehouse;
}
