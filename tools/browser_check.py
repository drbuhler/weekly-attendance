#!/usr/bin/env python3
"""Headless-Chromium check of the live dashboard. Prints AGGREGATE counts only (never names).

    ATTENDANCE_PASSCODE=... python3 tools/browser_check.py --url https://drbuhler.github.io/weekly-attendance/
    ATTENDANCE_PASSCODE=... python3 tools/browser_check.py --config config.enc.json      # local copy of the site
    ... --now 2026-10-11T11:59:00-07:00   # fake the clock (tests the noon-Pacific tab rule)
    ... --width 390                       # phone width
    ... --shots DIR                       # save locked.png and unlocked-top.png (unlocked shows real names)

With --config, the site files are served from a temp dir on 127.0.0.1 (the sheet itself is still
fetched live from Google). Needs: pip install playwright, and Chrome/Chromium (CHROME=/path).
"""
import argparse, functools, http.server, json, os, shutil, sys, tempfile, threading
from datetime import datetime

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITE_FILES = ["index.html", "app.js", "roll.js", "app.css", "robots.txt"]


def serve(directory):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=directory))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_port}/"


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--config", help="config.enc.json to test with a local copy of the site")
    g.add_argument("--url", help="deployed page URL")
    ap.add_argument("--now", help="fixed clock (ISO date-time with offset)")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--shots", help="directory for locked.png / unlocked-top.png")
    ap.add_argument("--prefix", default="", help="screenshot filename prefix")
    args = ap.parse_args()
    passcode = os.environ.get("ATTENDANCE_PASSCODE")
    if not passcode:
        sys.exit("Set ATTENDANCE_PASSCODE")

    tmp = httpd = None
    if args.config:
        tmp = tempfile.mkdtemp(prefix="attcheck-")
        for f in SITE_FILES:
            shutil.copy(os.path.join(ROOT, f), tmp)
        shutil.copy(args.config, os.path.join(tmp, "config.enc.json"))
        httpd, url = serve(tmp)
    else:
        url = args.url
    exe = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium")
    mobile = args.width < 600
    res = {"width": args.width, "now": args.now or "real clock"}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=exe, headless=True)
            ctx = browser.new_context(viewport={"width": args.width, "height": 844 if mobile else 900},
                                      device_scale_factor=3 if mobile else 2, is_mobile=mobile, has_touch=mobile,
                                      bypass_csp=True)  # CSP blocks Playwright's eval-based waits
            page = ctx.new_page()
            if args.now:
                page.clock.set_fixed_time(datetime.fromisoformat(args.now))
            errors = []
            page.on("pageerror", lambda e: errors.append("pageerror"))
            page.on("console", lambda m: errors.append("console:" + m.type) if m.type == "error" else None)
            r = page.goto(url, wait_until="networkidle")
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
            res["wrong_passcodes_rejected"] = page.locator("#app").is_hidden() and page.evaluate("!window.__attendanceSummary")
            page.fill("#pass", passcode)
            page.click("#unlockBtn")
            page.wait_for_function("window.__attendanceSummary || document.querySelector('#lockMsg').textContent.includes('roll sheet right now')", timeout=60000)
            s = page.evaluate("window.__attendanceSummary || null")
            if s is None:
                res["load_error_shown"] = page.locator("#lockMsg").text_content()
            else:
                res["live_line"] = page.locator("#liveNote").text_content().split("·")[0].strip()
                res["refresh_button"] = page.locator("#refreshBtn").is_visible()
                res["banner"] = page.locator(".banner").count() > 0
                if args.shots:
                    path = os.path.join(args.shots, args.prefix + "unlocked-top.png")
                    page.screenshot(path=path)
                    os.chmod(path, 0o600)
                # Refresh keeps working
                page.evaluate("window.__attendanceSummary = null")
                page.click("#refreshBtn")
                page.wait_for_function("window.__attendanceSummary", timeout=60000)
                s2 = page.evaluate("window.__attendanceSummary")
                res["refresh_same_counts"] = (s2["people"], s2["red"], s2["yellow"]) == (s["people"], s["red"], s["yellow"])
                w = s["weekly"]
                res["counts"] = {"people": s["people"], "red": s["red"], "yellow": s["yellow"], "ok": s["ok"],
                                 "weeks": f"{w[0]['date']}..{w[-1]['date']} ({len(w)})",
                                 "latest_attended": f"{w[-1]['present']}/{w[-1]['onSheet']}",
                                 "visitors": [x["visitors"] for x in w], "unknown_marks": s.get("unknownMarks", 0)}
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
