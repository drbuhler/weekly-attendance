# weekly-attendance

Passcode-protected attendance dashboard for the catechumen roll sheet, served by GitHub Pages.
Nothing readable is in this repository: the page decrypts `data.enc.json` in the browser
(PBKDF2-SHA256, 650,000 iterations → AES-256-GCM). The passcode is never stored here.

## How it works

1. **Lock screen.** The passcode decrypts `data.enc.json`, which holds:
   - the **last good snapshot** of the roster (a fallback), and
   - where the **published Google Sheet** lives (so that link is never in this repo in plain text).
2. **Snapshot first.** The snapshot is drawn right away with "Showing saved data as of …".
3. **Live upgrade.** The page then reads the published sheet directly. It reads the tab list
   (`pubhtml`), each recent weekly tab, `History` and `Archive` as CSV. If that works and the
   result looks sane, it switches to "Live from the roll sheet · loaded <time>". The **Refresh**
   button re-reads it.
4. **Never an error page.** If the live read fails for any reason (Google down, CORS, rate limit,
   timeout after 20 s, a layout change, implausible numbers), the snapshot stays on screen with a
   note. A failed Refresh keeps the data that was already loaded.
5. **Cache-safe deploys.** The page assets are versioned (`assets/app.3.js`, `assets/roll.3.js`,
   `assets/app.3.css`). The older versions (`assets/*.2.*` and the root `app.js` / `app.css`) are
   kept, so a browser holding a cached old `index.html` keeps working. A new change gets new
   file names (`*.4.*`). **Never delete `data.enc.json` or old assets.**

### Rules (the same for the snapshot and the live data)

- **Weekly tabs** are named like `Oct 4` / `Sept 20`. The latest 8 that have happened are used.
  A Sunday's tab counts only from **12:00 PM Pacific** that day. Future tabs, and today's tab
  before noon, are ignored entirely.
- **Main list:** column B check box, column C `Last, First`.
- **Canonical roster:** only people on the **newest counted tab** are tracked (its main list, or
  checked in through the newcomer area that day while already on the list). Everyone else
  disappears from every count, streak and percentage.
- **Enrollment start:** weeks before someone's first appearance are "not yet enrolled", never absent.
  Weeks their name was missing from the sheet are skipped in streaks.
- **Newcomers** (NEW NAMES area H/I, or write-ins in C without a comma) count only as a weekly
  **Visitors** number. They are never named and are never moved onto the main list. A newcomer
  entry for someone already on the main list counts them present.
- **Red** = 5+ Sundays missed in a row; **Yellow** = 3–4.
- **Last seen:** the most recent Sunday attended, from the loaded weeks or, before them, the
  sheet's older record: the master grids `Attendance 0525-0226`, `0301` and `May 17` (since May
  2025), the summer tabs, and the weekly tabs from Aug 9. That older record does not change, so
  `tools/build_snapshot.py` bakes it into the encrypted snapshot (`tools/older_record.py`). The
  page reads nothing extra and nothing can fail at load time.
  - Weeks with almost no check marks are skipped: Dec 28 2025, Mar 1 2026 and the blank `May 17`
    column. Mar 22 – May 31 2026 (post-Pascha self-check) counts presence only.
  - An older spelling of the same person (e.g. a one-letter first-name variant) is matched when it
    is the only candidate.
  - In the red, yellow and Everyone lists, an attendance inside the loaded weeks shows as `Sep 6`
    and an older one as `Last seen Mar 2026`. `never` means no attendance anywhere in the sheet.
- **Baptized marker:** a check box (or `x` / `Baptized`) in **column D** on the newest tab. Marked
  people are shown with a "baptized" tag but are left out of red/yellow and the weekly counts. The
  weekly script highlights them so Martha can remove them.
- **Archive:** people who left the list (see the script below). The dashboard shows
  "Baptized this year" (and chrismated), plus recent baptisms. A tracked person who is also on the
  Archive is a **comeback**: any weeks missing from the loaded tabs are restored from their
  Archive "Week history".
- **Name check** (behind the passcode): likely duplicates and near-misspellings among the tracked
  roster, people who left the list in the loaded weeks, and the Archive. It ignores case, spacing,
  `Last, First` order, hyphens and Jr./Sr., then looks for a one-letter difference in the first or
  last name. Nothing is merged automatically. Newcomer names are not listed on the dashboard;
  they are on the sheet's own `Name check` tab.

## The Google Sheet

It must be published: **File → Share → Publish to web → Entire document → Web page**.
**The published sheet is public.** Anyone with its link can read every visible tab, including
names, without the passcode. The passcode protects this dashboard and that link, not the sheet
itself. Google updates the published copy about every 5 minutes.

### Apps Script (`tools/weekly_tab.gs`)

Paste the file into **Extensions → Apps Script**, save, and run `setupAttendanceSheet` once.
After that it runs `weeklyUpdate` every **Sunday at about 3 PM Pacific**. Each run:

1. **Archive:** names on the previous Sunday's tab but not on the newest are added to `Archive`
   with their week history. Martha picks a **Reason** (Baptized / Chrismated / Washed out / Moved /
   Other).
2. **Comebacks:** an archived person back on the newest tab gets a `Returned` date.
3. **New tab:** creates next Sunday's tab as a copy, with check boxes and newcomer names cleared.
4. **History:** weekly tabs (from `Aug 9` on, so the `May 17` master grid and the summer tabs are
   left alone) 6+ weeks old are copied to `History`, verified, then hidden. A tab is never
   hidden if its copy failed. Published pages leave hidden tabs out, so the dashboard reads those
   weeks from `History`.
5. **Name check:** rewrites the `Name check` tab.

Tab layouts written by the script (keep `History` and `Archive` visible and published):

| Tab | Columns |
| --- | --- |
| `History` | `Date` (text yyyy-mm-dd of the Sunday) · `Section` (`main` = B/C pair, `new` = H/I pair) · `Name` · `Checked` (TRUE/FALSE/x as on the tab) |
| `Archive` | `Name` · `Left on` · `Last on list` · `Reason` (dropdown) · `First seen` · `Sundays on list` · `Sundays present` · `Returned` · `Week history` (`2026-08-16:P 2026-08-23:A …`) · `Archived on` |
| `Name check` | `Name` · `Where` · `Looks like` · `Where` · `Why` · `Checked on` |

The menu **Attendance → Fix Dashboard session counts shown as dates** turns cells in columns E and
G of the sheet's own `Dashboard` tab that Sheets read as dates (e.g. `6/15`) into text (`6 of 15`).
It also sets those columns to plain text.

## Rebuilding the snapshot / changing the passcode

The snapshot is only the fallback, so rebuild it now and then and whenever the passcode changes.
It reads the published sheet's `.xlsx` export, which includes hidden tabs.

```sh
cd /workspace/weekly-attendance
read -rs ATTENDANCE_PASSCODE && export ATTENDANCE_PASSCODE   # or omit and be prompted twice
ATTENDANCE_SHEET_URL='https://docs.google.com/…/pubhtml' ~/.venvs/attendance/bin/python tools/build_snapshot.py
#   (or leave ATTENDANCE_SHEET_URL unset to be prompted for it, hidden)
unset ATTENDANCE_PASSCODE
git add data.enc.json && git commit -m "Weekly attendance update" && git push
```

It prints aggregate counts only. Roster files exist only in a private temp dir that is deleted
afterwards. To check before pushing:

```sh
ATTENDANCE_PASSCODE=… python3 tools/parity_check.py sheet.xlsx [--simulate-hidden 4] [--now 2026-10-11T12:00:00-07:00]
ATTENDANCE_PASSCODE=… python3 tools/browser_check.py [--scenario google-down|http500|timeout|nocors|html|history] [--width 390]
```

- `parity_check` proves the browser parser equals the Python export, including History.
- `browser_check` runs headless Chromium against a local copy. It can inject failures, a History
  tab, an Archive tab and a fake clock.

## Passcode guidance

Anyone can download `data.enc.json` and try passcodes offline, so passcode strength is the real
protection. Use **4+ random words** or **16+ random characters**. Share it privately (never in
this repo, an issue, or a commit message). To change it, rebuild with the new passcode and push.
Older ciphertext stays in git history and still opens with the old passcode.

## Privacy notes

- `.gitignore` blocks CSV/XLSX/JSON/text exports. Only `data.enc.json` is allowed.
- The pre-commit guard (`tools/install-hooks.sh`) rejects data files, check-in-like text and
  Google Sheets links/ids. Run `python3 tools/check_staged.py --all` to scan every tracked file.
- `robots.txt` disallows all crawling, and the page carries `noindex,nofollow`.
- A GitHub Pages site is publicly reachable even when the repository is private.
