/**
 * Single-admin builds have no Pro tiers, so feature badges are intentionally
 * invisible. Kept as a no-op so feature panels do not need conditional markup.
 */
export function ProBadge(_props: Record<string, unknown>) {
  return null
}
