#!/usr/bin/env python3
"""Check that the in-browser parser (roll.js, run under Node) and the Python export+merge
(tools/export_weekly_tabs.py + tools/build_encrypted.py) agree EXACTLY on a workbook.

    python3 tools/parity_check.py path/to/attendance.xlsx [--now 2026-10-11T11:59:00-07:00]

The workbook's tabs are converted to Google-style CSV in a temp dir, roll.js builds the roster
from them, and both sides are compared by SHA-256 digest. Prints aggregate counts only.
--simulate-hidden N removes the N oldest counted weekly tabs from the JS side's tab list and
gives it a History tab with their cells instead (what the weekly Apps Script will do), to prove
History + visible tabs == all tabs.
Needs: node, openpyxl, cryptography.
"""
import argparse, csv, datetime as dt, hashlib, json, os, subprocess, sys, tempfile, shutil

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import build_encrypted  # noqa: E402

NODE_SNIPPET = r"""
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const R = require(process.argv[1]); const dir = process.argv[2]; const now = new Date(process.argv[3]);
const tabs = JSON.parse(fs.readFileSync(path.join(dir, 'tabs.json'), 'utf8'));
const html = tabs.map(t => `items.push({name: ${JSON.stringify(t.name)}, pageUrl: "x", gid: "${t.gid}",initialSheet: false});`).join('');
const found = R.discoverTabs(html);
const vis = R.selectWeeklyTabs(found, now, 8);
vis.forEach(t => { t.rows = R.parseCSV(fs.readFileSync(path.join(dir, t.gid + '.csv'), 'utf8')); });
const ht = found.find(R.isHistoryTab);
const hist = ht ? R.historyWeeks(R.parseCSV(fs.readFileSync(path.join(dir, ht.gid + '.csv'), 'utf8'))) : [];
const sel = R.combineWeeks(vis, hist, now, 8);
const weekly = sel;
const out = R.build(weekly);
const digest = crypto.createHash('sha256').update(JSON.stringify(out.people.map(p => [p.n, p.w]))).digest('hex');
const marked = out.people.filter(p => p.b).map(p => R.nameKey(p.n)).sort();
console.log(JSON.stringify({ tabs: sel.map(t => t.name), fromHistory: sel.filter(t => t.fromHistory).length, weeks: out.weeks, n: out.people.length, digest, unknownMarks: out.unknownMarks, marked,
  codes: out.people.map(p => p.w) }));
"""


def cell(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def status_counts(codes):
    red = yellow = 0
    for w in codes:
        s = 0
        for c in reversed(w):
            if c == "A": s += 1
            elif c == "G": continue
            else: break
        red += s >= 5; yellow += 3 <= s <= 4
    return red, yellow, len(codes) - red - yellow


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--simulate-hidden", type=int, default=0)
    ap.add_argument("--now", default=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                    help="instant to evaluate the noon-Pacific tab rule at (ISO with offset)")
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="parity-")
    os.chmod(tmp, 0o700)
    try:
        wb = openpyxl.load_workbook(a.xlsx, data_only=True, read_only=True)
        tabs = []
        for gid, name in enumerate(wb.sheetnames):
            tabs.append({"name": name, "gid": str(gid)})
            with open(os.path.join(tmp, f"{gid}.csv"), "w", newline="") as f:
                w = csv.writer(f, lineterminator="\r\n")
                for row in wb[name].iter_rows(values_only=True):
                    w.writerow([cell(v) for v in row])
        # Python side (all tabs, hidden or not)
        out_csv = os.path.join(tmp, "py.csv")
        subprocess.run([sys.executable, os.path.join(HERE, "export_weekly_tabs.py"), a.xlsx, out_csv, "--now", a.now],
                       check=True, capture_output=True)
        if a.simulate_hidden:
            with open(out_csv, newline="") as f:
                sel_names = next(csv.reader(f))[1:]
            hidden = sel_names[:a.simulate_hidden]
            now_month, year0 = int(a.now[5:7]), int(a.now[:4])
            hrows = [["Date", "Section", "Name", "Checked"]]
            for name in hidden:
                mo = build_encrypted.MONTHS[name.strip()[:3].lower()]
                d = build_encrypted.parse_week_headers([name], year0 if mo <= now_month else year0 - 1)[0]["date"]
                for row in wb[name].iter_rows(max_col=9, values_only=True):
                    row = list(row) + [None] * (9 - len(row))
                    if isinstance(row[2], str) and row[2].strip():
                        hrows.append([d, "main", row[2], cell(row[1])])
                    if isinstance(row[8], str) and row[8].strip():
                        hrows.append([d, "new", row[8], cell(row[7])])
            # in real life every older tab is hidden as well
            import re as _re
            cutoff_names = set(hidden)
            first_kept = sel_names[a.simulate_hidden] if a.simulate_hidden < len(sel_names) else None
            order = [t["name"] for t in tabs]
            dated = [n for n in order if _re.fullmatch(r"\s*[A-Za-z]+\.?\s*\d{1,2}\s*", n)]
            if first_kept in dated:
                cutoff_names |= set(dated[:dated.index(first_kept)])
            tabs = [t for t in tabs if t["name"] not in cutoff_names] + [{"name": "History", "gid": "990001"}]
            with open(os.path.join(tmp, "990001.csv"), "w", newline="") as f:
                csv.writer(f, lineterminator="\r\n").writerows(hrows)
        json.dump(tabs, open(os.path.join(tmp, "tabs.json"), "w"))
        js = json.loads(subprocess.run(["node", "-e", NODE_SNIPPET, os.path.join(ROOT, "assets", "roll.3.js"), tmp, a.now],
                                       check=True, capture_output=True, text=True).stdout)
        with open(out_csv, newline="") as f:
            first_tab = next(csv.reader(f))[1]
        year = js["weeks"][0]["date"][:4]  # same start year the export inferred
        weeks, people, _ = build_encrypted.load(out_csv, int(year))
        build_encrypted.load_visitors(os.path.join(tmp, "py.visitors.csv"), weeks, int(year))
        pd = hashlib.sha256(json.dumps([[p["n"], p["w"]] for p in people], ensure_ascii=False,
                                       separators=(",", ":")).encode()).hexdigest()
        from names import name_key
        with open(os.path.join(tmp, "py.baptized.csv"), newline="", encoding="utf-8") as f:
            py_marked = sorted({name_key(r[0]) for r in list(csv.reader(f))[1:] if r})
        js_marked = sorted(set(js["marked"]))
        py_vis = [w["visitors"] for w in weeks]
        js_vis = [w["visitors"] for w in js["weeks"]]
        same_weeks = [(w["label"], w["date"]) for w in weeks] == [(w["label"], w["date"]) for w in js["weeks"]]
        r, y, o = status_counts(js["codes"])
        last = len(weeks) - 1
        pres = sum(c[last] == "P" for c in js["codes"]); onsheet = sum(c[last] in "PA" for c in js["codes"])
        print(json.dumps({"tabs_used": js["tabs"], "weeks_from_history": js["fromHistory"], "people_js": js["n"], "people_py": len(people),
                          "roster_digest_match": pd == js["digest"], "weeks_match": same_weeks,
                          "visitors_js": js_vis, "visitors_py": py_vis, "red_yellow_ok": [r, y, o],
                          "latest_attended": f"{pres}/{onsheet}", "unknown_marks_js": js["unknownMarks"],
                          "marked_baptized": [len(js_marked), len(py_marked)], "marked_match": js_marked == py_marked}))
        if pd != js["digest"] or py_vis != js_vis or not same_weeks or js_marked != py_marked:
            sys.exit(1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
