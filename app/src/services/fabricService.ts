/**
 * FabricService — resolves Fabric items (lakehouses) and builds portal deep
 * links used by the lineage graph's right-click actions.
 *
 * Lakehouse resolution is best-effort: OpenLineage dataset names from Fabric
 * encode the lakehouse somewhere in the namespace/name, so we match candidate
 * names against the workspace's lakehouse list. If nothing matches we fall back
 * to opening the workspace, never throwing into the UI.
 */
import { getFabricToken, getFabricTokenSilent, getGraphToken, getGraphTokenSilent } from './auth';

const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';

export interface Lakehouse {
  id: string;
  displayName: string;
}

export interface WorkspaceUser {
  name: string;
  /** UPN / email when the principal is a user. */
  upn: string;
  type: string;
  role: string;
  /** Stable principal id (Entra object id) when available. */
  id?: string;
}

/** A directory principal returned by the Graph people-picker search. */
export interface DirectoryPrincipal {
  id: string;
  name: string;
  /** UPN / email (empty for groups without a mail). */
  upn: string;
  type: 'User' | 'Group';
}

export class FabricService {
  private readonly workspaceId: string;
  private readonly portalUrl: string;
  private lakehouseCache?: Promise<Lakehouse[]>;

  constructor(workspaceId: string, portalUrl: string) {
    this.workspaceId = workspaceId;
    this.portalUrl = (portalUrl || 'https://app.fabric.microsoft.com').replace(/\/+$/, '');
  }

  /** List lakehouses in the workspace (cached for the session). */
  listLakehouses(): Promise<Lakehouse[]> {
    if (!this.lakehouseCache) {
      this.lakehouseCache = this.fetchLakehouses().catch((e) => {
        this.lakehouseCache = undefined; // allow retry after a transient failure
        throw e;
      });
    }
    return this.lakehouseCache;
  }

  /**
   * Best-effort map of lakehouse GUID → friendly display name, acquired
   * silently (never prompts). Returns an empty map when no cached Fabric
   * token/consent is available, so callers can fall back to the GUID.
   */
  async getLakehouseNamesSilent(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.workspaceId) return out;
    const token = await getFabricTokenSilent();
    if (!token) return out;
    try {
      const res = await fetch(`${FABRIC_API}/workspaces/${this.workspaceId}/lakehouses`, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      });
      if (!res.ok) return out;
      const json = (await res.json()) as { value?: { id: string; displayName: string }[] };
      for (const l of json.value ?? []) {
        if (l.id && l.displayName) out.set(l.id.toLowerCase(), l.displayName);
      }
    } catch {
      /* best-effort — fall back to GUIDs */
    }
    return out;
  }

  /**
   * Map of lakehouse GUID → friendly display name, acquired interactively
   * (silent-then-popup). Used as a one-shot escalation when the silent map is
   * empty (e.g. a returning user whose Fabric consent predates the current
   * scopes). Falls back to an empty map on any failure.
   */
  async getLakehouseNames(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.workspaceId) return out;
    try {
      for (const l of await this.listLakehouses()) {
        if (l.id && l.displayName) out.set(l.id.toLowerCase(), l.displayName);
      }
    } catch {
      /* best-effort — fall back to GUIDs */
    }
    return out;
  }

  private async fetchLakehouses(): Promise<Lakehouse[]> {
    if (!this.workspaceId) return [];
    const token = await getFabricToken();
    const res = await fetch(`${FABRIC_API}/workspaces/${this.workspaceId}/lakehouses`, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Fabric lakehouse list failed (${res.status})`);
    }
    const json = (await res.json()) as { value?: { id: string; displayName: string }[] };
    return (json.value ?? []).map((l) => ({ id: l.id, displayName: l.displayName }));
  }

  lakehouseUrl(lakehouseId: string): string {
    return `${this.portalUrl}/groups/${this.workspaceId}/lakehouses/${lakehouseId}`;
  }

  workspaceUrl(): string {
    return `${this.portalUrl}/groups/${this.workspaceId}`;
  }

  /**
   * List a workspace's role assignments (who has access). Used by the
   * "Check lakehouse access" action — lakehouse access is governed by the
   * containing workspace's roles. Defaults to the configured workspace.
   */
  async listWorkspaceUsers(workspaceId?: string): Promise<WorkspaceUser[]> {
    const wsId = workspaceId || this.workspaceId;
    if (!wsId) return [];
    const token = await getFabricToken();
    const out: WorkspaceUser[] = [];
    let url: string | undefined = `${FABRIC_API}/workspaces/${wsId}/roleAssignments`;
    while (url) {
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`Could not load workspace users (${res.status})`);
      }
      const json = (await res.json()) as {
        value?: RoleAssignment[];
        continuationUri?: string;
      };
      for (const a of json.value ?? []) {
        const p = a.principal ?? {};
        out.push({
          id: p.id,
          name: p.displayName ?? '(unknown)',
          upn: p.userDetails?.userPrincipalName ?? p.groupDetails?.email ?? '',
          type: p.type ?? 'Unknown',
          role: a.role ?? '',
        });
      }
      url = json.continuationUri;
    }
    out.sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.name.localeCompare(b.name));
    return out;
  }

  /**
   * Cached role-assignment lookup keyed by workspace id — the access drawer may
   * check several distinct workspaces (one per lakehouse) and revisit them.
   */
  private readonly roleCache = new Map<string, Promise<WorkspaceUser[]>>();

  getRoleAssignments(workspaceId?: string): Promise<WorkspaceUser[]> {
    const wsId = workspaceId || this.workspaceId;
    let p = this.roleCache.get(wsId);
    if (!p) {
      p = this.listWorkspaceUsers(wsId).catch((e) => {
        this.roleCache.delete(wsId);
        throw e;
      });
      this.roleCache.set(wsId, p);
    }
    return p;
  }

  /**
   * Microsoft Graph people-picker search across users and groups. Returns an
   * empty list (never throws) when Graph consent is unavailable so the caller
   * can fall back to workspace role-assignment users.
   */
  async searchDirectory(query: string): Promise<DirectoryPrincipal[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const token = (await getGraphTokenSilent()) ?? (await getGraphToken().catch(() => undefined));
    if (!token) return [];
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      ConsistencyLevel: 'eventual',
    };
    const esc = q.replace(/"/g, '');
    const userSearch =
      `"displayName:${esc}" OR "userPrincipalName:${esc}" OR "mail:${esc}" OR "givenName:${esc}" OR "surname:${esc}"`;
    const usersUrl =
      `${GRAPH_API}/users?$search=${encodeURIComponent(userSearch)}` +
      `&$select=id,displayName,userPrincipalName,mail&$top=15`;
    const groupsUrl =
      `${GRAPH_API}/groups?$search=${encodeURIComponent(`"displayName:${esc}" OR "mail:${esc}"`)}` +
      `&$select=id,displayName,mail&$top=10`;
    const out: DirectoryPrincipal[] = [];
    try {
      const [ures, gres] = await Promise.all([
        fetch(usersUrl, { headers }),
        fetch(groupsUrl, { headers }).catch(() => undefined),
      ]);
      if (ures.ok) {
        const j = (await ures.json()) as {
          value?: { id: string; displayName?: string; userPrincipalName?: string; mail?: string }[];
        };
        for (const u of j.value ?? []) {
          out.push({
            id: u.id,
            name: u.displayName ?? u.userPrincipalName ?? '(user)',
            upn: u.userPrincipalName ?? u.mail ?? '',
            type: 'User',
          });
        }
      }
      if (gres && gres.ok) {
        const j = (await gres.json()) as {
          value?: { id: string; displayName?: string; mail?: string }[];
        };
        for (const g of j.value ?? []) {
          out.push({ id: g.id, name: g.displayName ?? '(group)', upn: g.mail ?? '', type: 'Group' });
        }
      }
    } catch {
      /* best-effort — fall back to workspace users */
    }
    return out;
  }
}

interface RoleAssignment {
  role?: string;
  principal?: {
    id?: string;
    displayName?: string;
    type?: string;
    userDetails?: { userPrincipalName?: string };
    groupDetails?: { email?: string };
  };
}

function roleRank(role: string): number {
  const order = ['Admin', 'Member', 'Contributor', 'Viewer'];
  const i = order.indexOf(role);
  return i === -1 ? order.length : i;
}
