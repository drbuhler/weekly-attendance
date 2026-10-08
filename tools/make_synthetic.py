#!/usr/bin/env python3
"""Generate a SYNTHETIC attendance CSV (fake names, fake check-ins) for previews and tests.

    python3 tools/make_synthetic.py /tmp/synthetic-attendance.csv

The shape mimics a real roster: ~280 people x 8 Sundays, most present on every
weekly sheet, some only appearing in later weeks, a few dropping off the sheet,
one duplicate spelling, and a mix of steady, irregular and lapsed attenders so
the red/yellow panels have something to show. It also writes fake per-week visitor
counts to <out>.visitors.csv. Nobody here is a real person.
"""
import csv
import random
import sys

FIRST = """Abigail Adrian Alma Ambrose Anastasia Anselm Aria Barnabas Basil Beatrice Bianca Callista
Cecilia Celeste Clement Constance Corin Cyrus Dalia Damaris Delphine Dorian Edith Elias
Elodie Emeric Esme Evander Felix Fiona Florian Gemma Gideon Greta Hadrian Hazel Helena Hugo
Ines Isidore Ivo Jasper Kallista Leander Lena Linus Lorelei Lucian Lydia Mabel Magnus
Marcella Matthias Nadia Nestor Noemi Oriel Orson Paloma Perpetua Quentin Rafaela Remy
Rosalind Rufus Sabina Silas Solveig Soren Tabitha Tamsin Thaddeus Theodora Tobias Ursula
Valentin Vera Wendell Winifred Xenia Yara Zeno Zinnia Ansel Briony Cosima Dashiell Eamon
Fenna Galen Honora Imogen Joaquin Kestrel Liesel Marius Nerys Odile""".split()

LAST = """Abernathy Ashdown Bellweather Birchfield Blackthorn Brightwater Calloway Caraway
Copperfield Crestwood Dovecote Drummond Eastbrook Elderberry Fairbanks Fenwick Foxworth
Galloway Glenrock Goldfinch Greywell Hallorann Harrowgate Hawthorne Hollis Ironwood Juniperhill
Kettleby Kingsley Lachlan Larkspur Lindqvist Lockridge Marchbank Merriweather Millbrook
Moorcroft Nethercott Northam Oakhurst Ollerton Penhallow Pemberly Quillfeather Ravensworth
Redgrave Rookwood Rowanberry Saltmarsh Sandoval Silverthorn Southwick Stonebridge Sutherby
Talbot Thistlewood Thornbury Underhill Vantongeren Vexley Wainwright Waverly Westerholm
Whitlock Wilderspin Winterbourne Woolbright Wychwood Yarborough Yellowhammer Zeffirelli
Ashcombe Bramblewood Cinderford Dunmore Everleigh Fallowfield Gladwell Heatherby Inglewood
Jessamine Kittering Lowenthal Mapleton Norwood Oakenshaw Pickering Quarrington Rosethorn
Sedgewick Tillinghast Umberfield Valcourt Wexford Yardley Ashgrove Brackenridge Coldwater
Davenhall Emberton Fernsby Gorsefield Hartwell Ivesdale Kirkwood Langridge Merrow Nightingale""".split()

N_WEEKS = 8


def make_people(rng, n=280):
    names, seen = [], set()
    while len(names) < n:
        last, first = rng.choice(LAST), rng.choice(FIRST)
        if rng.random() < 0.03:  # a few double-barrelled surnames
            last = f"{last}-{rng.choice(LAST)}"
        if (last, first) in seen:
            continue
        seen.add((last, first))
        names.append(f"{last}, {first}")
    return names


def attendance(rng, start, stop):
    """Return list of 'True'/'False'/'' for one person, on the sheet for weeks [start, stop)."""
    kind = rng.choices(["steady", "regular", "irregular", "lapsed", "brief"],
                       weights=[34, 30, 18, 14, 4])[0]
    p = {"steady": 0.9, "regular": 0.65, "irregular": 0.35, "lapsed": 0.7, "brief": 0.5}[kind]
    cells = []
    lapse_from = stop - rng.choice([3, 4, 5, 6, 7, 8]) if kind == "lapsed" else stop
    for w in range(N_WEEKS):
        if w < start or w >= stop:
            cells.append("")
        elif w >= lapse_from:
            cells.append("False")
        else:
            cells.append("True" if rng.random() < p else "False")
    return cells


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/synthetic-attendance.csv"
    rng = random.Random(20261007)
    names = make_people(rng)
    rows = []
    for i, name in enumerate(names):
        r = rng.random()
        if i < 14:
            start, stop = 6, 8          # joined in the last two weeks
        elif i < 22:
            start, stop = rng.choice([1, 2, 3, 4]), 8   # joined part-way through
        elif i < 28:
            start, stop = 0, 6          # dropped off the sheet
        elif i < 31:
            start, stop = 4, 6          # appeared briefly mid-period
        else:
            start, stop = 0, 8
        rows.append([name] + attendance(rng, start, stop))
    # one person whose name was retyped with different capitalisation part-way through
    last, first = names[40].split(", ")
    rows[40][-2:] = ["", ""]
    rows.append([f"{last.upper()}, {first}"] + [""] * (N_WEEKS - 2) + ["True", "True"])
    rng.shuffle(rows)
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name", "Aug 16", "Aug 23", "Aug 30", "Sep 6", "Sep 13", "Sept 20", "Sept 27", "Oct 4"])
        w.writerows(sorted(rows))
    vout = (out[:-4] if out.lower().endswith(".csv") else out) + ".visitors.csv"
    weeks = ["Aug 16", "Aug 23", "Aug 30", "Sep 6", "Sep 13", "Sept 20", "Sept 27", "Oct 4"]
    with open(vout, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["week", "visitors"])
        for j, wk in enumerate(weeks):
            w.writerow([wk, max(0, 6 + 2 * j + rng.randint(-3, 3))])
    print(f"Wrote {len(rows)} synthetic rows to {out} and visitor counts to {vout}", file=sys.stderr)


if __name__ == "__main__":
    main()
