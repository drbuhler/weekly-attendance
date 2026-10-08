# weekly-attendance

A single-page, passcode-protected attendance dashboard served by GitHub Pages.

The site is static: `index.html`, `app.js`, `app.css`, and one encrypted data file,
`data.enc.json`. No names or attendance exist anywhere in this repository in readable
form. The browser downloads the encrypted file and decrypts it locally after the
correct passcode is entered; until then the page shows only a lock screen.

> The passcode is shared privately and is never stored in this repository.
>
> **Testing without real data:** `tools/make_synthetic.py` makes a fake roster. Build it to a
> scratch path (`-o /tmp/test.enc.json`) with a throwaway passcode and check it with
> `tools/browser_check.py --enc /tmp/test.enc.json`. Never commit a test build over the live
> `data.enc.json`.

## How it works

| Piece | What it does |
|---|---|
| `tools/export_weekly_tabs.py` | Reads an `.xlsx` download of the attendance sheet and writes the main-list check-in CSV plus a counts-only visitor file (both outside the repo). |
| `tools/build_encrypted.py` | Reads those files, merges duplicate spellings, encrypts, and writes **only** `data.enc.json`. |
| `tools/names.py` | Shared name normalization used for merging and for de-duplicating visitors. |
| `index.html` + `app.js` | Lock screen, then in-browser decryption (WebCrypto) and the dashboard. |
| `tools/check_staged.py` | Pre-commit guard that blocks CSV/XLSX/JSON files, malformed `data.enc.json`, and anything resembling check-in rows. |
| `tools/browser_check.py` | Headless-Chromium round-trip test that prints aggregate counts only. |
| `tools/make_synthetic.py` | Generates a fake roster for testing. |

**Crypto:** PBKDF2-HMAC-SHA256 (650,000 iterations; minimum 600,000) with a random
16-byte salt → AES-256-GCM with a random 12-byte IV. `data.enc.json` is
`{"v":1,"salt":…,"iv":…,"iter":…,"ct":…}` (base64; `ct` includes the GCM tag). A new
salt and IV are generated on every build.

**Where visitors show:** an "+ N visitors" line on the *Attended* card for the latest
week, and a small "Visitors per week" row under the weekly-attendance bars (also in each
bar's tooltip).

**"Keep unlocked until this tab is closed"** stores the derived key (not the passcode)
in `sessionStorage` only. Nothing is written to `localStorage` or cookies. The **Lock**
button clears it.

**Rules the page applies**

- *Weeks absent* = consecutive missed Sundays counting back from the latest week.
- **Red** = 5 or more in a row. **Yellow** = 3–4 in a row. Everyone else is OK.
- Weeks before a person first appears on a sheet are *not yet enrolled*, and weeks
  their name is missing from the sheet after that are *not on that week's sheet*.
  Neither counts as an absence, and both get their own neutral cell in the heatmap.
- Attendance % = Sundays attended ÷ Sundays they were on the sheet.
- Names that differ only by case, spacing, punctuation, or word order are merged.
- **Visitors** are people checked in from the "NEW NAMES, NOT YET ON LIST" area, or on
  checkbox rows that aren't on the main list, who are not already on the main list (that
  week or an earlier one). They are de-duplicated against the main list and within the
  week using the same name normalization. **Only a per-week count is kept**: their names
  are never written to any file or put in the encrypted payload. Visitors are left out of
  the people total, red/yellow/OK, the heatmap, and attendance %. Once a name is added to
  the main list, that person appears normally from that week on.
- Someone who is **already on the main list** (that week or any earlier week) but checked
  in through the newcomer area (or an off-list row) is counted **present** that week, even
  if their main-list box is unticked or they have no main-list row that week. They are not
  counted as absent, as a visitor, or as "not on that week's sheet".
- A cell with `x` is treated as attended.

## One-time setup (on the shared computer)

```sh
git clone https://github.com/drbuhler/weekly-attendance.git /workspace/weekly-attendance
cd /workspace/weekly-attendance
python3 -m venv ~/.venvs/attendance
~/.venvs/attendance/bin/pip install cryptography openpyxl
sh tools/install-hooks.sh          # installs the plaintext-data pre-commit guard
```

## Weekly refresh

Keep roster files in `/workspace/catechumen-dashboard/` (outside this repo), never in it.

```sh
cd /workspace/weekly-attendance && git pull

# 1. Export: download the Google Sheet as .xlsx (File → Download → Microsoft Excel)
#    to /workspace/catechumen-dashboard/catechism-attendance.xlsx, then:
~/.venvs/attendance/bin/python tools/export_weekly_tabs.py \
    /workspace/catechumen-dashboard/catechism-attendance.xlsx \
    /workspace/catechumen-dashboard/weekly_tabs_attendance.csv
#    Uses the latest 8 dated tabs up to today. It also writes the counts-only file
#    /workspace/catechumen-dashboard/weekly_tabs_attendance.visitors.csv (week,visitors).

# 2. Encrypt. You'll be prompted for the passcode twice; it is never a command-line argument.
~/.venvs/attendance/bin/python tools/build_encrypted.py \
    /workspace/catechumen-dashboard/weekly_tabs_attendance.csv \
    --title "Catechumen attendance"

# 3. Publish only the encrypted file.
git add data.enc.json
git commit -m "Weekly attendance update"
git push
```

The build picks up `<csv name>.visitors.csv` automatically when it sits next to the CSV
(or pass `--visitors PATH`, or `--no-visitors`). It prints aggregate counts (people,
red/yellow, weekly %, visitors) so you can sanity-check
them before pushing. GitHub Pages republishes within a minute or two. Optionally,
before pushing, run a headless round trip (needs `pip install playwright`). It also
asks for the passcode via the environment and prints counts only:

```sh
read -rs ATTENDANCE_PASSCODE && export ATTENDANCE_PASSCODE
~/.venvs/attendance/bin/python tools/browser_check.py --enc data.enc.json
unset ATTENDANCE_PASSCODE
```

## Passcode guidance

Anyone can download `data.enc.json` and try passcodes offline, so passcode strength is
the real protection. Use **4+ random words** (e.g. from a diceware list) or **16+ random
characters**. Share it privately (never in this repo, an issue, or a commit message),
and change it if it may have leaked. To change it, rebuild with the new passcode and
push; older ciphertext stays in git history and still opens with the old passcode.

## Privacy notes

- `.gitignore` blocks CSV/XLSX/JSON/text exports. Only `data.enc.json` is allowed.
- The pre-commit guard (`tools/install-hooks.sh`) rejects data files and check-in-like
  text. Run `python3 tools/check_staged.py --all` to scan every tracked file.
- `robots.txt` disallows all crawling, and the page carries `noindex,nofollow`.
- A GitHub Pages site is publicly reachable even when the repository is private.
