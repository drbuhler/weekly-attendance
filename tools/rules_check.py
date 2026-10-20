#!/usr/bin/env python3
"""Synthetic checks for the six-month window and the optional Baptized tab.

No sheet, no passcode, no real names. Prints aggregate results only.
The browser half serves a throwaway encrypted snapshot (the passcode exists only in this process).

    python3 tools/rules_check.py            # parser checks, then headless Chrome
    python3 tools/rules_check.py --no-browser
"""
import functools, http.server, json, os, re, secrets, shutil, subprocess, sys, tempfile, threading
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import build_encrypted as be  # noqa: E402

NODE = r"""
const fs = require("fs"), path = require("path");
const R = require(process.argv[1]);
const dir = process.argv[2];
const fail = [];
const check = (name, ok) => { if (!ok) fail.push(name); };

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const label = (d) => MON[d.getMonth()] + " " + d.getDate();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
function sundays(a, b) {
  const out = [];
  let d = new Date(a + "T12:00:00");
  const end = new Date(b + "T12:00:00");
  while (d <= end) { out.push(new Date(d)); d = new Date(d.getTime() + 7 * 864e5); }
  return out;
}
const noon = new Date("2026-10-20T15:00:00-07:00");
{ const cyc = R.selectWeeklyTabs([{name:"May 10",gid:"a"},{name:"May 17",gid:"b"},{name:"May 17 Self-Check",gid:"c"},{name:"May 31 self-check",gid:"d"},{name:"Oct 18",gid:"e"}], noon, 0, R.CYCLE_START, R.CYCLE_END).map((t) => t.name);
  check("cycle-window", JSON.stringify(cyc) === JSON.stringify(["May 17", "Oct 18"])); }
check("since-oct", R.monthsAgoIso(noon, 6) === "2026-04-20");
check("since-clamp", R.monthsAgoIso(new Date("2026-03-31T12:00:00-07:00"), 6) === "2025-09-30");
check("since-year", R.monthsAgoIso(new Date("2027-01-15T20:00:00Z"), 6) === "2026-07-15");

const since = R.monthsAgoIso(noon, 6);
const names = ["Apr 12", "Apr 19", "Apr 26", "May 3", "May 10", "Oct 18", "Oct 25", "Baptized", "History", "Archive", "Follow-ups"];
const tabs = names.map((name, i) => ({ name, gid: String(i) }));
const picked = R.selectWeeklyTabs(tabs, noon, 0, since).map((t) => t.name);
check("window-includes-may", picked.includes("May 3") && picked.includes("May 10") && picked.includes("Oct 18") && picked.includes("Apr 26"));
check("window-excludes", !picked.includes("Apr 19") && !picked.includes("Apr 12") && !picked.includes("Oct 25")
  && !picked.includes("Baptized") && !picked.includes("History"));
const many = sundays("2026-01-04", "2026-10-18").map((d, i) => ({ name: label(d), gid: String(i) }));
const last8 = R.selectWeeklyTabs(many, noon, 8);
check("count-8", last8.length === 8 && iso(last8[0].date) === "2026-08-30" && iso(last8[7].date) === "2026-10-18");
const beforeNoon = R.selectWeeklyTabs(many, new Date("2026-10-18T11:00:00-07:00"), 0, since);
check("before-noon", iso(beforeNoon[beforeNoon.length - 1].date) === "2026-10-11");

const hist = R.historyWeeks([
  ["Date", "Section", "Name", "Checked"],
  ["2026-04-12", "main", "Ash, Ada", "TRUE"],
  ["2026-05-03", "main", "Ash, Ada", "FALSE"],
  ["2026-05-10", "main", "Ash, Ada", "TRUE"],
]);
const vis = R.selectWeeklyTabs([{ name: "May 3", gid: "1" }, { name: "Oct 18", gid: "2" }], noon, 0, since);
vis.forEach((t) => { t.rows = []; });
const merged = R.combineWeeks(vis, hist, noon, 0, since).map((t) => iso(t.date));
check("combine-since", merged.includes("2026-05-10") && merged.includes("2026-10-18") && !merged.includes("2026-04-12"));
check("combine-visible-wins", merged.filter((d) => d === "2026-05-03").length === 1
  && R.combineWeeks(vis, hist, noon, 0, since).find((t) => iso(t.date) === "2026-05-03").fromHistory !== true);

const days = sundays("2026-05-03", "2026-10-18");
check("span-25", days.length === 25 && iso(days[0]) === "2026-05-03" && iso(days[24]) === "2026-10-18" && iso(days[14]) === "2026-08-09");
const weekly = days.map((d) => ({ name: label(d), date: d, rows: [] }));
function add(name, from, pattern, markLast) {
  for (let i = 0; i < pattern.length; i++) {
    const j = from + i;
    const r = ["", pattern[i] === "P" ? "TRUE" : "FALSE", name, "", "", "", "", "", ""];
    if (markLast && j === weekly.length - 1) r[3] = "x";
    weekly[j].rows.push(r);
  }
}
const P = (n) => "P".repeat(n), A = (n) => "A".repeat(n);
add("Ash, Ada", 0, P(25));
add("Birch, Ben", 0, P(19) + A(6));
add("Cedar, Cora", 0, P(20) + A(5));
add("Dale, Drew", 0, P(21) + A(4));
add("Elm, Evan", 0, P(22) + A(3));
add("Fern, Fay", 0, P(23) + A(2));
add("Grove, Gia", 14, P(11));
add("Ives, Iris", 0, A(25));
add("Keel, Kira", 0, P(19));
add("Moss, Leo", 0, A(25), true);
add("Pine, Joel", 0, P(21));
const built = R.build(weekly);
const baptized = [
  ["Name", "Baptized date"],
  ["ives, IRIS", "4/12/2026"],
  ["Kira Keel", "9/6/2026"],
  ["Keel, Kira", "4/1/2026"],
];
const now = noon;
function rule(extra) {
  return R.applyRules(Object.assign({ weeks: built.weeks, people: built.people, overrides: null }, extra), [], now);
}
function cls(people) {
  const c = { red: 0, yellow: 0, ok: 0, baptized: 0 };
  const streaks = [], leadN = [], dates = [];
  let crosses = 0, columnD = 0;
  for (const p of people) {
    let s = 0;
    for (let j = p.w.length - 1; j >= 0; j--) {
      const ch = p.w[j];
      if (ch === "A") s++; else if (ch === "G") continue; else break;
    }
    const status = p.b ? "baptized" : s >= 6 ? "red" : s >= 4 ? "yellow" : "ok";
    c[status]++;
    if (!p.b) streaks.push(s);
    if (p.bx) { crosses++; dates.push(p.bd || ""); if (!p.b) fail.push("cross-without-exclusion"); }
    if (p.b && !p.bx) columnD++;
    let n = 0; for (const ch of p.w) { if (ch === "N") n++; else break; }
    if (n) leadN.push(n);
  }
  streaks.sort((a, b) => a - b); dates.sort(); leadN.sort((a, b) => a - b);
  return { c, streaks, leadN, dates, crosses, columnD, n: people.length,
           offLatestCross: people.filter((p) => p.bx && (p.w.endsWith("G"))).length };
}
const ruled = rule({ baptizedRows: baptized });
const got = cls(ruled.people);
check("thresholds", JSON.stringify(got.streaks) === JSON.stringify([0, 0, 2, 3, 4, 5, 6]));
check("groups", got.c.red === 1 && got.c.yellow === 2 && got.c.ok === 4 && got.c.baptized === 3 && got.n === 10);
check("cross-dates", got.crosses === 2 && JSON.stringify(got.dates) === JSON.stringify(["2026-04-12", "2026-09-06"]));
check("column-d-still-separate", got.columnD === 1);
check("removed-listed-kept", got.offLatestCross === 1);
check("enroll-prefix", JSON.stringify(got.leadN) === JSON.stringify([14])
  && ruled.people.some((p) => /^N{14}P+$/.test(p.w)));
check("enroll-not-absent", !ruled.people.some((p) => p.w.includes("N") && !/^N+P+$/.test(p.w)));
const bare = rule({});
const bareC = cls(bare.people);
check("missing-tab", bareC.crosses === 0 && bareC.c.red === 2 && bareC.n === 9 && bareC.offLatestCross === 0
  && bare.baptizedTab.found === false && bare.baptizedTab.ok === false);
const empty = rule({ baptizedRows: [["Name", "Baptized date"]] });
check("empty-tab", empty.baptizedTab.ok === true && empty.baptizedTab.rows === 0 && cls(empty.people).crosses === 0 && cls(empty.people).c.red === 2);
const bad = rule({ baptizedRows: [["Who", "When"], ["Ives, Iris", "4/12/2026"]] });
check("bad-headers", bad.baptizedTab.ok === false && cls(bad.people).crosses === 0);
check("parse-empty", JSON.stringify(R.parseBaptized([])) === "[]" && R.parseBaptized(null) === null);
const timed = R.parseBaptized([["Name", "Baptized date"], ["Quill, Nan", "4/12/2026 0:00:00"], ["Rook, Owen", ""]]);
check("parse-time-and-blank", timed && timed.length === 2 && timed[0].date === "2026-04-12" && timed[1].date === "" && timed[0].key === R.nameKey("Nan Quill"));
const blank = R.applyRules({
  weeks: [{ label: "Oct 18", date: "2026-10-18", visitors: 0 }],
  people: [{ n: "Quill, Nan", w: "A" }],
  baptizedRows: [["Baptized date", "Name"], ["", "Quill, Nan"]],
}, [], now);
check("blank-date-excluded", blank.people.length === 1 && blank.people[0].b === 1 && blank.people[0].bx === 1 && blank.people[0].bd === "");
const renamed = R.applyRules({
  weeks: built.weeks,
  people: [{ n: "Newspell, Pat", w: "A".repeat(25) }],
  baptizedRows: [["Name", "Baptized date"], ["Pat Oldspell", "6/7/2026"]],
  overrides: { renames: { [R.nameKey("Oldspell, Pat")]: { to: R.nameKey("Newspell, Pat"), name: "Newspell, Pat" } } },
}, [], now);
check("rename-match", renamed.people.length === 1 && renamed.people[0].bx === 1 && renamed.people[0].bd === "2026-06-07" && renamed.people[0].b === 1);
check("tab-stats", ruled.baptizedTab.ok === true && ruled.baptizedTab.rows === 3 && ruled.baptizedTab.matched === 2 && ruled.baptizedTab.people === 2);

const payload = {
  v: 1, title: "Attendance", banner: "", generated: "2026-10-20T12:00:00-07:00",
  weeks: built.weeks, people: built.people, archive: [], baptized: baptized, older: null, overrides: null,
};
const csvDir = path.join(dir, "tabs");
fs.mkdirSync(csvDir);
const escCell = (v) => { const s = String(v == null ? "" : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
weekly.forEach((t, i) => {
  t.gid = String(i + 1);
  fs.writeFileSync(path.join(csvDir, t.gid + ".csv"), t.rows.map((r) => r.map(escCell).join(",")).join("\r\n") + "\r\n");
});
const baptizedGid = "9001";
fs.writeFileSync(path.join(csvDir, baptizedGid + ".csv"), baptized.map((r) => r.map(escCell).join(",")).join("\r\n") + "\r\n");
fs.writeFileSync(path.join(dir, "tabs.json"), JSON.stringify({
  tabs: weekly.map((t) => ({ name: t.name, gid: t.gid })), baptizedGid,
}));
fs.writeFileSync(path.join(dir, "payload.json"), JSON.stringify(payload));
const expect = {
  people: got.n, red: got.c.red, yellow: got.c.yellow, ok: got.c.ok, baptized: got.c.baptized,
  crosses: got.crosses, enrollFirstDates: ["2026-08-09"], nCells: 14, weeks: 25,
  firstLabel: "May 3", lastLabel: "Oct 18", tags: 1,
};
fs.writeFileSync(path.join(dir, "expect.json"), JSON.stringify(expect));
console.log(JSON.stringify({ ok: fail.length === 0, fail, weeks: built.weeks.length, people_in: built.people.length }));
"""


def browser(data_path, expect, width):
    env = os.environ.copy()
    # passcode stays in this process; browser_check reads it and never prints it
    cmd = [sys.executable, os.path.join(HERE, "browser_check.py"), "--data", data_path, "--width", str(width), "--blur"]
    shots = os.environ.get("ATTENDANCE_SHOTS")
    if shots:
        cmd += ["--shots", shots, "--prefix", f"w{width}-", "--full"]
    proc = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)
    if proc.returncode != 0 and not proc.stdout.strip():
        return {"ok": False, "width": width, "error": (proc.stderr or "browser_check failed")[-500:]}
    try:
        res = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "width": width, "error": (proc.stdout or proc.stderr or "no json")[-500:]}
    c = res.get("counts") or {}
    spark = res.get("spark_labels") or {}
    labels = res.get("week_labels") or {}
    cross = res.get("cross_ui") or {}
    hints = " ".join((res.get("order") or {}).get("hints") or [])
    problems = []
    def eq(name, got, want):
        if got != want:
            problems.append(f"{name}:{got}!={want}")
    eq("people", c.get("people"), expect["people"])
    eq("red", c.get("red"), expect["red"])
    eq("yellow", c.get("yellow"), expect["yellow"])
    eq("ok", c.get("ok"), expect["ok"])
    eq("baptized", c.get("marked_baptized"), expect["baptized"])
    eq("crosses", res.get("crosses"), expect["crosses"])
    eq("enroll", res.get("enroll_first_dates"), expect["enrollFirstDates"])
    eq("thresholds", res.get("thresholds"), {"red": 6, "yellow": 4})
    eq("source", c.get("source"), "snapshot")
    roster = labels.get("roster") or []
    eq("roster-n", len(roster), expect["weeks"])
    eq("roster-first", roster[0] if roster else None, expect["firstLabel"])
    eq("roster-last", roster[-1] if roster else None, expect["lastLabel"])
    eq("roster-hidden", labels.get("roster_hidden"), 0)
    eq("n-cells", labels.get("n_cells"), expect["nCells"])
    eq("spark-bars", spark.get("bars"), expect["weeks"])
    eq("spark-labels", spark.get("labels"), expect["weeks"])
    eq("spark-overlap", spark.get("overlaps"), 0)
    eq("spark-clipped", spark.get("clipped"), 0)
    texts = spark.get("texts") or []
    eq("spark-first", texts[0] if texts else None, expect["firstLabel"])
    eq("spark-last", texts[-1] if texts else None, expect["lastLabel"])
    eq("cross-n", cross.get("n"), expect["crosses"])
    eq("cross-titled", cross.get("titled"), expect["crosses"])
    eq("cross-dated", cross.get("dated"), expect["crosses"])
    eq("column-d-tag", cross.get("tags"), expect["tags"])
    modal = cross.get("modal") or {}
    if not (modal.get("shown") and modal.get("has_date") and modal.get("says_baptized")):
        problems.append("cross-modal")
    if "6+" not in hints or "4" not in hints or "0" not in hints:
        problems.append("hints:" + hints[:120])
    attended = c.get("weekly_attended") or []
    eq("latest-excludes-baptized", attended[-1] if attended else None, "2/7")
    if res.get("console_errors"):
        problems.append("console")
    if res.get("error_page_shown"):
        problems.append("error-page")
    return {"ok": not problems, "width": width, "problems": problems,
            "spark": {k: spark.get(k) for k in ("bars", "labels", "overlaps", "clipped")},
            "status": res.get("status_class")}


def serve(directory):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=directory))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_port}/"


def live_mock(data_path, tab_dir, meta, mode):
    """Drive the live sheet path against local fixtures. mode: with-tab | no-tab | tab-500."""
    from playwright.sync_api import sync_playwright
    site = tempfile.mkdtemp(prefix="attcheck-")
    httpd = None
    try:
        for name in ("index.html", "robots.txt", "assets"):
            src = os.path.join(ROOT, name)
            dst = os.path.join(site, name)
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                shutil.copy(src, dst)
        shutil.copy(data_path, os.path.join(site, "data.enc.json"))
        html = "".join(
            'items.push({name: ' + json.dumps(t["name"]) + ', pageUrl: "x", gid: "' + t["gid"] + '",initialSheet: false});'
            for t in meta["tabs"])
        if mode != "no-tab":
            html += 'items.push({name: "Baptized", pageUrl: "x", gid: "' + meta["baptizedGid"] + '",initialSheet: false});'
        httpd, url = serve(site)
        exe = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium")
        out = {"mode": mode}
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=exe, headless=True)
            page = browser.new_context(viewport={"width": 1280, "height": 900}, bypass_csp=True).new_page()
            page.clock.install(time=datetime.fromisoformat("2026-10-20T15:00:00-07:00"))
            def handle(route):
                req = route.request.url
                if req.endswith("/pubhtml"):
                    return route.fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "text/html"}, body=html)
                m = re.search(r"[?&]gid=(\d+)", req)
                if not m:
                    return route.fulfill(status=404, body="missing")
                gid = m.group(1)
                if gid == meta["baptizedGid"] and mode == "tab-500":
                    return route.fulfill(status=500, body="nope")
                path = os.path.join(tab_dir, gid + ".csv")
                if not os.path.exists(path):
                    return route.fulfill(status=404, body="missing gid")
                return route.fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "text/csv"},
                                     body=open(path, encoding="utf-8").read())
            page.route(re.compile(r"https://docs\.google\.com/"), handle)
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_function("document.querySelector('#unlockBtn') && !document.querySelector('#unlockBtn').disabled", timeout=15000)
            page.fill("#pass", os.environ["ATTENDANCE_PASSCODE"])
            page.click("#unlockBtn")
            page.wait_for_function("window.__attendanceSummary", timeout=30000)
            page.wait_for_function("() => { const n = document.querySelector('#liveNote'); return n && !n.className.includes('checking'); }", timeout=30000)
            s = page.evaluate("window.__attendanceSummary")
            out["source"] = s.get("source")
            out["status"] = page.locator("#liveNote").get_attribute("class").split()[-1]
            out["counts"] = {k: s.get(k) for k in ("people", "red", "yellow", "ok")}
            out["marked"] = s.get("markedBaptized")
            out["crosses"] = s.get("crosses")
            out["weeks"] = len(s.get("weekly") or [])
            last = (s.get("weekly") or [None])[-1] or {}
            out["latest"] = f"{last.get('present')}/{last.get('onSheet')}" if last else None
            out["enroll"] = s.get("enrollFirstDates")
            out["thresholds"] = s.get("thresholds")
            out["baptized"] = s.get("baptizedTab")
            browser.close()
        return out
    finally:
        if httpd:
            httpd.shutdown()
        shutil.rmtree(site, ignore_errors=True)


def main():
    no_browser = "--no-browser" in sys.argv
    tmp = tempfile.mkdtemp(prefix="rules-")
    os.chmod(tmp, 0o700)
    try:
        proc = subprocess.run(["node", "-e", NODE, os.path.join(ROOT, "assets", "roll.7.js"), tmp],
                              cwd=ROOT, capture_output=True, text=True)
        if proc.returncode != 0:
            sys.stderr.write(proc.stderr[-1000:])
            sys.exit(1)
        logic = json.loads(proc.stdout)
        print(json.dumps({"logic": logic}))
        if not logic["ok"]:
            sys.exit(1)
        if no_browser:
            return
        pw = secrets.token_urlsafe(18)
        os.environ["ATTENDANCE_PASSCODE"] = pw
        payload = json.load(open(os.path.join(tmp, "payload.json"), encoding="utf-8"))
        blob = be.encrypt(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), pw, be.MIN_ITER)
        data_path = os.path.join(tmp, "data.enc.json")
        json.dump(blob, open(data_path, "w"))
        expect = json.load(open(os.path.join(tmp, "expect.json"), encoding="utf-8"))
        del payload
        views = [browser(data_path, expect, 1280), browser(data_path, expect, 390)]
        print(json.dumps({"browser": views}))
        if any(not v["ok"] for v in views):
            sys.exit(1)
        live_payload = json.load(open(os.path.join(tmp, "payload.json"), encoding="utf-8"))
        token = "2PACX-" + ("a" * 24)
        live_payload["live"] = {"pub": "https://docs.google.com/spreadsheets/d/e/" + token + "/", "weeks": 8}
        live_path = os.path.join(tmp, "live.enc.json")
        json.dump(be.encrypt(json.dumps(live_payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                             pw, be.MIN_ITER), open(live_path, "w"))
        del live_payload
        meta = json.load(open(os.path.join(tmp, "tabs.json"), encoding="utf-8"))
        tab_dir = os.path.join(tmp, "tabs")
        live = [live_mock(live_path, tab_dir, meta, mode) for mode in ("with-tab", "no-tab", "tab-500")]
        problems = []
        for row in live:
            if row.get("source") != "live" or row.get("status") != "live" or row.get("weeks") != 25:
                problems.append(row["mode"] + ":not-live")
            if row.get("thresholds") != {"red": 6, "yellow": 4} or row.get("enroll") != ["2026-08-09"]:
                problems.append(row["mode"] + ":rules")
        by = {row["mode"]: row for row in live}
        if by["with-tab"]["counts"] != {"people": 10, "red": 1, "yellow": 2, "ok": 4} or by["with-tab"]["crosses"] != 2 or by["with-tab"]["marked"] != 3 or by["with-tab"].get("latest") != "2/7":
            problems.append("with-tab:counts")
        if not (by["with-tab"]["baptized"] or {}).get("ok") or (by["with-tab"]["baptized"] or {}).get("matched") != 2:
            problems.append("with-tab:baptized")
        for mode in ("no-tab", "tab-500"):
            if by[mode]["counts"] != {"people": 9, "red": 2, "yellow": 2, "ok": 4} or by[mode]["crosses"] != 0 or by[mode]["marked"] != 1 or by[mode].get("latest") != "2/8":
                problems.append(mode + ":counts")
        if (by["no-tab"]["baptized"] or {}).get("tab"):
            problems.append("no-tab:flag")
        if not (by["tab-500"]["baptized"] or {}).get("tab") or (by["tab-500"]["baptized"] or {}).get("found"):
            problems.append("tab-500:flag")
        # counts only — drop nothing that could carry a fixture name
        summary = [{"mode": r["mode"], "source": r.get("source"), "status": r.get("status"), "counts": r.get("counts"),
                    "crosses": r.get("crosses"), "marked": r.get("marked"), "weeks": r.get("weeks")} for r in live]
        print(json.dumps({"live": summary, "live_ok": not problems, "live_problems": problems}))
        if problems:
            sys.exit(1)
    finally:
        os.environ.pop("ATTENDANCE_PASSCODE", None)
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
