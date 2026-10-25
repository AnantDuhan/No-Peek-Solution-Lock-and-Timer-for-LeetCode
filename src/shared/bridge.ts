import type { ResetCodeResult } from "./messages";

/**
 * Window events between the content script and the page-world editor bridge.
 *
 * Types only, on purpose: page/editorBridge.ts must bundle to one standalone
 * script with no imports (a MAIN-world content script can't load extension
 * modules), so it can't share runtime values with content.ts. Each side
 * declares the names itself, typed with these so a mismatch won't compile.
 */
export type ResetRequestEvent = "no-peek:reset-request";
export type ResetResultEvent = "no-peek:reset-result";

export interface ResetRequest {
  id: string;
  slug: string;
  force?: boolean;
}

export interface ResetResponse {
  id: string;
  result: ResetCodeResult;
}
