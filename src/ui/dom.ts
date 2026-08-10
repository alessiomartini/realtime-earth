/** Minimal DOM helpers. No framework: the bundle stays small and the render path stays obvious. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

/**
 * Format an age in ms as a compact duration.
 *
 * `null` means we genuinely do not know how old the datum is — the source gave
 * us no timestamp — and it renders as "—", never as zero or "now".
 */
export function formatAge(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 0) {
    // The source's clock is ahead of ours. Reporting a negative age would be
    // nonsense and rounding it to "0s" would hide a real clock discrepancy.
    return 'ahead';
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Group separators make six-figure message counts readable at a glance. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
