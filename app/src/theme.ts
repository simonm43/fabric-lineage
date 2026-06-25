/**
 * Dark theme tokens. The app ships a single dark theme.
 */
export const theme = {
  bg: '#0F1115',
  surface: '#1A1D23',
  surfaceAlt: '#22262E',
  border: '#2A2F38',
  text: '#E6E8EB',
  textDim: '#9AA3AF',
  accent: '#4C9AFF',
  accentDim: '#2B5F91',
  // Run / status colours.
  success: '#3FB950',
  danger: '#F85149',
  warning: '#D29922',
  running: '#4C9AFF',
} as const;

export type Theme = typeof theme;

/** Status → colour mapping. */
export function statusColor(status: string): string {
  switch ((status || '').toUpperCase()) {
    case 'COMPLETE':
      return theme.success;
    case 'FAIL':
      return theme.danger;
    case 'ABORT':
      return theme.warning;
    case 'RUNNING':
      return theme.running;
    default:
      return theme.textDim;
  }
}
