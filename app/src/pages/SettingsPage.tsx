import { useState } from 'react';
import {
  loadConfig,
  saveConfig,
  normalizeUri,
  isConfigured,
  type AppConfig,
} from '../config';

/**
 * Settings — edits the localStorage config override ("lineage.config.v1").
 * Field set matches AppConfig.
 */
export function SettingsPage({ onClose }: { onClose?: () => void }) {
  const [config, setConfig] = useState<AppConfig>(() => loadConfig());
  const [saved, setSaved] = useState(false);

  function update<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    setConfig((c) => ({ ...c, [key]: value }));
    setSaved(false);
  }

  function onSave() {
    const next = { ...config, clusterUri: normalizeUri(config.clusterUri) };
    saveConfig(next);
    setConfig(next);
    setSaved(true);
  }

  const field = (
    label: string,
    key: keyof AppConfig,
    placeholder = '',
  ) => (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <div className="muted" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <input
        style={{ width: '100%' }}
        value={config[key]}
        placeholder={placeholder}
        onChange={(e) => update(key, e.target.value)}
      />
    </label>
  );

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <div className="detail-head">
        <h2 style={{ margin: 0 }}>Settings</h2>
        {onClose && (
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        )}
      </div>

      <h3>Eventhouse (OpenLineage)</h3>
      {field('Cluster URI', 'clusterUri', 'https://<cluster>.kusto.fabric.microsoft.com')}
      {field('KQL database name', 'databaseName', 'lineage_eh')}

      <h3>Identity</h3>
      {field('Entra client id', 'entraClientId')}
      {field('Entra tenant id', 'entraTenantId', 'organizations')}
      {field('Lineage workspace id', 'workspaceId')}

      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="btn" onClick={onSave}>
          Save
        </button>
        {saved && <span className="muted">Saved.</span>}
        {!isConfigured(config) && (
          <span style={{ color: 'var(--warning)' }}>
            Cluster URI, database and client id are required to query lineage.
          </span>
        )}
      </div>
    </div>
  );
}
