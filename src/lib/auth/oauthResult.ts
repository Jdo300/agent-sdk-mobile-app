export type OAuthBrowserResult =
  | { type: "cancel" | "dismiss" | "opened" | "locked" }
  | {
      type: "error" | "success";
      params: Record<string, string>;
      error?: { description?: string } | null;
    };

export class OAuthCancelledError extends Error {}

export function authorizationCodeFromResult(result: OAuthBrowserResult): string {
  if (result.type === "cancel" || result.type === "dismiss") {
    throw new OAuthCancelledError("Sign-in was cancelled.");
  }
  if (result.type !== "success") {
    const detail = result.type === "error" ? result.error?.description : null;
    throw new Error(detail || "Letta Cloud could not complete sign-in.");
  }
  if (!result.params.code) {
    throw new Error("Letta Cloud did not return the required sign-in details.");
  }
  return result.params.code;
}
