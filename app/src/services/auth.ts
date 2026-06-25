/**
 * Token acquisition via MSAL.
 *
 * Acquires per-resource access tokens using the Entra client id and tenant
 * from {@link AppConfig}.
 *
 * The app only needs one scope: the Eventhouse / Kusto cluster
 * (`${clusterUri}/.default`) for delegated, per-user lineage queries.
 */
import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  type AuthenticationResult,
} from '@azure/msal-browser';
import { loadConfig, normalizeUri } from '../config';

/** Error raised when a token cannot be acquired. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

let pca: PublicClientApplication | undefined;

function client(): PublicClientApplication {
  if (!pca) {
    const cfg = loadConfig();
    pca = new PublicClientApplication({
      auth: {
        clientId: cfg.entraClientId,
        authority: `https://login.microsoftonline.com/${cfg.entraTenantId || 'organizations'}`,
        redirectUri: window.location.origin,
      },
      cache: { cacheLocation: 'localStorage' },
    });
  }
  return pca;
}

let initialized = false;
async function ensureInit(): Promise<void> {
  if (!initialized) {
    await client().initialize();
    initialized = true;
  }
}

/**
 * Serializes interactive (popup) token requests. MSAL allows only one
 * interaction at a time; concurrent popups throw `interaction_in_progress`.
 * Every popup is chained onto this promise so they run one after another.
 */
let interactionLock: Promise<unknown> = Promise.resolve();

function isInteractionInProgress(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as unknown as { errorCode?: string }).errorCode === 'interaction_in_progress'
  );
}

/** Runs an interactive popup serialized behind {@link interactionLock}. */
async function runInteractive<T>(fn: () => Promise<T>): Promise<T> {
  const run = interactionLock.then(fn, fn);
  // Keep the lock chained even if this interaction fails.
  interactionLock = run.catch(() => undefined);
  return run;
}

/**
 * Delegated Fabric REST scopes. Using the specific `Workspace.Read.All`
 * (user-consentable) scope — instead of `.default` — lets a normal user grant
 * consent at sign-in without a tenant administrator. Powers lakehouse-name
 * resolution and the "Check lakehouse access" action.
 */
const FABRIC_SCOPES = ['https://api.fabric.microsoft.com/Workspace.Read.All'];

/**
 * Microsoft Graph scope for directory people-picker search in the
 * "Check lakehouse access" drawer (`/users` + `/groups` $search). User
 * consentable, so a normal user can grant it at sign-in.
 */
const GRAPH_SCOPES = ['https://graph.microsoft.com/User.ReadBasic.All'];

/** Scopes bundled for consent on the first interactive sign-in. */
const CONSENT_SCOPES = [...FABRIC_SCOPES, ...GRAPH_SCOPES];

async function acquirePopup(scopes: string[], extraScopesToConsent?: string[]): Promise<string> {
  const pc = client();
  const result = await runInteractive(() =>
    pc.acquireTokenPopup({ scopes, extraScopesToConsent }),
  );
  return result.accessToken;
}

async function acquire(scopes: string[], extraScopesToConsent?: string[]): Promise<string> {
  await ensureInit();
  const pc = client();
  const account = pc.getAllAccounts()[0];
  try {
    if (account) {
      const result: AuthenticationResult = await pc.acquireTokenSilent({ scopes, account });
      return result.accessToken;
    }
    return await acquirePopup(scopes, extraScopesToConsent);
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError || isInteractionInProgress(error)) {
      return acquirePopup(scopes, extraScopesToConsent);
    }
    throw new TokenError(
      error instanceof Error ? error.message : 'Failed to acquire access token.',
    );
  }
}

/**
 * Token for the Eventhouse / Kusto cluster (resource = cluster URI).
 *
 * The Fabric scopes are bundled as `extraScopesToConsent` so the very first
 * sign-in (which acquires this Kusto token) also consents the Fabric REST
 * scopes in one dialog — lakehouse names and access checks then work without a
 * second prompt.
 */
export function getKustoToken(clusterUri: string): Promise<string> {
  const resource = normalizeUri(clusterUri);
  return acquire([`${resource}/.default`], CONSENT_SCOPES);
}

/** Token for the Fabric REST API (workspace/lakehouse lookups). */
export function getFabricToken(): Promise<string> {
  return acquire(FABRIC_SCOPES, CONSENT_SCOPES);
}

/** Token for Microsoft Graph (directory user/group search). */
export function getGraphToken(): Promise<string> {
  return acquire(GRAPH_SCOPES, CONSENT_SCOPES);
}

/**
 * Silent Graph token — returns undefined instead of prompting. Used by the
 * access-check people picker; callers fall back to workspace role-assignment
 * users when Graph consent is not yet present.
 */
export async function getGraphTokenSilent(): Promise<string | undefined> {
  return acquireSilent(GRAPH_SCOPES);
}

/**
 * Silent token acquisition — returns undefined instead of prompting when no
 * cached token/consent is available. Used for best-effort enrichment that must
 * never pop a login dialog on its own.
 */
async function acquireSilent(scopes: string[]): Promise<string | undefined> {
  try {
    await ensureInit();
    const pc = client();
    const account = pc.getAllAccounts()[0];
    if (!account) return undefined;
    const result = await pc.acquireTokenSilent({ scopes, account });
    return result.accessToken;
  } catch {
    return undefined;
  }
}

/**
 * Silent Fabric token — returns undefined instead of prompting when no cached
 * token/consent is available. Used for best-effort enrichment (lakehouse name
 * resolution) that must never pop a login dialog on its own.
 */
export function getFabricTokenSilent(): Promise<string | undefined> {
  return acquireSilent(FABRIC_SCOPES);
}

/** Username (UPN) of the signed-in account, if any. */
export function currentAccountName(): string | undefined {
  try {
    return pca?.getAllAccounts()[0]?.username;
  } catch {
    return undefined;
  }
}

/** Sign the user out (clears the MSAL account) and reloads. */
export async function signOut(): Promise<void> {
  try {
    await ensureInit();
    const pc = client();
    const account = pc.getAllAccounts()[0];
    if (account) {
      await pc.logoutPopup({ account, mainWindowRedirectUri: window.location.origin });
      return;
    }
  } catch {
    /* fall through to a local clear */
  }
  window.location.reload();
}
