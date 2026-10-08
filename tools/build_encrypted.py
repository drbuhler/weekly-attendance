#!/usr/bin/env python3
"""Turn a weekly attendance CSV into an encrypted data file for the dashboard.

Input CSV (exported from the weekly sign-in tabs; never commit it):

    header row:  name | Aug 16 | Aug 23 | ... | Oct 4
    data rows:   <Last, First> | True | False | ... | (blank)

  * first column is the person's name, each further column is one Sunday
    (header like "Aug 16", "Sept 20", or an ISO date "2026-08-16"),
  * cell values: True/TRUE/x/yes/1 = attended, False/FALSE/no/0 = absent,
    blank = the name was not on that week's sheet.

Blank cells before a person's first appearance mean "not yet enrolled"; blank
cells after it mean "not on that week's sheet". Neither counts as an absence.
Rows whose names differ only by case, spacing, punctuation or word order
("Doe, Jane" / "jane doe") are merged.

Visitors (people checked in from the "NEW NAMES, NOT YET ON LIST" area or off-list rows)
come from a separate counts-only file, week,visitors, written by export_weekly_tabs.py
(default: <csv name>.visitors.csv next to the CSV). Only the per-week numbers go into the
encrypted payload; visitors are never part of the people list, statuses or percentages.

The passcode is read from the ATTENDANCE_PASSCODE environment variable or, if
that is unset, from an interactive prompt. It is never accepted as an argument.

Only the encrypted file is written. Encryption: PBKDF2-HMAC-SHA256 (>= 600,000
iterations, random 16-byte salt) -> AES-256-GCM (random 12-byte IV). Output is
JSON {v, salt, iv, iter, ct} with base64 fields; ct includes the GCM tag, which
is the layout WebCrypto expects.
"""
import argparse
import base64
import csv
import datetime as dt
import getpass
import json
import os
import re
import sys
import tempfile
import unicodedata

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from names import clean_name, name_key  # noqa: E402

MIN_ITER = 600_000
DEFAULT_ITER = 650_000
PRESENT = {"true", "x", "yes", "y", "1", "present", "✓", "✔"}
ABSENT = {"false", "no", "n", "0", "absent"}
MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7,
          "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}


def parse_week_headers(headers, start_year):
    """Return [{'label','date'}] in column order; handles 'Sept 20', 'July5', ISO dates, year rollover."""
    out, year, prev_month = [], start_year, None
    for h in headers:
        label = h.strip()
        iso = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", label)
        if iso:
            d = dt.date(int(iso[1]), int(iso[2]), int(iso[3]))
            year, prev_month = d.year, d.month
        else:
            m = re.fullmatch(r"([A-Za-z]+)\.?\s*(\d{1,2})", label)
            if not m or m[1][:3].lower() not in MONTHS:
                sys.exit(f"Unrecognised week column header (expected like 'Oct 4'): column {len(out) + 2}")
            month = MONTHS[m[1][:3].lower()]
            if prev_month is not None and month < prev_month:
                year += 1  # Dec -> Jan rollover
            prev_month = month
            d = dt.date(year, month, int(m[2]))
        out.append({"label": d.strftime("%b %-d"), "date": d.isoformat()})
    dates = [w["date"] for w in out]
    if dates != sorted(dates):
        sys.exit("Week columns must be in chronological order.")
    return out


def cell_state(v):
    v = (v or "").strip().casefold()
    if v == "":
        return None
    if v in PRESENT:
        return "P"
    if v in ABSENT:
        return "A"
    sys.exit("Unrecognised attendance value in CSV (expected True/False/blank). Fix the export and retry.")


def load(csv_path, start_year):
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    if len(rows) < 2:
        sys.exit("CSV has no data rows.")
    weeks = parse_week_headers(rows[0][1:], start_year)
    n = len(weeks)
    merged = {}  # key -> {"n": display, "s": [None|P|A]*n}
    for i, row in enumerate(rows[1:], start=2):
        if not row or not row[0].strip():
            continue
        row = row + [""] * (n + 1 - len(row))
        states = [cell_state(v) for v in row[1:n + 1]]
        key = name_key(row[0])
        if not key:
            continue
        rec = merged.setdefault(key, {"n": clean_name(row[0]), "s": [None] * n})
        if "," not in rec["n"] and "," in row[0]:
            rec["n"] = clean_name(row[0])  # prefer the "Last, First" spelling
        for j, st in enumerate(states):
            if st == "P" or (st == "A" and rec["s"][j] is None):
                rec["s"][j] = st
    people = []
    for rec in merged.values():
        s = rec["s"]
        if all(x is None for x in s):
            continue
        first = next(j for j, x in enumerate(s) if x is not None)
        # N = not yet enrolled (before first appearance); G = not on that week's sheet
        code = "".join("N" if j < first else (x or "G") for j, x in enumerate(s))
        people.append({"n": rec["n"], "w": code})
    people.sort(key=lambda p: p["n"].casefold())
    return weeks, people, len(rows) - 1


def load_visitors(path, weeks, start_year):
    """Attach per-week visitor counts (numbers only) to weeks; weeks missing from the file get None."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    if not rows or [h.strip().lower() for h in rows[0][:2]] != ["week", "visitors"]:
        sys.exit("Visitor file must have the header: week,visitors")
    labels = [r[0] for r in rows[1:] if r and r[0].strip()]
    dates = [w["date"] for w in parse_week_headers(labels, start_year)] if labels else []
    counts = {}
    for d, r in zip(dates, [r for r in rows[1:] if r and r[0].strip()]):
        try:
            n = int(r[1])
        except (IndexError, ValueError):
            sys.exit("Visitor counts must be whole numbers.")
        if n < 0:
            sys.exit("Visitor counts must be >= 0.")
        counts[d] = n
    for w in weeks:
        w["visitors"] = counts.get(w["date"])
    return sum(1 for w in weeks if w["visitors"] is not None)


def summarize(weeks, people):
    """Aggregate counts only (no names) for a sanity check on the console."""
    red = yellow = 0
    for p in people:
        streak = 0
        for c in reversed(p["w"]):
            if c == "A":
                streak += 1
            elif c == "G":
                continue
            else:
                break
        red += streak >= 5
        yellow += 3 <= streak <= 4
    lines = [f"people: {len(people)}  red: {red}  yellow: {yellow}  ok: {len(people) - red - yellow}",
             "later-week-only (not on first week's sheet): "
             f"{sum(p['w'][0] == 'N' for p in people)}"]
    for j, w in enumerate(weeks):
        pr = sum(p["w"][j] == "P" for p in people)
        ab = sum(p["w"][j] == "A" for p in people)
        pct = f"{100 * pr / (pr + ab):.1f}%" if pr + ab else "n/a"
        vis = w.get("visitors")
        lines.append(f"  {w['date']}: {pr}/{pr + ab} attended ({pct})"
                     + ("" if vis is None else f", visitors {vis}"))
    return "\n".join(lines)


def get_passcode():
    pw = os.environ.get("ATTENDANCE_PASSCODE")
    if pw is None:
        if not sys.stdin.isatty():
            sys.exit("Set ATTENDANCE_PASSCODE or run interactively to be prompted.")
        pw = getpass.getpass("Passcode: ")
        if getpass.getpass("Repeat passcode: ") != pw:
            sys.exit("Passcodes did not match.")
    pw = unicodedata.normalize("NFC", pw)
    if not pw:
        sys.exit("Empty passcode.")
    if len(pw) < 16 and len(pw.split()) < 4:
        print("WARNING: weak passcode. The encrypted file is public and can be attacked offline; "
              "use 4+ random words or 16+ random characters for real data.", file=sys.stderr)
    return pw


def encrypt(payload: bytes, passcode: str, iterations: int) -> dict:
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                     iterations=iterations).derive(passcode.encode("utf-8"))
    ct = AESGCM(key).encrypt(iv, payload, None)
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    return {"v": 1, "salt": b64(salt), "iv": b64(iv), "iter": iterations, "ct": b64(ct)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", help="path to the exported weekly attendance CSV (keep it outside the repo)")
    ap.add_argument("-o", "--out", default=os.path.join(os.path.dirname(__file__), "..", "data.enc.json"),
                    help="encrypted output file (default: data.enc.json in the repo root)")
    ap.add_argument("--year", type=int, default=None,
                    help="calendar year of the first week column (default: inferred from today)")
    ap.add_argument("--title", default="Attendance", help="heading shown after unlocking (stored encrypted)")
    ap.add_argument("--banner", default="", help="optional notice shown after unlocking, e.g. for test previews")
    ap.add_argument("--visitors", help="counts-only visitor file (default: <csv>.visitors.csv if it exists)")
    ap.add_argument("--no-visitors", action="store_true", help="don't include visitor counts")
    ap.add_argument("--iterations", type=int, default=DEFAULT_ITER)
    ap.add_argument("--quiet", action="store_true", help="don't print aggregate counts")
    args = ap.parse_args()
    if args.iterations < MIN_ITER:
        sys.exit(f"--iterations must be >= {MIN_ITER}")

    today = dt.date.today()
    year = args.year
    if year is None:
        # assume the first column is within the last ~11 months
        with open(args.csv, newline="", encoding="utf-8-sig") as f:
            first = next(csv.reader(f))[1].strip()
        m = re.match(r"(\d{4})-|([A-Za-z]+)", first)
        year = today.year
        if m and m[2] and m[2][:3].lower() in MONTHS and MONTHS[m[2][:3].lower()] > today.month:
            year -= 1

    weeks, people, raw_rows = load(args.csv, year)
    vpath = args.visitors
    if vpath is None and not args.no_visitors:
        guess = (args.csv[:-4] if args.csv.lower().endswith(".csv") else args.csv) + ".visitors.csv"
        vpath = guess if os.path.exists(guess) else None
    if vpath and not args.no_visitors:
        n = load_visitors(vpath, weeks, year)
        print(f"Visitor counts: {n} of {len(weeks)} weeks from {vpath}", file=sys.stderr)
    else:
        for w in weeks:
            w["visitors"] = None
        print("Visitor counts: none included", file=sys.stderr)
    passcode = get_passcode()
    payload = {"v": 1, "title": args.title, "banner": args.banner,
               "generated": dt.datetime.now().astimezone().isoformat(timespec="minutes"),
               "weeks": weeks, "people": people}
    blob = encrypt(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                   passcode, args.iterations)
    del passcode, payload

    out = os.path.abspath(args.out)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out), prefix=".enc-", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(blob, f)
        f.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, out)
    print(f"Wrote {out} ({len(weeks)} weeks, {raw_rows} CSV rows -> {len(people)} people).", file=sys.stderr)
    if not args.quiet:
        print(summarize(weeks, people), file=sys.stderr)


if __name__ == "__main__":
    main()
