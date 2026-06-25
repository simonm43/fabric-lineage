import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  FabricService,
  WorkspaceUser,
  DirectoryPrincipal,
} from '../services/fabricService';

/**
 * Access check picker.
 *
 * Lakehouse access in Fabric is governed by *workspace roles*: anyone with a
 * workspace role (Admin, Member, Contributor, Viewer) can read every lakehouse
 * in that workspace. This drawer is just a people-picker (directory search,
 * seeded with the workspace's role-assignment members). When a principal is
 * chosen we resolve their role per distinct table-workspace and hand the result
 * back to the graph, which paints each table green (allowed) or red (denied).
 */
export interface AccessTable {
  id: string;
  label: string;
  /** Friendly lakehouse name (already resolved). */
  lakehouse: string;
  /** Workspace GUID parsed from the dataset namespace ('' = configured ws). */
  workspace: string;
}

/** Result handed to the graph to drive per-table highlighting. */
export interface AccessOverlay {
  name: string;
  upn: string;
  /** workspace id ('' = configured ws) → role held, or null when none. */
  roleByWs: Map<string, string | null>;
}

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? 'Could not load workspace users');
  if (/AADSTS650057|invalid_client|Invalid resource|\(401\)|\(403\)/i.test(msg)) {
    return (
      'This requires the Fabric "Workspace.Read.All" delegated permission on the ' +
      'app registration. Re-run the deploy script or grant it in the Entra portal, ' +
      'then sign in again.'
    );
  }
  return msg;
}

/** True when a role-assignment principal is the same as the picked principal. */
function samePrincipal(a: WorkspaceUser, p: DirectoryPrincipal): boolean {
  const id = (a.id ?? '').toLowerCase();
  const upn = (a.upn ?? '').toLowerCase();
  const name = (a.name ?? '').toLowerCase();
  return (
    (!!p.id && id === p.id.toLowerCase()) ||
    (!!p.upn && upn === p.upn.toLowerCase()) ||
    (!!p.name && name === p.name.toLowerCase())
  );
}

export function AccessCheckDrawer({
  context,
  tables,
  fabric,
  onApply,
  onClose,
}: {
  context: string;
  tables: AccessTable[];
  fabric: FabricService;
  onApply: (overlay: AccessOverlay) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [suggest, setSuggest] = useState<DirectoryPrincipal[]>([]);
  const [searching, setSearching] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();

  // Workspace role-assignment members (seed suggestions + fallback search).
  const [members, setMembers] = useState<WorkspaceUser[]>();
  const [membersError, setMembersError] = useState<string>();

  useEffect(() => {
    let live = true;
    fabric
      .getRoleAssignments()
      .then((u) => live && setMembers(u))
      .catch((e: unknown) => live && setMembersError(friendlyError(e)));
    return () => {
      live = false;
    };
  }, [fabric]);

  // Debounced directory search merged with matching workspace members.
  const debounce = useRef<number | undefined>(undefined);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSuggest([]);
      setSearching(false);
      return;
    }
    window.clearTimeout(debounce.current);
    setSearching(true);
    debounce.current = window.setTimeout(() => {
      void fabric
        .searchDirectory(q)
        .then((found) => {
          const ql = q.toLowerCase();
          const seed: DirectoryPrincipal[] = (members ?? [])
            .filter(
              (m) =>
                m.name.toLowerCase().includes(ql) || (m.upn ?? '').toLowerCase().includes(ql),
            )
            .map((m) => ({
              id: m.id ?? '',
              name: m.name,
              upn: m.upn,
              type: m.type === 'Group' ? 'Group' : 'User',
            }));
          const seen = new Set<string>();
          const merged: DirectoryPrincipal[] = [];
          for (const p of [...seed, ...found]) {
            const key = (p.id || p.upn || p.name).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(p);
          }
          setSuggest(merged.slice(0, 20));
        })
        .catch(() => setSuggest([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => window.clearTimeout(debounce.current);
  }, [query, fabric, members]);

  // Distinct workspaces among the visible tables (''=configured workspace).
  const workspaces = useMemo(() => {
    const s = new Set<string>();
    for (const t of tables) s.add(t.workspace || '');
    return [...s];
  }, [tables]);

  function choose(p: DirectoryPrincipal) {
    setChecking(true);
    setError(undefined);
    Promise.all(
      workspaces.map(async (ws) => {
        const roles = await fabric.getRoleAssignments(ws || undefined);
        const match = roles.find((r) => samePrincipal(r, p));
        return [ws, match ? match.role : null] as const;
      }),
    )
      .then((pairs) => {
        onApply({ name: p.name, upn: p.upn, roleByWs: new Map(pairs) });
        onClose();
      })
      .catch((e: unknown) => setError(friendlyError(e)))
      .finally(() => setChecking(false));
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal access-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="card">
          <div className="detail-head">
            <div>
              <div className="detail-title">Check lakehouse access</div>
              <div className="muted detail-sub">{context}</div>
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
          </div>

          <div className="access-help muted">
            Anyone with a workspace role (Admin, Member, Contributor, Viewer) can read
            every lakehouse in that workspace. Pick a user or group — the graph will
            highlight each table <span style={{ color: '#3FB950' }}>green</span> (allowed)
            or <span style={{ color: '#F85149' }}>red</span> (denied).
          </div>

          <div className="access-picker">
            <input
              className="full-input"
              placeholder="Search a user or group by name, UPN, or email…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            {query.trim().length >= 2 && (
              <ul className="access-suggest">
                {searching && <li className="muted">Searching directory…</li>}
                {!searching && suggest.length === 0 && (
                  <li className="muted">No matching users or groups.</li>
                )}
                {suggest.map((p) => (
                  <li key={p.id || p.upn || p.name} onMouseDown={() => choose(p)}>
                    <span className="acc-ico">{p.type === 'Group' ? '👥' : '👤'}</span>
                    <span className="acc-name">{p.name}</span>
                    {p.upn && <span className="muted acc-upn">{p.upn}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {checking && <div className="muted pad">Resolving access…</div>}
          {error && <div className="message-bar error"><div>{error}</div></div>}
          {membersError && !error && (
            <div className="message-bar error"><div>{membersError}</div></div>
          )}
        </div>
      </div>
    </div>
  );
}
