# weekly-attendance

A single-page, passcode-protected attendance dashboard served by GitHub Pages. It reads the
roll sheet **live** from Google Sheets, so there's no weekly refresh step.

## How it works

1. The page loads `config.enc.json`, which is encrypted and holds the published sheet's
   address and a few settings. The repository contains no names, no attendance, and no
   sheet link in readable form.
2. After the correct passcode is entered, the browser decrypts the config (WebCrypto:
   PBKDF2-HMAC-SHA256, 650,000 iterations, random 16-byte salt → AES-256-GCM, random
   12-byte IV). A wrong passcode shows a friendly error, and nothing else is fetched.
3. The page reads the sheet's published tab list (`…/pubhtml`), picks the weekly tabs,
   downloads each one as CSV (`…/pub?gid=…&single=true&output=csv`, CORS-enabled by
   Google), and builds the dashboard in the browser with `roll.js`.
4. **Refresh** reloads the sheet. The header shows "Live from the roll sheet · loaded
   <time>". If the sheet can't be reached (unpublished, offline), a friendly message
   appears; after a failed refresh, the data loaded earlier stays on screen.

"Keep unlocked until this tab is closed" stores the derived key (not the passcode) in
`sessionStorage` only. Nothing is written to `localStorage` or cookies. **Lock** clears it.

### Which tabs count

- Weekly tabs are the ones named like a date: `Oct 4`, `Sept 20`, `July5`. Other tabs
  (`Dashboard`, `Visitors`, …) are ignored. A **new Sunday tab is picked up automatically**
  as soon as it is published, with no code change. The latest 8 count.
- A tab counts from **12:00 PM Pacific on its own date** (check-ins finish around 11:30
  AM). Future tabs, and today's tab before noon, are ignored entirely: no absences, streaks,
  KPIs, or visitors. This uses the Pacific clock whatever the viewer's time zone.
- Year: a tab's month is taken as this year unless it's later than the current month (then
  last year).

### Rules (same as `tools/export_weekly_tabs.py`, and verified identical)

- **Main list:** column B is the checkbox (TRUE, or `x`), and column C is "Last, First"
  (contains a comma).
- **Newcomers:** checked-in rows in the "NEW NAMES, NOT YET ON LIST" area (column H checkbox,
  column I name) and checked-in column C rows without a comma.
  - If the person is **already on the main list** (that week or an earlier counted week), they
    count **present** that week, even with an unticked or missing main-list row.
  - Otherwise they're a **visitor**. Visitors appear **only as a per-week count** (on the
    Attended card and under the weekly bars). Their names are used only to de-duplicate
    and count, and are never displayed or kept. They're excluded from the people total,
    red/yellow/OK, the heatmap, and attendance %.
- Names that differ only by case, spacing, punctuation, or word order are merged.
- *Weeks absent* = consecutive missed Sundays counting back from the latest counted week.
  **Red** = 5 or more in a row, **Yellow** = 3–4, otherwise OK. Weeks before a person's
  first appearance are *not yet enrolled*, and weeks their name is missing from the sheet
  are *not on that week's sheet*. Neither counts as an absence.
- Attendance % = Sundays attended ÷ Sundays they were on the sheet.

## Changing the passcode or the sheet link (re-key)

Both live only inside `config.enc.json`. Re-encrypt and push:

```sh
cd /workspace/weekly-attendance && git pull
~/.venvs/attendance/bin/python tools/encrypt_config.py
#   prompts (hidden) for the published sheet URL (the …/pubhtml link from
#   File → Share → Publish to the web) and for the new passcode, twice.
#   Or set ATTENDANCE_SHEET_URL / ATTENDANCE_PASSCODE in the environment instead.
git add config.enc.json && git commit -m "Update config" && git push
```

Never put the passcode on the command line, and never commit the sheet link in plain text
(the pre-commit guard blocks it). Old encrypted configs remain in git history and still
open with their old passcode. If a passcode leaks, also **re-publish the sheet under a new
link** (unpublish, then publish again) and re-key.

One-time setup on a new machine:

```sh
git clone https://github.com/drbuhler/weekly-attendance.git && cd weekly-attendance
python3 -m venv ~/.venvs/attendance && ~/.venvs/attendance/bin/pip install cryptography openpyxl playwright
sh tools/install-hooks.sh   # plaintext-data / sheet-link pre-commit guard
```

## Testing

```sh
# Parser parity: roll.js (under Node) vs the Python export on an .xlsx download of the sheet.
# Counts only. Use --now to test the noon-Pacific rule.
~/.venvs/attendance/bin/python tools/parity_check.py /path/to/sheet.xlsx --now 2026-10-11T12:00:00-07:00

# Headless browser against the deployed site (counts only; reads the passcode from the env).
read -rs ATTENDANCE_PASSCODE && export ATTENDANCE_PASSCODE
~/.venvs/attendance/bin/python tools/browser_check.py --url https://drbuhler.github.io/weekly-attendance/ [--width 390] [--now …]
unset ATTENDANCE_PASSCODE
```

The weekly-snapshot tools from the earlier design are kept only for testing:
`export_weekly_tabs.py` (the reference implementation for the parity check),
`build_encrypted.py` (shared crypto, plus the old snapshot builder), and `make_synthetic.py`
(fake roster). The page no longer uses a data snapshot.

## Privacy notes and caveats

- **The published sheet is public to anyone who has its link.** The passcode protects
  the dashboard and hides the link, but anyone holding the link can read the sheet directly.
  Treat the link as a secret, and unpublish/re-publish it to revoke access.
- The passcode is the real protection for the config, since anyone can download
  `config.enc.json` and guess offline. Use 4+ random words or 16+ random characters.
- Google republishes edits with a delay, typically up to ~5 minutes, so a check-in may take
  a few minutes to appear even after Refresh.
- Tab discovery reads Google's `pubhtml` page, which isn't a documented API. If Google
  changes that page, the dashboard shows its "couldn't load" message and `roll.js`
  `discoverTabs` needs an update.
- `.gitignore` blocks CSV/XLSX/JSON exports (only `config.enc.json` is allowed). The
  pre-commit guard rejects data files, check-in-like rows, and Google Sheets ids/links. Run
  `python3 tools/check_staged.py --all` to scan everything tracked.
- `robots.txt` disallows crawling, and the page carries `noindex,nofollow`.
- The page's Content-Security-Policy only allows connections to this site, `docs.google.com`,
  and `*.googleusercontent.com` (where Google serves the CSVs).
