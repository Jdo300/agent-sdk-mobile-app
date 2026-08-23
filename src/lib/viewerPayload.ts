export type ViewerPayload =
  | { kind: "code"; code: string; language: string | null }
  | { kind: "image"; uri: string; alt?: string; headers?: Record<string, string> };

let payload: ViewerPayload | null = null;

export function setViewerPayload(next: ViewerPayload): void {
  payload = next;
}

export function getViewerPayload(): ViewerPayload | null {
  return payload;
}
