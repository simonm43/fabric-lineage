/**
 * Resolve the demo medallion notebook that produced a table from its
 * OpenLineage job_name, and expose the embedded source for "Show code".
 *
 * Fabric Spark job names look like
 *   `04_cross_marts_6de08e8f…atomic_replace_table_as_select.finance_lh_silver_cost_centers`
 * The leading token (before the first 8-hex session hash) is the notebook name.
 */
import { NOTEBOOK_SOURCE } from '../data/notebooks';

export interface NotebookCode {
  /** Short notebook name, e.g. `04_cross_marts`. */
  name: string;
  /** Embedded PySpark source, or undefined if not one of the demo notebooks. */
  source?: string;
}

/** Extract the notebook stem from a job_name (everything before the session hash). */
export function notebookNameForJob(jobName: string | undefined): string {
  const j = (jobName || '').trim();
  if (!j) return '';
  const hash = /^(.*?)[_.][0-9a-f]{8,}/i.exec(j);
  const stem = hash ? hash[1] : j.split(/[_.]/).slice(0, 3).join('_');
  return stem;
}

/** Resolve a job_name to its embedded notebook code (best-effort). */
export function notebookForJob(jobName: string | undefined): NotebookCode {
  const name = notebookNameForJob(jobName);
  if (NOTEBOOK_SOURCE[name]) return { name, source: NOTEBOOK_SOURCE[name] };
  // Fall back to a prefix match (handles minor suffix variations).
  const key = Object.keys(NOTEBOOK_SOURCE).find((k) => name.startsWith(k) || k.startsWith(name));
  return key ? { name: key, source: NOTEBOOK_SOURCE[key] } : { name: name || 'notebook' };
}
