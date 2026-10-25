import { resetEditorToDefault } from "./resetEditor";
import type { ResetRequest, ResetRequestEvent, ResetResponse, ResetResultEvent } from "../shared/bridge";

const RESET_REQUEST_EVENT: ResetRequestEvent = "no-peek:reset-request";
const RESET_RESULT_EVENT: ResetResultEvent = "no-peek:reset-result";

/**
 * Runs in the page's own JavaScript world (manifest content script with
 * world: "MAIN"), the only place LeetCode's code editor is reachable. It has
 * no chrome.* APIs: the isolated content script asks it to reset the editor
 * through a window event and gets the result back the same way.
 *
 * Declared in the manifest instead of injected with chrome.scripting, so the
 * extension doesn't need the "scripting" permission.
 *
 * Event payloads are JSON strings: objects in CustomEvent.detail don't cross
 * between the isolated and main worlds.
 */
window.addEventListener(RESET_REQUEST_EVENT, (event) => {
  let request: ResetRequest;
  try {
    request = JSON.parse(String((event as CustomEvent).detail));
  } catch {
    return;
  }
  if (typeof request?.id !== "string" || typeof request.slug !== "string") return;

  void resetEditorToDefault(request.slug, request.force === true)
    .catch((error: unknown) => ({ ok: false, reason: String(error) }))
    .then((result) => {
      const response: ResetResponse = { id: request.id, result };
      window.dispatchEvent(new CustomEvent(RESET_RESULT_EVENT, { detail: JSON.stringify(response) }));
    });
});
