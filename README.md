# No Peek: Solution Lock & Timer for LeetCode

A Chrome extension that makes you think before you look. When you start a LeetCode problem, the **Editorial**, **Solutions**, your past **Submissions** and the **Discussion** section stay locked for a think time you choose. The problem and the code editor stay fully usable.

## How it works

1. Open any problem. A card asks you to **Start solving**; that starts the timer for that problem.
2. Starting a fresh attempt resets the editor to LeetCode's default template, the same as the editor's Reset button, so your old solution isn't sitting there. Drafts saved in other languages for that problem are cleared too. Your submissions on LeetCode are untouched. If the editor already has code in it (work from another device or browser, or an old solution; the extension can't tell which), nothing is changed until you choose **Start fresh** or **Keep my code**.
3. Opening a locked section, by clicking its tab or visiting its URL directly, shows a lock screen with the time left.
4. When the timer runs out, or as soon as you get **Accepted**, everything unlocks for that problem.

The AI assistant (**Ask Leet**) is locked during think time too.

## Practice history and blind re-solves

Every attempt is recorded locally: how long you took (pauses excluded), how many wrong submissions came before Accepted, and whether you opened a solution section first.

Solved problems come back for a **blind re-solve** on a schedule:

| Result | Next re-solve |
| --- | --- |
| Solved without peeking | 3 days, then 7, 14, 30, 60 and 120 days |
| Peeked before solving (solved or not) | tomorrow, and the ladder starts over |

Opening a due problem says so on the start card. The toolbar icon shows how many problems are due when you're not on a problem page.

**Dashboard** (popup → Dashboard): the re-solve queue, your slowest topics, stats by difficulty, recent attempts, and export/import of your history.

How a solve is detected: when you press Submit (or Cmd/Ctrl+Enter), the extension checks your submission list for that problem on LeetCode for up to two minutes. Run never counts.

## Where the timer shows

- **On the page:** a pill in the bottom-right corner, e.g. `🔒 Solutions unlock in 24:13`, with pause (⏸/▶) and restart (↺) buttons.
- **On the toolbar icon:** minutes left, e.g. `25m` (amber while paused), then a green `✓` once unlocked. Pin the extension (puzzle-piece menu → pin) to keep it visible.
- **In the popup:** click the icon for a live countdown for the problem in the current tab, with Pause and Restart buttons.

## Pause, restart and auto-pause

The timer counts **solving time**, not wall-clock time.

- **Pause / Resume:** stops and restarts the countdown. A pause you make stays until you resume it.
- **Restart:** puts the full think time back (click twice to confirm). It does not reset your code.
- **Auto-pause:** the timer only runs while a tab showing the problem is visible. Switching tabs, minimising the window, closing the tab, or moving to another problem pauses it; coming back resumes it. With the same problem open in two tabs, it keeps running while either one is visible.

Switching to another app while the browser window stays visible does not pause it; the browser doesn't report that as hidden.

Neither button can unlock solutions early: pausing and restarting only delay the unlock, so strict mode stays strict.

The timer is tracked **per problem** and saved, so:

- moving to another problem pauses this one and starts or resumes that problem's own timer,
- reloading the page or opening the problem in a second tab keeps the original start time, and does not reset your code again,
- coming back to a problem within 24 hours keeps its timer; after 24 hours it counts as a fresh attempt.

Submitting your code still shows you the result. Only the list of your past submissions is locked.

## Supporting the project

The popup footer and the dashboard link to donations, and after your 10th solved problem a one-time thank-you note appears; it never shows again. Configure the links in `src/shared/support.ts`:

- `githubSponsorsUrl`: turn on GitHub Sponsors for your account first, or the link is a 404.
- `upiId` and `upiPayeeName`: when set, the dashboard shows a UPI QR code and a copy button.

Leave a value empty to hide that option.

## Settings

Click the extension icon:

| Setting | What it does |
| --- | --- |
| Enabled | Turns the extension on or off. |
| Strict mode | On: no way to unlock early. Off: locked sections show a **Reveal anyway** button (click twice to confirm). |
| Reset code on start | On (default): a fresh attempt replaces your saved code with the default template, asking first if the editor already has code. |
| Think time | Minutes before solutions unlock, between 1 and 180. Default 30. |

Changes apply to open LeetCode tabs immediately.

## Install from source

```bash
npm install
npm run build
```

Then in Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `dist` folder.

For development, `npm run dev` rebuilds on change.

## Project structure

```
src/
  content/
    content.ts   controller: route changes, timer, event interception
    route.ts     everything tied to LeetCode's URLs and DOM
    ui.ts        badge, start card and lock screen (in a shadow root)
  storage/
    settings.ts  user settings (chrome.storage.sync)
    sessions.ts  per-problem start times (chrome.storage.local)
  content/
    tracker.ts   problem details and submission checks (LeetCode GraphQL)
  dashboard/     history, re-solve queue and stats page (React + Tailwind)
  storage/
    history.ts   attempts and re-solve schedule (chrome.storage.local)
  shared/        timer math, re-solve rules, stats, messages, donation links
  popup/         settings and live timer (React + Tailwind)
  background/
    background.ts   toolbar badge, re-solve count, opens the dashboard
  page/             runs in LeetCode's own JS world (manifest world: "MAIN")
    editorBridge.ts receives reset requests from content.ts via window events
    resetEditor.ts  code reset; must bundle with no imports (see shared/bridge.ts)
assets/          icon sources (SVG)
scripts/         icon renderer
manifest.config.ts
```

If a LeetCode redesign breaks the locking, `src/content/route.ts` is the only file that should need changes. If it breaks the code reset, see `src/page/resetEditor.ts`.

## Icon

Edit `assets/icon.svg` (48 and 128 px) or `assets/icon-small.svg` (16 and 32 px), then:

```bash
npm install --no-save @resvg/resvg-js
node scripts/render-icons.mjs
```

## Permissions

- `storage`: saves your settings, per-problem timers and practice history.
- Host access to `leetcode.com`: the content scripts run there and nowhere else.

That's all. The code reset runs in the page through a content script declared with `world: "MAIN"`, which needs no extra permission. Because the extension can't inject into tabs that were already open, reload open LeetCode tabs after installing or updating.

Settings sync through your Chrome account like any extension's synced settings. Your practice history stays in this browser (export it from the dashboard to back it up). Nothing is sent anywhere else.

## Tech

TypeScript, React 19, Tailwind CSS 4, Vite with `@crxjs/vite-plugin`, Manifest V3.
