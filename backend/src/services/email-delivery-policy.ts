/**
 * Email delivery policy (OPS-EMAIL-001) — mirror of nomadas-tour.
 * normal | restricted | disabled
 */

export type EmailDeliveryMode = 'normal' | 'restricted' | 'disabled';

export function normalizeEmailDeliveryMode(value?: string): EmailDeliveryMode {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'restricted' || v === 'disabled') return v;
  return 'normal';
}

export function parseAllowedRecipients(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
