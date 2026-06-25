/**
 * Application configuration.
 *
 * Config comes from build-time env vars, with a localStorage override
 * ("lineage.config.v1") that the Settings page writes.
 */

export interface AppConfig {
  /** Eventhouse / Kusto cluster URI (OpenLineage events). */
  clusterUri: string;
  /** KQL database name. */
  databaseName: string;
  /** Entra application (client) id used for token acquisition. */
  entraClientId: string;
  /** Entra tenant id (or "organizations"). */
  entraTenantId: string;
  /** Lineage / OneLake workspace id. */
  workspaceId: string;
  /** Fabric portal base url. */
  fabricPortalUrl: string;
}

const STORAGE_KEY = 'lineage.config.v1';

function env(name: string): string {
  return ((import.meta.env as Record<string, string>)[name] ?? '').trim();
}

/**
 * Read the first non-empty value among several env var names.
 *
 * The deploy script bakes config via `rayfin/.env` (RAYFIN_PUBLIC_* vars,
 * which rayfin emits as VITE_RAYFIN_*), so each setting accepts both the
 * plain VITE_* name and the VITE_RAYFIN_* variant.
 */
function envAny(...names: string[]): string {
  for (const n of names) {
    const v = env(n);
    if (v) return v;
  }
  return '';
}

/** Default config derived purely from build-time environment variables. */
function defaultConfig(): AppConfig {
  return {
    clusterUri: envAny('VITE_KUSTO_CLUSTER_URI', 'VITE_RAYFIN_KUSTO_CLUSTER_URI'),
    databaseName: envAny('VITE_KUSTO_DATABASE', 'VITE_RAYFIN_KUSTO_DATABASE'),
    entraClientId: envAny('VITE_ENTRA_CLIENT_ID', 'VITE_RAYFIN_ENTRA_CLIENT_ID'),
    entraTenantId:
      envAny('VITE_ENTRA_TENANT_ID', 'VITE_RAYFIN_ENTRA_TENANT_ID', 'VITE_FABRIC_TENANT_ID') ||
      'organizations',
    workspaceId: envAny(
      'VITE_LINEAGE_WORKSPACE_ID',
      'VITE_RAYFIN_LINEAGE_WORKSPACE_ID',
      'VITE_FABRIC_WORKSPACE_ID',
    ),
    fabricPortalUrl:
      envAny('VITE_FABRIC_PORTAL_URL', 'VITE_RAYFIN_FABRIC_PORTAL_URL') ||
      'https://app.fabric.microsoft.com',
  };
}

/** Load config: env defaults merged with any localStorage override. */
export function loadConfig(): AppConfig {
  const base = defaultConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const override = JSON.parse(raw) as Partial<AppConfig>;
      return { ...base, ...override };
    }
  } catch {
    /* ignore malformed override */
  }
  return base;
}

/** Persist a config override to localStorage. */
export function saveConfig(config: AppConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** True once the minimum settings required to query the Eventhouse exist. */
export function isConfigured(config: AppConfig): boolean {
  return !!config.clusterUri && !!config.databaseName && !!config.entraClientId;
}

/** Trim a URI and strip any trailing slashes. */
export function normalizeUri(uri: string): string {
  return (uri || '').trim().replace(/\/+$/, '');
}
