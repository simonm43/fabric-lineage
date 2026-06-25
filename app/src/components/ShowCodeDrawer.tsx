/**
 * Bottom drawer that displays the reconstructed PySpark notebook source for a
 * table, resolved from its OpenLineage job_name (see utils/notebook).
 */
export function ShowCodeDrawer({
  table,
  notebook,
  source,
  onClose,
}: {
  table: string;
  notebook: string;
  source?: string;
  onClose: () => void;
}) {
  return (
    <div className="code-drawer">
      <div className="code-head">
        <span className="code-title">
          <span className="code-glyph">&lt;/&gt;</span> {table} · {notebook}
        </span>
        <button className="link-btn" onClick={onClose}>✕ Close</button>
      </div>
      <pre className="code-body">
        {source ?? `# No embedded source found for notebook "${notebook}".`}
      </pre>
    </div>
  );
}
