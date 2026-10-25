/** Messages from the content script or popup to the background service worker. */
export type ExtensionMessage =
  | { type: "badge"; text: string; state: "locked" | "paused" | "unlocked" }
  | { type: "open-dashboard"; hash?: string };

/** Result of resetEditorToDefault, sent back over the page bridge (see shared/bridge.ts). */

export interface ResetCodeResult {
  ok: boolean;
  /** Why the reset was skipped or failed, when ok is false. */
  reason?: string;
  lang?: string;
  /** True when nothing was changed because the editor already had the user's code. */
  existingCode?: boolean;
  /** How many saved drafts in other languages were removed. */
  removedDrafts?: number;
}
