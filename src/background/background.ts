import type { ExtensionMessage } from "../shared/messages";
import { APP_NAME, FULL_NAME } from "../shared/brand";
import { dueProblems } from "../shared/stats";
import { getHistory } from "../storage/history";

const BADGE_COLORS = {
  locked: "#374151",
  paused: "#b45309",
  unlocked: "#16a34a",
} as const;
const DUE_COLOR = "#7c3aed";

// Chrome doesn't inject content scripts into tabs that were already open, so
// LeetCode tabs open during an install or update start working once reloaded.
// (Injecting into them would need the "scripting" permission.)
chrome.runtime.onInstalled.addListener(() => void updateDueBadge());
chrome.runtime.onStartup.addListener(() => void updateDueBadge());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.history) void updateDueBadge();
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender) => {
  if (message.type === "open-dashboard") {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${message.hash ?? ""}`) });
    return;
  }

  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  if (message.type === "badge") {
    void setBadge(tabId, message.text, message.state);
    // Problems become due as time passes; refresh at most once a minute.
    void maybeRefreshDueBadge();
    return;
  }
});

/**
 * Per-tab toolbar badge: minutes left (amber while paused), a check once
 * unlocked. An empty text hands the tab back to the global badge, which shows
 * how many problems are due for a re-solve.
 */
async function setBadge(tabId: number, text: string, state: keyof typeof BADGE_COLORS): Promise<void> {
  try {
    if (!text) {
      // null (not "") reverts this tab to the global badge.
      await chrome.action.setBadgeText({ tabId, text: null as unknown as string });
      return;
    }
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS[state] });
    await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
  } catch {
    // The tab was closed between the message and the update.
  }
}

let lastDueRefresh = 0;

function maybeRefreshDueBadge(): Promise<void> {
  if (Date.now() - lastDueRefresh < 60_000) return Promise.resolve();
  return updateDueBadge();
}

async function updateDueBadge(): Promise<void> {
  lastDueRefresh = Date.now();
  try {
    const due = dueProblems(await getHistory(), Date.now()).length;
    await chrome.action.setBadgeText({ text: due > 0 ? String(due) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: DUE_COLOR });
    await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    await chrome.action.setTitle({
      title: due > 0 ? `${APP_NAME}: ${due} problem${due === 1 ? "" : "s"} due for a re-solve` : FULL_NAME,
    });
  } catch {
    // Badge APIs can fail during shutdown; the next event retries.
  }
}

void updateDueBadge();
