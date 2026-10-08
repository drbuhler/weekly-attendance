#!/usr/bin/env python3
"""Export the weekly sign-in tabs of the attendance workbook (.xlsx download of the Google Sheet)
to the CSV that tools/build_encrypted.py reads. Generalises the original parse_export.py.

    python3 tools/export_weekly_tabs.py ~/Downloads/attendance.xlsx /workspace/catechumen-dashboard/weekly_tabs_attendance.csv

* Weekly tabs are sheets named like "Oct 4" / "Sept 20" / "July5". By default the latest
  8 whose date is not in the future are used (--weeks N, --through YYYY-MM-DD, or --tabs ...).
* Main list: column B = checkbox, column C = "Last, First" (same rule as parse_export.py).
* --include-new-names also reads the "NEW NAMES, NOT YET ON LIST" area (column H checkbox,
  column I name) and checkbox rows in column C written without a comma. Without it, people only
  count once their name has been added to the main list.
The output CSV holds real names: keep it outside the repo (the script refuses to write inside it).
"""
import argparse, csv, datetime as dt, os, re, sys

import openpyxl

MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7,
          "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def tab_date(name, today, year=None):
    m = re.fullmatch(r"\s*([A-Za-z]+)\.?\s*(\d{1,2})\s*", name)
    if not m or m[1][:3].lower() not in MONTHS:
        return None
    month = MONTHS[m[1][:3].lower()]
    y = year or (today.year if month <= today.month else today.year - 1)
    try:
        return dt.date(y, month, int(m[2]))
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("out_csv")
    ap.add_argument("--weeks", type=int, default=8)
    ap.add_argument("--through", help="last Sunday to include (default: today)")
    ap.add_argument("--tabs", nargs="+", help="explicit tab names, in order (overrides --weeks)")
    ap.add_argument("--include-new-names", action="store_true")
    args = ap.parse_args()

    out = os.path.abspath(args.out_csv)
    if out.startswith(REPO + os.sep):
        sys.exit("Refusing to write roster data inside the repo. Choose a path outside it.")
    today = dt.date.fromisoformat(args.through) if args.through else dt.date.today()
    wb = openpyxl.load_workbook(args.xlsx, data_only=True, read_only=True)
    if args.tabs:
        tabs = args.tabs
    else:
        dated = sorted((d, n) for n in wb.sheetnames if (d := tab_date(n, today)) and d <= today)
        tabs = [n for _, n in dated[-args.weeks:]]
    if not tabs:
        sys.exit("No weekly tabs found.")

    roster, skipped = {}, 0
    for t in tabs:
        ws = wb[t]
        for row in ws.iter_rows(min_row=1, max_col=9, values_only=True):
            row = list(row) + [None] * (9 - len(row))
            b, c, h, i = row[1], row[2], row[7], row[8]
            if isinstance(c, str) and c.strip():
                if "," in c:
                    roster.setdefault(c.strip(), {})[t] = b
                elif args.include_new_names and isinstance(b, bool):
                    roster.setdefault(c.strip(), {})[t] = b
                elif isinstance(b, bool):
                    skipped += 1
            if args.include_new_names and isinstance(i, str) and i.strip() and "NEW NAMES" not in i.upper():
                key = i.strip()
                prev = roster.setdefault(key, {}).get(t)
                roster[key][t] = True if (prev is True or h is True) else (h if isinstance(h, bool) else prev)
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name"] + tabs)
        for n in sorted(roster):
            w.writerow([n] + [roster[n].get(t, "") for t in tabs])
    os.chmod(out, 0o600)
    print(f"{len(tabs)} tabs ({tabs[0]} .. {tabs[-1]}), {len(roster)} names -> {out}", file=sys.stderr)
    if skipped and not args.include_new_names:
        print(f"note: {skipped} checkbox rows had a name without a comma and were skipped "
              "(use --include-new-names to include them and the NEW NAMES area).", file=sys.stderr)


if __name__ == "__main__":
    main()
