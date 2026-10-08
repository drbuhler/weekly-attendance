#!/usr/bin/env python3
"""Attendance record OLDER than the live window, baked into the encrypted snapshot so the
dashboard can say "Last seen Mar 2026" instead of "never" for people absent all 8 weeks.

Sources (all in the same workbook; the published .xlsx export includes hidden tabs):
  * master grids   'Attendance 0525-0226' (names in col B), '0301' (col F), 'May 17' (col B):
                   row 2 = dates from col H on, a TRUE/FALSE check box per person and date
  * summer tabs    'May 17 Self-Check', 'May 31 self-check', 'June 13', 'June 20', 'July5',
                   'July 12', 'July 19 ': any check box immediately left of a name
  * weekly tabs    every "Mon D" tab from Aug 9 2026 on (current layout): col B box + col C name,
                   or a ticked NEW NAMES entry (H/I)
Week rules (same as /workspace/catechumen-dashboard/crossref.py / roster_reconcile.py): a
(source, date) column with < 10% ticked or < 10 ticks is skipped (Dec 28 2025, Mar 1 2026, the
blank May 17 master column); Mar 22 - May 31 2026 (post-Pascha self-check) counts presence only.
Only PRESENCE is used: last-seen date and number of Sundays attended.

Matching: the dashboard name key; if a current person has no older record under that key, a
unique older spelling variant (Giovani/Giovanni, swapped order, compound surname, ...) that is
not itself on the newest tab's list is used (roster_reconcile.variant).
"""
import datetime as dt, re, sys, os
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from names import name_key  # noqa: E402

MASTERS = [("Attendance 0525-0226", 1), ("0301", 5), ("May 17", 1)]
SUMMER = [("May 17 Self-Check", "2026-05-17"), ("May 31 self-check", "2026-05-31"), ("June 13", "2026-06-13"),
          ("June 20", "2026-06-20"), ("July5", "2026-07-05"), ("July 12", "2026-07-12"), ("July 19 ", "2026-07-19")]
FIRST_WEEKLY = dt.date(2026, 8, 9)
SPARSE = (dt.date(2026, 3, 22), dt.date(2026, 5, 31))
PRESENT = {"true", "x", "yes", "y", "1", "present", "✓", "✔"}
SUFFIX = {"jr", "sr", "ii", "iii", "iv"}
MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}


# ---- name helpers (from roster_reconcile.py) ----
def norm(s):
    s = str(s)
    paren = re.findall(r"\((.*?)\)", s)
    s = re.sub(r"\(.*?\)", " ", s).lower().replace(".", " ")
    s = re.sub(r"[^a-z, '\-]", " ", s)
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b", " ", s)
    if "," in s:
        last, first = s.split(",", 1)
    else:
        p = s.split()
        if len(p) < 2:
            return None
        last, first = p[-1], " ".join(p[:-1])
    tk = lambda x: [t for t in re.split(r"[\s\-']+", x) if t and t not in SUFFIX]
    pt = [t for p in paren for t in tk(p.lower())]
    L, F = tk(last), tk(first)
    if not L or not F:
        return None
    return (tuple(L), tuple(F), tuple(pt))


def lev(a, b):
    p = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        c = [i]
        for j, cb in enumerate(b, 1):
            c.append(min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (ca != cb)))
        p = c
    return p[-1]


def phon(x):
    x = re.sub(r"(ai|ay|ey)", "a", x); x = re.sub(r"e$", "", x); x = re.sub(r"(.)\1", r"\1", x)
    return x.replace("y", "i")


def ed1(a, b):
    return lev(a, b) <= 1 or phon(a) == phon(b)


def variant(a, b):
    """why two names are probably the same person, else None"""
    A, B = norm(a), norm(b)
    if not A or not B:
        return None
    if name_key(a) == name_key(b):
        return "exact"
    La, Fa, Pa = A; Lb, Fb, Pb = B
    if sorted(La + Fa) == sorted(Lb + Fb):
        return "same tokens once Jr./punctuation ignored"
    if (La, Fa) == (Fb, Lb):
        return "first/last swapped"
    alla, allb = set(La) | set(Pa), set(Lb) | set(Pb)
    if Fa[0] == Fb[0] and (alla & allb) and (alla <= allb or allb <= alla):
        return "compound/parenthetical surname"
    if La == Lb and ed1(" ".join(Fa), " ".join(Fb)) and min(len(Fa[0]), len(Fb[0])) >= 3:
        return "first name one-letter/phonetic variant"
    if La == Lb and min(len(Fa[0]), len(Fb[0])) >= 3 and (Fa[0].startswith(Fb[0]) or Fb[0].startswith(Fa[0])):
        return "same surname, first-name short form"
    if Fa == Fb and ed1(" ".join(La), " ".join(Lb)) and min(len("".join(La)), len("".join(Lb))) >= 4:
        return "surname one-letter/phonetic variant"
    return None


def hdr_date(h):
    if isinstance(h, dt.datetime):
        d = h.date()
        return dt.date(2025, 8, 17) if (d.year, d.month, d.day) == (2024, 8, 17) else d  # header typo
    if isinstance(h, str):
        m = re.match(r"\s*(\d{1,2})/(\d{1,2})/?(\d{4})?", h)
        if m:
            return dt.date(int(m.group(3) or 2026), int(m.group(1)), int(m.group(2)))
    return None


def weekly_tab_date(name, today):
    m = re.fullmatch(r"\s*([A-Za-z]+)\.?\s*(\d{1,2})\s*", name)
    if not m or m[1][:3].lower() not in MONTHS:
        return None
    mo = MONTHS[m[1][:3].lower()]
    try:
        return dt.date(today.year if mo <= today.month else today.year - 1, mo, int(m[2]))
    except ValueError:
        return None


def collect(wb, through):
    """-> (older: key -> set(dates) from masters + summer tabs, weekly: key -> set(dates) from the
    current-layout tabs, raw: key -> an older spelling, rules: (src,date) -> rule)"""
    marks = defaultdict(lambda: defaultdict(dict))  # key -> date -> {src: bool}
    raw, colstats = {}, defaultdict(lambda: [0, 0])
    rows = lambda t: list(wb[t].iter_rows(values_only=True))
    for t, nc in MASTERS:
        if t not in wb.sheetnames:
            continue
        R = rows(t)
        hdr = R[1] if len(R) > 1 else []
        for j in range(7, len(hdr)):
            d = hdr_date(hdr[j])
            if not d:
                continue
            for r in R[2:]:
                if j < len(r) and nc < len(r) and isinstance(r[j], bool) and isinstance(r[nc], str) and norm(r[nc]):
                    k = name_key(r[nc]); marks[k][d][t] = r[j]; raw.setdefault(k, r[nc].strip())
                    colstats[(t, d)][0 if r[j] else 1] += 1
    for t, ds in SUMMER:
        if t not in wb.sheetnames:
            continue
        d = dt.date.fromisoformat(ds)
        for r in rows(t):
            for j, v in enumerate(r):
                if j and isinstance(v, str) and len(v) < 45 and norm(v) and isinstance(r[j - 1], bool):
                    k = name_key(v); marks[k][d][t] = r[j - 1]; raw.setdefault(k, v.strip())
                    colstats[(t, d)][0 if r[j - 1] else 1] += 1
    rules = {}
    for (s, d), (T, F) in colstats.items():
        rules[(s, d)] = "skip" if (T + F == 0 or T / (T + F) < .10 or T < 10) else \
            ("presence_only" if SPARSE[0] <= d <= SPARSE[1] else "valid")
    present, weekly = defaultdict(set), defaultdict(set)
    for k, by_d in marks.items():
        for d, by in by_d.items():
            if any(v for s, v in by.items() if rules[(s, d)] != "skip"):
                present[k].add(d)
    # current-layout weekly tabs (Aug 9 2026 on), up to and including `through`
    for t in wb.sheetnames:
        d = weekly_tab_date(t, through)
        if not d or d < FIRST_WEEKLY or d > through:
            continue
        for r in rows(t):
            r = list(r) + [None] * 10
            c, i = r[2], r[8]
            if isinstance(c, str) and c.strip() and norm(c) and str(r[1]).strip().lower() in PRESENT:
                weekly[name_key(c)].add(d)
            if isinstance(i, str) and norm(i) and "NEW NAMES" not in i.upper() and r[7] is True:
                weekly[name_key(i)].add(d)
    return present, weekly, raw, rules


def build(wb, people_names, through, roster_names=None):
    """people_names: every current spelling; roster_names: the newest tab's list (spellings that
    can't be borrowed as someone else's older spelling; default: all of people_names).
    Returns ({"d": [iso...], "p": {key: [date idx...]}}, stats)"""
    older, weekly, raw, rules = collect(wb, through)
    cur = {name_key(n): n for n in people_names}
    taken = {name_key(n) for n in (roster_names if roster_names is not None else people_names)}
    aliases = 0
    per = {}
    for k, n in cur.items():
        src = k
        if k not in raw:  # no older row under this spelling: look for one older spelling variant
            c = [ok for ok, rn in raw.items() if ok not in taken and variant(n, rn) not in (None, "exact")]
            if len(c) == 1:
                src = c[0]; aliases += 1
        s = older.get(src, set()) | weekly.get(k, set())
        if s:
            per[k] = s
    dates = sorted({d for s in per.values() for d in s})
    idx = {d: i for i, d in enumerate(dates)}
    out = {"d": [d.isoformat() for d in dates], "p": {k: sorted(idx[d] for d in s) for k, s in per.items()}}
    return out, {"people_with_record": len(per), "people_without": len(cur) - len(per), "spelling_variant_matches": aliases,
                 "dates": len(dates), "rules": rules}
