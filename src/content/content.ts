import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type UserSettings } from "../storage/settings";
import {
  getSession,
  isPaused,
  markRevealedEarly,
  markSessionPeeked,
  markSessionSolved,
  onSessionsChanged,
  pauseSession,
  restartSession,
  resumeSession,
  startSession,
  type ProblemSession,
} from "../storage/sessions";
import {
  beginAttempt,
  getFlags,
  getHistory,
  onHistoryChanged,
  recordPeek,
  recordSolve,
  saveMeta,
  setFlag,
  type ProblemRecord,
} from "../storage/history";
import type { ResetRequestEvent, ResetResponse, ResetResultEvent } from "../shared/bridge";
import type { ExtensionMessage, ResetCodeResult } from "../shared/messages";
import { isDue, relativeDays } from "../shared/review";
import { lastSolved } from "../shared/stats";
import { badgeText, formatRemaining, remainingMs } from "../shared/timing";
import {
  descriptionUrl,
  isSubmitShortcut,
  isSubmitTarget,
  lockedSectionForTarget,
  parseRoute,
  type LockedSection,
  type ProblemRoute,
} from "./route";
import { fetchMeta, scanSubmissions } from "./tracker";
import { PracticeUi, type ViewState } from "./ui";

/**
 * Controller for the content script. It runs on every leetcode.com page
 * (LeetCode is a single-page app, so you can reach a problem without a page
 * load) and only acts on /problems/<slug>/ URLs.
 *
 * One interval drives everything: it notices URL changes and re-renders the
 * countdown. Remaining time is always computed from the stored session, so
 * the display can't drift from the actual unlock time or go negative.
 *
 * Auto-pause: the timer only runs while a tab showing the problem is visible.
 * A tab pauses the timer when it becomes hidden, unloads, or navigates to a
 * different problem; any visible tab on that problem resumes it on its next
 * tick. A pause the user made with the button is never resumed automatically.
 *
 * History: starting records an attempt; opening a solution section before
 * solving records a peek; the first Accepted submission (found by polling
 * your submission list after you press Submit) records the solve, stops the
 * clock, unlocks everything and schedules the next blind re-solve.
 */

const TICK_MS = 500;
const INTERCEPTED_EVENTS = ["pointerdown", "mousedown", "click", "auxclick"] as const;

let ready = false;
let settings: UserSettings = DEFAULT_SETTINGS;
let route: ProblemRoute | null = null;
let session: ProblemSession | null = null;
let currentHref = "";
/** A locked section the user tried to open on a page whose URL isn't locked. */
let interceptedSection: LockedSection | null = null;
/** Guards against an older async session lookup overwriting a newer one. */
let sessionRequest = 0;
/** Short status shown in the corner badge for a few seconds. */
let notice: { text: string; until: number } | null = null;
/** Last value sent for the toolbar badge, to avoid resending every tick. */
let lastToolbarBadge = "";
/** True while an auto-pause or auto-resume write is in flight. */
let autoPauseBusy = false;
/** History record for the current problem, for the start card's review note. */
let problemRecord: ProblemRecord | null = null;
/** Set while asking whether to keep code that was already in the editor. */
let codeChoice: { slug: string; busy: boolean } | null = null;
/** Set while the one-time thank-you is on screen. */
let thankYou: { solvedProblems: number } | null = null;
/** Polling for an Accepted submission after Submit was pressed. */
let watch: { slug: string; until: number; timer: ReturnType<typeof setTimeout> | null } | null = null;

const WATCH_FIRST_POLL_MS = 2500;
const WATCH_INTERVAL_MS = 3000;
const WATCH_DURATION_MS = 120_000;
const THANK_YOU_AFTER = 10;

/**
 * Lifecycle. When the extension is reloaded, updated or removed, this script
 * keeps running in open tabs but every chrome.* call throws "Extension context
 * invalidated". So: check before acting, catch async failures, and shut down
 * cleanly (UI removed, timers and listeners gone). Open LeetCode tabs get the
 * new version when they're reloaded; a newer copy announces itself so this one
 * steps aside.
 */
const INSTANCE = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let stopped = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
const cleanups: (() => void)[] = [];

function extensionAlive(): boolean {
  try {
    return !stopped && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function supersededByNewerCopy(): boolean {
  return document.documentElement.dataset.noPeekInstance !== INSTANCE;
}

function shutdown(): void {
  if (stopped) return;
  stopped = true;
  if (tickTimer) clearInterval(tickTimer);
  if (watch?.timer) clearTimeout(watch.timer);
  watch = null;
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      // Removing a chrome.* listener can itself throw once the context is gone.
    }
  }
  ui.destroy();
}

function isContextInvalidated(error: unknown): boolean {
  return /extension context invalidated/i.test(String((error as Error)?.message ?? error));
}

/** Runs async work in the background; a lost extension context shuts this copy down. */
function bg(work: Promise<unknown>): void {
  work.catch((error: unknown) => {
    if (isContextInvalidated(error) || !extensionAlive()) shutdown();
    else console.warn("[No Peek]", error);
  });
}

/** Wraps an event handler: does nothing once shut down, and never throws into the page. */
function guarded<A extends unknown[]>(handler: (...args: A) => unknown): (...args: A) => void {
  return (...args: A) => {
    if (stopped) return;
    try {
      if (!extensionAlive() || supersededByNewerCopy()) {
        shutdown();
        return;
      }
      const result = handler(...args);
      if (result instanceof Promise) bg(result);
    } catch (error) {
      if (isContextInvalidated(error)) shutdown();
      else console.warn("[No Peek]", error);
    }
  };
}

function listen<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  handler: (event: WindowEventMap[K]) => unknown,
  options?: AddEventListenerOptions,
): void;
function listen(target: Document, type: string, handler: (event: Event) => unknown, options?: AddEventListenerOptions): void;
function listen(target: Window | Document, type: string, handler: (event: Event) => unknown, options?: AddEventListenerOptions): void {
  const wrapped = guarded(handler);
  target.addEventListener(type, wrapped, options);
  cleanups.push(() => target.removeEventListener(type, wrapped, options));
}

const ui = new PracticeUi({
  onStart: guarded(handleStart),
  onBack: guarded(handleBack),
  onRevealEarly: guarded(handleRevealEarly),
  onTogglePause: guarded(handleTogglePause),
  onRestart: guarded(handleRestart),
  onSupport: guarded(() => {
    thankYou = null;
    void sendMessage({ type: "open-dashboard", hash: "#support" });
    render();
  }),
  onDismissThanks: guarded(() => {
    thankYou = null;
    render();
  }),
  onStartFresh: guarded(handleStartFresh),
  onKeepCode: guarded(handleKeepCode),
});

function isLocked(now = Date.now()): boolean {
  if (!ready || !settings.enabled || !route) return false;
  if (!session) return true;
  return remainingMs(session, settings, now) > 0;
}

function sendMessage(message: ExtensionMessage): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // The extension was reloaded or updated; this old content script is orphaned.
    return Promise.resolve(undefined);
  }
}

/** Mirrors the countdown onto the toolbar icon for this tab. */
function updateToolbarBadge(now: number): void {
  const ms = ready && settings.enabled && route && session ? remainingMs(session, settings, now) : null;
  const state = ms === null || ms <= 0 ? "unlocked" : session && isPaused(session) ? "paused" : "locked";
  const text = ms === null ? "" : badgeText(ms);
  if (`${text}|${state}` === lastToolbarBadge) return;
  lastToolbarBadge = `${text}|${state}`;
  void sendMessage({ type: "badge", text, state });
}

function buildView(now: number): ViewState {
  if (!ready || !settings.enabled || !route) {
    return { badge: null, startCard: null, lock: null, codeChoice: null, thankYou: null };
  }

  const locked = isLocked(now);
  if (!locked) interceptedSection = null;

  const remaining = session ? formatRemaining(remainingMs(session, settings, now)) : "";
  const paused = !!session && isPaused(session);
  const noticeText = notice && now < notice.until ? notice.text : null;
  const lockSection = locked ? (route.lockedSection ?? interceptedSection) : null;

  let badge: ViewState["badge"] = null;
  if (session) {
    const state = !locked ? "unlocked" : paused ? "paused" : "locked";
    const text =
      noticeText ??
      (session.solvedAt
        ? `✅ Solved in ${formatRemaining(session.elapsedMs)}`
        : state === "unlocked"
        ? "🔓 Solutions unlocked"
        : state === "paused"
          ? `⏸ Paused · ${remaining} left`
          : `🔒 Solutions unlock in ${remaining}`);
    badge = { state, text, showControls: locked };
  }

  return {
    badge,
    startCard: session
      ? null
      : { thinkTime: settings.thinkTime, resetCode: settings.resetCode, review: reviewNote(problemRecord, now) },
    lock: lockSection
      ? {
          section: lockSection,
          notStarted: !session,
          remainingText: remaining,
          paused,
          canRevealEarly: !settings.strictMode,
        }
      : null,
    codeChoice: codeChoice && codeChoice.slug === route.slug ? { busy: codeChoice.busy } : null,
    thankYou,
  };
}

/** The start card's note about your last attempt at this problem. */
function reviewNote(record: ProblemRecord | null, now: number): string | null {
  if (!record?.attempts.length) return null;
  const solved = lastSolved(record);
  if (!solved?.solvedAt) {
    return "Last time you opened a solution before solving this one. Try it blind again.";
  }
  const how = `${relativeDays(solved.solvedAt, now)} in ${formatRemaining(solved.solveMs ?? 0)}` +
    (solved.peekedAt !== undefined && solved.peekedAt <= solved.solvedAt ? ", after peeking" : "");
  if (isDue(record.review, now)) return `🔁 Due for a blind re-solve. You last solved it ${how}.`;
  const next = record.review?.dueAt && !record.review.retired ? ` Next re-solve is ${relativeDays(record.review.dueAt, now)}.` : "";
  return `You solved this ${how}.${next}`;
}

function render(): void {
  const now = Date.now();
  ui.render(buildView(now));
  updateToolbarBadge(now);
}

function showNotice(text: string, ms = 6000): void {
  notice = { text, until: Date.now() + ms };
  render();
}

async function refreshSession(): Promise<void> {
  const request = ++sessionRequest;
  const slug = route?.slug;
  const [next, history] = slug ? await Promise.all([getSession(slug), getHistory()]) : [null, null];
  if (request !== sessionRequest) return;
  session = next;
  problemRecord = slug && history ? (history[slug] ?? null) : null;
  render();
  trackPeek();
}

/** Opening a solution section after unlock, but before solving, counts as a peek. */
function trackPeek(section: LockedSection | null = route?.lockedSection ?? null): void {
  if (!section || !route || !session || session.solvedAt || session.peeked || isLocked()) return;
  const slug = route.slug;
  const attemptId = session.attemptId;
  session = { ...session, peeked: true };
  bg(markSessionPeeked(slug).then(() => recordPeek(slug, attemptId, Date.now())));
}

/**
 * Polls your submission list for an Accepted result after you press Submit.
 * With durationMs 0 it checks once (used when the tab becomes visible again).
 */
function watchForAccepted(durationMs = WATCH_DURATION_MS): void {
  if (!ready || !settings.enabled || !route || !session || session.solvedAt) return;
  const slug = route.slug;
  const until = Date.now() + durationMs;
  if (watch?.slug === slug) {
    watch.until = Math.max(watch.until, until);
    return;
  }
  if (watch?.timer) clearTimeout(watch.timer);
  watch = { slug, until, timer: null };
  const poll = async () => {
    if (!watch || watch.slug !== slug) return;
    watch.timer = null;
    const current = route?.slug === slug ? session : null;
    if (!current || current.solvedAt) {
      watch = null;
      return;
    }
    const scan = await scanSubmissions(slug, current.attemptId);
    if (scan?.accepted) {
      watch = null;
      await handleSolved(slug, scan.wrong);
      return;
    }
    if (watch && Date.now() < watch.until) watch.timer = setTimeout(() => bg(poll()), WATCH_INTERVAL_MS);
    else watch = null;
  };
  watch.timer = setTimeout(() => bg(poll()), WATCH_FIRST_POLL_MS);
}

async function handleSolved(slug: string, wrongSubmissions: number): Promise<void> {
  const solved = await markSessionSolved(slug, Date.now());
  if (!solved?.solvedAt) return;
  if (route?.slug === slug) session = solved;

  const result = await recordSolve(slug, solved.attemptId, {
    solvedAt: solved.solvedAt,
    solveMs: solved.elapsedMs,
    peeked: !!solved.peeked,
    wrongSubmissions,
  });
  if (route?.slug === slug) problemRecord = result.record;

  const next = result.record.review?.dueAt;
  showNotice(
    `✅ Accepted in ${formatRemaining(solved.elapsedMs)}` + (next ? ` · re-solve ${relativeDays(next, Date.now())}` : ""),
    8000,
  );

  if (result.solvedProblems >= THANK_YOU_AFTER && !(await getFlags()).thankYouShown) {
    await setFlag("thankYouShown", true);
    thankYou = { solvedProblems: result.solvedProblems };
    render();
  }
}

function handleSubmitIntent(event: Event): void {
  const isSubmit =
    event.type === "keydown" ? isSubmitShortcut(event as KeyboardEvent) : isSubmitTarget(event.target);
  if (isSubmit) watchForAccepted();
}

function handleRouteChange(): void {
  currentHref = location.href;
  const next = parseRoute(location.pathname);
  const sameProblem = next?.slug === route?.slug;
  // Leaving a problem in this tab pauses its timer.
  if (!sameProblem && route && session && !isPaused(session) && isLocked()) {
    bg(pauseSession(route.slug, "auto"));
  }
  route = next;
  interceptedSection = null;
  if (!sameProblem) {
    session = null;
    problemRecord = null;
    // Leaving the problem keeps the code: nothing was changed while asking.
    codeChoice = null;
  }
  render();
  bg(refreshSession());
  // LeetCode may open the result page after a submit.
  if (/\/submissions\/\d+/.test(location.pathname)) watchForAccepted();
}

async function handleStart(): Promise<void> {
  if (!route) return;
  const slug = route.slug;
  const wasDue = isDue(problemRecord?.review, Date.now());
  const { session: started, created } = await startSession(slug);
  if (route?.slug !== slug) return;
  session = started;
  render();

  if (created) {
    bg(beginAttempt(slug, started.attemptId, wasDue));
    if (!problemRecord?.meta) {
      bg(fetchMeta(slug).then((meta) => meta && saveMeta(slug, meta)));
    }
  }

  // Only a fresh attempt resets the code. A session that already existed
  // (started in another tab) means you may have work in progress.
  if (created && settings.resetCode) await resetCode(slug, false);
}

/**
 * Resets the editor to the default template. Unforced, it leaves code that is
 * already in the editor alone and asks instead: a fresh attempt on this
 * device may follow work done on another one, which this device can't know.
 */
async function resetCode(slug: string, force: boolean): Promise<void> {
  showNotice("↺ Resetting code to the default template…", 20_000);
  const result = await requestReset(slug, force);
  if (route?.slug !== slug) return;
  if (result.existingCode) {
    notice = null;
    codeChoice = { slug, busy: false };
    render();
    return;
  }
  codeChoice = null;
  if (result.ok) showNotice("↺ Code reset to the default template", 3000);
  else showNotice(`⚠️ Couldn't reset code: ${result.reason ?? "no response"}`, 8000);
}

const RESET_REQUEST_EVENT: ResetRequestEvent = "no-peek:reset-request";
const RESET_RESULT_EVENT: ResetResultEvent = "no-peek:reset-result";

/** Longest a reset can take: waiting for the editor, the draft check and the save. */
const RESET_TIMEOUT_MS = 45_000;

/**
 * Asks the page-world bridge (page/editorBridge.ts) to reset the editor. The
 * editor only exists in the page's own JavaScript world, which this isolated
 * content script can reach only through window events.
 */
function requestReset(slug: string, force: boolean): Promise<ResetCodeResult> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const finish = (result: ResetCodeResult) => {
      window.removeEventListener(RESET_RESULT_EVENT, onResult);
      clearTimeout(timeout);
      resolve(result);
    };
    const onResult = (event: Event) => {
      try {
        const response = JSON.parse(String((event as CustomEvent).detail)) as ResetResponse;
        if (response?.id === id && response.result) finish(response.result);
      } catch {
        // Not ours.
      }
    };
    const timeout = setTimeout(() => finish({ ok: false, reason: "The editor didn't respond." }), RESET_TIMEOUT_MS);
    window.addEventListener(RESET_RESULT_EVENT, onResult);
    window.dispatchEvent(new CustomEvent(RESET_REQUEST_EVENT, { detail: JSON.stringify({ id, slug, force }) }));
  });
}

async function handleStartFresh(): Promise<void> {
  if (!route || !codeChoice || codeChoice.slug !== route.slug || codeChoice.busy) return;
  codeChoice = { ...codeChoice, busy: true };
  render();
  try {
    await resetCode(route.slug, true);
  } finally {
    // Never leave the editor blurred out behind a stuck dialog.
    if (codeChoice?.busy) codeChoice = null;
    render();
  }
}

function handleKeepCode(): void {
  if (!codeChoice) return;
  codeChoice = null;
  showNotice("✓ Kept your code", 3000);
}

function handleBack(): void {
  if (route?.lockedSection) {
    location.assign(descriptionUrl(route.slug));
    return;
  }
  interceptedSection = null;
  render();
}

async function handleTogglePause(): Promise<void> {
  if (!route || !session || !isLocked()) return;
  if (isPaused(session)) await resumeSession(route.slug);
  else await pauseSession(route.slug, "user");
  await refreshSession();
}

async function handleRestart(): Promise<void> {
  if (!route || !session) return;
  await restartSession(route.slug);
  await refreshSession();
  showNotice("↺ Timer restarted", 2500);
}

/** Pauses the timer because this tab is going away (hidden, closed, unloaded). */
function autoPause(): void {
  if (!route || !session || isPaused(session) || !isLocked()) return;
  // pauseSession is idempotent, so visibilitychange followed by pagehide is fine.
  bg(pauseSession(route.slug, "auto"));
}

/** Resumes an auto-paused timer when this tab is showing the problem again. */
function maybeAutoResume(): void {
  if (autoPauseBusy || document.visibilityState !== "visible") return;
  if (!route || !session || !isPaused(session) || session.pausedBy !== "auto" || !isLocked()) return;
  autoPauseBusy = true;
  bg(
    resumeSession(route.slug, { onlyIfAuto: true })
      .then(refreshSession)
      .finally(() => {
        autoPauseBusy = false;
      }),
  );
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "hidden") autoPause();
  else {
    maybeAutoResume();
    // You may have submitted from another tab or device meanwhile.
    if (session && !session.solvedAt) watchForAccepted(0);
  }
}

async function handleRevealEarly(): Promise<void> {
  if (!route || !session || settings.strictMode) return;
  const { slug } = route;
  const { attemptId } = session;
  await markRevealedEarly(slug);
  await recordPeek(slug, attemptId, Date.now());
  await refreshSession();
}

/**
 * Blocks opening a locked section before LeetCode sees the event. LeetCode's
 * tabs switch on pointerdown, so click alone is not enough. Only the event
 * target's ancestors are inspected; the page is never scanned.
 */
function interceptLockedInteraction(event: Event): void {
  if (event.composedPath().includes(ui.element)) return;
  if (!isLocked()) {
    // Unlocked: let it through, but note a peek before solving.
    if (event.type === "pointerdown" && session && !session.solvedAt && !session.peeked) {
      trackPeek(lockedSectionForTarget(event.target));
    }
    return;
  }

  const section = lockedSectionForTarget(event.target);
  if (!section) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === "pointerdown" || event.type === "click") {
    interceptedSection = section;
    render();
  }
}

async function main(): Promise<void> {
  // Announce this copy; an older copy still running in this tab steps aside.
  document.documentElement.dataset.noPeekInstance = INSTANCE;

  for (const type of INTERCEPTED_EVENTS) {
    listen(window, type, interceptLockedInteraction, { capture: true });
  }

  settings = await loadSettings();
  ready = true;

  cleanups.push(
    onSettingsChanged(
      guarded((next: UserSettings) => {
        settings = next;
        render();
      }),
    ),
    onSessionsChanged(guarded(refreshSession)),
    onHistoryChanged(guarded(refreshSession)),
  );
  listen(window, "popstate", handleRouteChange);
  listen(document, "visibilitychange", handleVisibilityChange);
  listen(window, "pagehide", autoPause);
  listen(window, "click", handleSubmitIntent, { capture: true });
  listen(window, "keydown", handleSubmitIntent, { capture: true });

  handleRouteChange();
  // A problem opened in a background tab shouldn't keep a running timer going.
  await refreshSession();
  if (document.visibilityState === "hidden") autoPause();

  tickTimer = setInterval(
    guarded(() => {
      if (location.href !== currentHref) handleRouteChange();
      else render();
      maybeAutoResume();
    }),
    TICK_MS,
  );
}

bg(main());
