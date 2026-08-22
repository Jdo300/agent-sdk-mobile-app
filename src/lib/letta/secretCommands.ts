/** Local-only slash command guard for Letta agent secrets.
 *
 * Secret commands must never enter the normal chat transcript or draft
 * persistence. Bloop treats any `/secret` or `/secrets` command as a request
 * to open the native App Server secret manager instead.
 */
export function isSecretSlashCommand(text: string): boolean {
  return /^\/secrets?(?:\s|$)/i.test(text.trimStart());
}
