# Privacy Policy: No Peek: Solution Lock & Timer for LeetCode

Last updated: 25 October 2026

No Peek handles some data to work, and all of it stays in your browser. Nothing is sent to the developer or to any third party, and nothing is sold or shared. The only requests the extension makes go to LeetCode itself.

In the Chrome Web Store's terms, the extension handles:

- **Web history:** which LeetCode problems you attempt, and when.
- **User activity:** whether you opened a solution section before solving, and how many submissions were rejected before Accepted.
- **Website content:** problem titles, difficulty, topic tags and default code templates read from LeetCode.

It handles no personally identifiable, health, financial, authentication, communication or location data.

## What the extension stores

All data stays in your browser:

| Data | Where | Why |
| --- | --- | --- |
| Your settings (enabled, strict mode, reset code on start, think time) | `chrome.storage.sync` | So your settings follow your Chrome profile. Chrome syncs this through your Google account, like any extension's settings. |
| For each problem you start: its URL name (for example `two-sum`), when you started, solving time so far, and whether it is paused | `chrome.storage.local`, on this device only | So the timer survives reloads, second tabs and switching problems. Entries are deleted automatically after 24 hours. |
| Your practice history: for each problem you attempt, its number, title, difficulty and topic tags; for each attempt, when it started, how long you took, how many wrong submissions came before Accepted, and whether you opened a solution section first; and when the problem is next due for a re-solve | `chrome.storage.local`, on this device only | To show your dashboard and schedule blind re-solves. It stays until you delete it from the dashboard or uninstall the extension. |

## What the extension does on leetcode.com

The extension runs only on `leetcode.com`. It does not run on any other site. All requests below go only to LeetCode's own server (`leetcode.com/graphql`), from inside the LeetCode page, with your existing LeetCode session, exactly like the site's own requests.

**When you start a problem**, the extension requests the problem's number, title, difficulty and topic tags, for your practice history.

**When you press Submit**, the extension reads your recent submissions for that problem (their status, such as "Accepted" or "Wrong Answer", and their time) to detect when you solved it. It never reads the code of your submissions and never changes them.

**When you start a fresh attempt with Reset code on start turned on**, the extension, inside the LeetCode page:

- requests the problem's default code template;
- reads which programming language you have selected, from LeetCode's storage in your browser;
- checks whether the editor already contains code. If it does, nothing is changed until you choose **Start fresh** or **Keep my code**;
- replaces the code in the editor with the default template;
- deletes the drafts LeetCode saved in your browser for that problem in other languages.

You can turn the reset off at any time with the **Reset code on start** setting.

## What the extension does not do

- It does not send any data to the developer or to any third party.
- It does not use analytics, tracking or advertising.
- It does not read your LeetCode account details, the code of your submissions, or your browsing on other sites.
- It does not load or run code from any remote server.

## Donations

The extension links to GitHub Sponsors and, where configured, shows a UPI payment code. These only open when you click them. The extension never sees payment details; payments happen entirely on GitHub or in your UPI app.

## Removing your data

Delete your practice history at any time from the dashboard (**Your data → Delete history**). Uninstalling the extension removes everything it stored.

## Contact

Questions: duhananant@gmail.com, or open an issue at
https://github.com/AnantDuhan/Leetcode-Blind-Practice-Extension/issues