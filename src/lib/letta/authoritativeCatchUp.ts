/**
 * A catch-up may only mutate the transcript while it still belongs to the
 * active SDK session and its cancellation generation. Keeping this pure makes
 * the fetch/send invalidation race directly testable.
 */
export function isAuthoritativeCatchUpCurrent(
  closed: boolean,
  activeSession: unknown,
  session: unknown,
  generation: number,
  activeGeneration: number,
): boolean {
  return !closed && activeSession === session && generation === activeGeneration;
}
