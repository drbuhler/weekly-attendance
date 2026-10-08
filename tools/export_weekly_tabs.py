#!/usr/bin/env python3
"""Export the weekly sign-in tabs of the attendance workbook (.xlsx download of the Google Sheet)
into the two files tools/build_encrypted.py reads. Generalises the original parse_export.py.

    python3 tools/export_weekly_tabs.py attendance.xlsx /workspace/catechumen-dashboard/weekly_tabs_attendance.csv

Writes
  1. the attendance CSV (main list only): column B = checkbox, column C = "Last, First";
  2. <same name>.visitors.csv: per-week VISITOR COUNTS ONLY (week,visitors), no names.

Visitors are people checked in (checkbox ticked) in the "NEW NAMES, NOT YET ON LIST" area
(column H checkbox, column I name) or on checkbox rows in column C written without a comma,
who are NOT already on the main list (that week or an earlier exported week). They are
de-duplicated against the main list and within the week using the same name normalisation the
build uses for merging. Visitor names are never written anywhere; they only exist in memory.

A person who is already on the main list (that week or any earlier exported week) and checked
in through the newcomer area / an off-list row is counted PRESENT that week, whether their
main-list box that week is unticked or they have no main-list row that week. They are not a
visitor and not "not on that week's sheet".

Weekly tabs are sheets named like "Oct 4" / "Sept 20" / "July5". By default the latest 8 that
have "happened" are used: a tab counts from 12:00 PM Pacific on its own date (check-ins finish
around 11:30 AM), so future tabs and today's tab before noon are ignored entirely. Override with
--now (an ISO date-time), --through YYYY-MM-DD (inclusive), --weeks N, or --tabs ...
This is the same rule the live page (roll.js) applies.
The attendance CSV holds real names: keep it outside the repo (the script refuses otherwise).
"""
import argparse, csv, datetime as dt, os, re, sys

import openpyxl
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from names import name_key  # noqa: E402

MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7,
          "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
PACIFIC = ZoneInfo("America/Los_Angeles")
CUTOFF_HOUR = 12
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


def visitors_path(csv_path):
    base = csv_path[:-4] if csv_path.lower().endswith(".csv") else csv_path
    return base + ".visitors.csv"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("out_csv")
    ap.add_argument("--visitors-out", help="visitor-count file (default: <out_csv>.visitors.csv)")
    ap.add_argument("--weeks", type=int, default=8)
    ap.add_argument("--through", help="last tab date to include, inclusive (overrides the noon rule)")
    ap.add_argument("--now", help="pretend the current time is this ISO date-time (for testing)")
    ap.add_argument("--tabs", nargs="+", help="explicit tab names, in order (overrides --weeks)")
    args = ap.parse_args()

    out = os.path.abspath(args.out_csv)
    vout = os.path.abspath(args.visitors_out or visitors_path(args.out_csv))
    for p in (out, vout):
        if p.startswith(REPO + os.sep):
            sys.exit("Refusing to write roster files inside the repo. Choose a path outside it.")
    now = dt.datetime.fromisoformat(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=PACIFIC)
    now_pt = now.astimezone(PACIFIC)
    if args.through:
        today = through = dt.date.fromisoformat(args.through)
    else:
        today = now_pt.date()
        through = today if now_pt.hour >= CUTOFF_HOUR else today - dt.timedelta(days=1)
    wb = openpyxl.load_workbook(args.xlsx, data_only=True, read_only=True)
    if args.tabs:
        tabs = args.tabs
    else:
        dated = sorted((d, n) for n in wb.sheetnames if (d := tab_date(n, today)) and d <= through)
        tabs = [n for _, n in dated[-args.weeks:]]
    if not tabs:
        sys.exit("No weekly tabs found.")

    roster = {}            # main list: name -> {tab: checkbox}
    key_names = {}         # normalised key -> main-list spellings
    on_main = set()        # normalised keys seen on the main list so far (this week and earlier)
    visitors, credited = [], []   # per-tab counts
    for t in tabs:
        ws = wb[t]
        week_main, week_visit = set(), set()
        for row in ws.iter_rows(min_row=1, max_col=9, values_only=True):
            row = list(row) + [None] * (9 - len(row))
            b, c, h, i = row[1], row[2], row[7], row[8]
            if isinstance(c, str) and c.strip():
                if "," in c:
                    roster.setdefault(c.strip(), {})[t] = b
                    week_main.add(name_key(c))
                    key_names.setdefault(name_key(c), set()).add(c.strip())
                elif b is True:
                    week_visit.add(name_key(c))          # off-list checkbox row, checked in
            if isinstance(i, str) and i.strip() and "NEW NAMES" not in i.upper() and h is True:
                week_visit.add(name_key(i))              # NEW NAMES area, checked in
        on_main |= week_main
        week_visit.discard("")
        # already on the main list (this week or an earlier one) but checked in via the newcomer
        # area -> present this week, whether their row this week is unticked or missing
        n_credit = 0
        for k in week_visit & on_main:
            names = key_names[k]
            if not any(roster[n].get(t) is True for n in names):
                n_credit += 1
                for n in names:
                    roster[n][t] = True
        credited.append(n_credit)
        visitors.append(len(week_visit - on_main))
        del week_visit

    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name"] + tabs)
        for n in sorted(roster):
            w.writerow([n] + [roster[n].get(t, "") for t in tabs])
    os.chmod(out, 0o600)
    with open(vout, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["week", "visitors"])
        w.writerows(zip(tabs, visitors))
    os.chmod(vout, 0o600)
    print(f"{len(tabs)} tabs ({tabs[0]} .. {tabs[-1]}), {len(roster)} main-list names -> {out}", file=sys.stderr)
    print(f"visitor counts -> {vout}: " + ", ".join(f"{t}: {v}" for t, v in zip(tabs, visitors)), file=sys.stderr)
    print("main-list people credited present via newcomer-area check-in: "
          + ", ".join(f"{t}: {v}" for t, v in zip(tabs, credited)) + f" (total {sum(credited)})", file=sys.stderr)


if __name__ == "__main__":
    main()
