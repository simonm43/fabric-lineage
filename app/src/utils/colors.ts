/**
 * Deterministic accent color for a lakehouse / table label, so the same name
 * always gets the same dot color across the Overview and graph views.
 */
const PALETTE = [
  '#d97f3c', // orange
  '#2899f5', // blue
  '#a371f7', // purple
  '#3fb950', // green
  '#e06c9f', // pink
  '#d2a106', // amber
  '#3bc9c9', // teal
  '#f85149', // red
];

export function lakehouseColor(key: string): string {
  let hash = 0;
  const s = key || '';
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
