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


export function shouldWaitForAuthoritativeIdle(isProcessing: boolean, run: string): boolean {
  return isProcessing || run !== "idle";
}

export function shouldReconnectSilentSend(options: {
  closed: boolean;
  serialBeforeSend: number;
  currentSerial: number;
  run: string;
  connection: string;
  serverProcessing: boolean;
}): boolean {
  return (
    !options.closed &&
    options.serialBeforeSend === options.currentSerial &&
    (options.run === "running" || options.run === "awaiting_approval") &&
    options.connection !== "auth_failed" &&
    !options.serverProcessing
  );
}
