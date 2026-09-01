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
