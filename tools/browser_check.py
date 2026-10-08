#!/usr/bin/env python3
"""Headless-Chromium check of the dashboard, with fault injection. Prints AGGREGATE counts only.

    ATTENDANCE_PASSCODE=... python3 tools/browser_check.py                    # local copy of this checkout
    ATTENDANCE_PASSCODE=... python3 tools/browser_check.py --url https://drbuhler.github.io/weekly-attendance/
Options:
    --scenario normal|google-down|http500|timeout|nocors|html|history
        how requests to Google behave (history: inject a History tab from --history-csv)
    --now 2026-10-11T12:00:00-07:00   fake the clock (noon-Pacific tab rule)
    --width 390                       phone width
    --index FILE / --data FILE        serve a different index.html / data.enc.json (local mode)
    --shots DIR --prefix P            save P+locked.png and P+unlocked-top.png (unlocked shows real names)
Needs: pip install playwright, and Chrome/Chromium (CHROME=/path).
"""
import argparse, functools, http.server, json, os, re, shutil, sys, tempfile, threading, time
from datetime import datetime

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITE = ["index.html", "app.js", "app.css", "robots.txt", "data.enc.json", "assets"]
GOOGLE = re.compile(r"^https://([a-z0-9-]+\.)*(docs\.google\.com|googleusercontent\.com)/")


def serve(directory):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=directory))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_port}/"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--scenario", default="normal",
                    choices=["normal", "google-down", "http500", "timeout", "nocors", "html", "history"])
    ap.add_argument("--history-csv")
    ap.add_argument("--hide", default="", help="history scenario: comma-separated tab names to drop from the tab list, as if hidden")
    ap.add_argument("--archive-csv", help="inject an Archive tab with this CSV (normal/history scenarios)")
    ap.add_argument("--blur", action="store_true", help="blur every name in screenshots")
    ap.add_argument("--full", action="store_true", help="full-page unlocked screenshot (Name check open)")
    ap.add_argument("--now")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--index")
    ap.add_argument("--data")
    ap.add_argument("--shots")
    ap.add_argument("--prefix", default="")
    args = ap.parse_args()
    passcode = os.environ.get("ATTENDANCE_PASSCODE")
    if not passcode:
        sys.exit("Set ATTENDANCE_PASSCODE")

    tmp = httpd = None
    if not args.url:
        tmp = tempfile.mkdtemp(prefix="attcheck-")
        for f in SITE:
            src = os.path.join(ROOT, f)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(tmp, f))
            elif os.path.exists(src):
                shutil.copy(src, tmp)
        if args.index:
            shutil.copy(args.index, os.path.join(tmp, "index.html"))
        if args.data:
            shutil.copy(args.data, os.path.join(tmp, "data.enc.json"))
        httpd, url = serve(tmp)
    else:
        url = args.url
    exe = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium")
    mobile = args.width < 600
    res = {"scenario": args.scenario, "width": args.width, "now": args.now or "real clock"}
    hist_gid, arc_gid = "990001", "990002"

    def google(route):
        req = route.request
        sc = args.scenario
        if sc == "google-down":
            return route.abort("internetdisconnected")
        if sc == "http500":
            return route.fulfill(status=500, body="error")
        if sc == "timeout":
            return  # never answer
        if sc == "html":
            return route.fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "text/html"},
                                 body="<!DOCTYPE html><html><body>Sorry</body></html>")
        if sc == "nocors":
            r = route.fetch()
            h = {k: v for k, v in r.headers.items() if not k.lower().startswith("access-control")}
            return route.fulfill(response=r, headers=h)
        if sc in ("history", "normal"):
            if req.url.endswith("/pubhtml"):
                r = route.fetch()
                body = r.text()
                if args.archive_csv:
                    body += f'<script>items.push({{name: "Archive", pageUrl: "x", gid: "{arc_gid}",initialSheet: false}});</script>'
                if sc != "history":
                    return route.fulfill(response=r, body=body)
                for name in filter(None, (x.strip() for x in args.hide.split(","))):
                    body = re.sub(r'items\.push\(\{name: "' + re.escape(name) + r'".*?\}\);', "", body)
                body += f'<script>items.push({{name: "History", pageUrl: "x", gid: "{hist_gid}",initialSheet: false}});</script>'
                return route.fulfill(response=r, body=body)
            if args.archive_csv and f"gid={arc_gid}&" in req.url:
                return route.fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "text/csv"},
                                     body=open(args.archive_csv, encoding="utf-8").read())
            if sc == "history" and f"gid={hist_gid}&" in req.url:
                return route.fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "text/csv"},
                                     body=open(args.history_csv, encoding="utf-8").read())
        return route.continue_()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=exe, headless=True)
            ctx = browser.new_context(viewport={"width": args.width, "height": 844 if mobile else 900},
                                      device_scale_factor=3 if mobile else 2, is_mobile=mobile, has_touch=mobile,
                                      bypass_csp=True)  # CSP blocks Playwright's eval-based waits
            page = ctx.new_page()
            if args.now:
                page.clock.install(time=datetime.fromisoformat(args.now))
            if args.scenario != "normal" or args.archive_csv:
                page.route(GOOGLE, google)
            errors = []
            page.on("pageerror", lambda e: errors.append("pageerror"))
            page.on("console", lambda m: errors.append("console:" + m.text[:60]) if m.type == "error" else None)
            r = page.goto(url, wait_until="domcontentloaded")
            page.wait_for_function("document.querySelector('#unlockBtn') && !document.querySelector('#unlockBtn').disabled || document.querySelector('#lockMsg').textContent", timeout=15000)
            res["http"] = r.status
            res["lock_visible"] = page.locator("#lock").is_visible()
            res["dashboard_hidden_and_empty"] = page.locator("#app").is_hidden() and page.locator("#app").inner_html().strip() == ""
            if args.shots:
                os.makedirs(args.shots, exist_ok=True)
                page.screenshot(path=os.path.join(args.shots, args.prefix + "locked.png"))
            for wrong in ("test-preview-only", "definitely-not-the-passcode"):
                page.fill("#pass", wrong)
                page.click("#unlockBtn")
                page.wait_for_function("document.querySelector('#lockMsg').textContent.includes(\"didn't work\")", timeout=30000)
            res["wrong_passcodes_rejected"] = page.locator("#app").is_hidden()
            page.fill("#pass", passcode)
            t0 = time.time()
            page.click("#unlockBtn")
            page.wait_for_function("window.__attendanceSummary", timeout=30000)
            res["first_paint_s"] = round(time.time() - t0, 1)
            first = page.evaluate("window.__attendanceSummary.source || 'snapshot'")
            res["first_paint_source"] = first
            # wait for the live attempt to settle (live, fallback, or plain snapshot without live config)
            settled = "(() => { const n = document.querySelector('#liveNote'); return !n || n.className.split(' ')[1] !== 'checking'; })()"
            if args.now and args.scenario == "timeout":
                page.clock.run_for(25000)  # let the pending live timeout fire under the fake clock
            page.wait_for_function(settled, timeout=60000)
            res["settled_s"] = round(time.time() - t0, 1)
            note = page.locator("#liveNote")
            res["status_class"] = (note.get_attribute("class") or "").split(" ")[-1] if note.count() else "(old page: no status line)"
            res["status_text"] = re.sub(r"\d{1,2}:\d{2}\s?[AP]M", "<time>", note.text_content()) if note.count() else ""
            s = page.evaluate("window.__attendanceSummary")
            w = s["weekly"]
            res["counts"] = {"source": s.get("source", "snapshot"), "people": s["people"], "red": s["red"], "yellow": s["yellow"],
                             "ok": s["ok"], "weeks": f"{w[0]['date']}..{w[-1]['date']} ({len(w)})",
                             "latest_attended": f"{w[-1]['present']}/{w[-1]['onSheet']}",
                             "visitors": [x.get("visitors") for x in w], "history_weeks": s.get("historyWeeksUsed", 0),
                             "marked_baptized": s.get("markedBaptized"), "left_list": s.get("leftList"), "name_check": s.get("nameCheck"),
                             "came_back": s.get("cameBack"), "archive": s.get("archive"),
                             "weekly_attended": [f"{x['present']}/{x['onSheet']}" for x in w]}
            res["celebration_shown"] = page.locator(".celebrate").count() > 0
            res["name_check_section"] = page.locator(".namecheck").count() > 0
            res["error_page_shown"] = page.locator("#app").is_hidden()
            if args.shots:
                if args.blur:
                    page.add_style_tag(content=".linkname,.nm,.cel-list b,.namecheck td:not(:last-child),.plist td:first-child,h3#mName{filter:blur(6px)}")
                path = os.path.join(args.shots, args.prefix + "unlocked-top.png")
                page.evaluate("window.scrollTo(0,0)")
                if args.full:
                    page.evaluate("document.querySelectorAll('details.namecheck').forEach(d => d.open = true); document.querySelector('[data-filter=baptized]')?.click()")
                page.screenshot(path=path, full_page=args.full)
                os.chmod(path, 0o600)
            res["storage"] = page.evaluate("({ss: sessionStorage.length, ls: localStorage.length})")
            res["console_errors"] = errors
            browser.close()
    finally:
        if httpd:
            httpd.shutdown()
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    print(json.dumps(res))


if __name__ == "__main__":
    main()
