#!/usr/bin/env python3
"""Headless-browser round-trip check: decrypt an encrypted data file in Chromium and print
AGGREGATE counts only (never names). Optionally save screenshots.

    ATTENDANCE_PASSCODE=... python3 tools/browser_check.py --enc /tmp/x.enc.json
    ATTENDANCE_PASSCODE=... python3 tools/browser_check.py --url https://example.github.io/repo/ --shots DIR

Needs: pip install playwright (and a Chromium/Chrome; set CHROME=/path if not bundled).
With --enc, the page is served from a temporary copy on 127.0.0.1, so nothing touches the repo.
"""
import argparse, functools, http.server, json, os, shutil, sys, tempfile, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITE_FILES = ["index.html", "app.js", "app.css", "robots.txt"]


def serve(directory):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    handler = functools.partial(Quiet, directory=directory)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_port}/"


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--enc", help="encrypted data file to test (served from a temp copy)")
    g.add_argument("--url", help="already-deployed page URL")
    ap.add_argument("--shots", help="directory for screenshots (locked, desktop, phone, details)")
    ap.add_argument("--summary-out", help="write the aggregate JSON here as well")
    args = ap.parse_args()
    passcode = os.environ.get("ATTENDANCE_PASSCODE")
    if not passcode:
        sys.exit("Set ATTENDANCE_PASSCODE")

    tmp = httpd = None
    if args.enc:
        tmp = tempfile.mkdtemp(prefix="attcheck-")
        for f in SITE_FILES:
            shutil.copy(os.path.join(ROOT, f), tmp)
        shutil.copy(args.enc, os.path.join(tmp, "data.enc.json"))
        httpd, url = serve(tmp)
    else:
        url = args.url

    exe = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium")
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=exe, headless=True)
            ctx = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=2, bypass_csp=True)  # CSP blocks Playwright's eval-based waits
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.goto(url, wait_until="networkidle")
            assert page.locator("#app").is_hidden(), "dashboard visible before unlock"
            assert page.locator("#app").inner_html().strip() == "", "dashboard DOM not empty before unlock"
            if args.shots:
                os.makedirs(args.shots, exist_ok=True)
                page.screenshot(path=os.path.join(args.shots, "locked-desktop.png"))
            # wrong passcode -> friendly error, still locked
            page.fill("#pass", "definitely-not-the-passcode")
            page.click("#unlockBtn")
            page.wait_for_function("document.querySelector('#lockMsg').textContent.includes(\"didn't work\")", timeout=30000)
            assert page.locator("#app").is_hidden()
            wrong_msg = page.locator("#lockMsg").text_content()
            # right passcode
            page.fill("#pass", passcode)
            page.click("#unlockBtn")
            page.wait_for_function("window.__attendanceSummary", timeout=30000)
            summary = page.evaluate("window.__attendanceSummary")
            ss_keys = page.evaluate("Object.keys(sessionStorage).length + Object.keys(localStorage).length")
            if args.shots:
                page.screenshot(path=os.path.join(args.shots, "unlocked-desktop.png"), full_page=False)
                page.screenshot(path=os.path.join(args.shots, "unlocked-desktop-full.png"), full_page=True)
                page.locator("#grid .linkname").nth(3).click()
                page.wait_for_selector("#modal:not([hidden])")
                page.screenshot(path=os.path.join(args.shots, "details-desktop.png"))
                page.keyboard.press("Escape")
                # phone
                m = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3,
                                        is_mobile=True, has_touch=True, bypass_csp=True)
                mp = m.new_page()
                mp.goto(url, wait_until="networkidle")
                mp.screenshot(path=os.path.join(args.shots, "locked-phone.png"))
                mp.fill("#pass", passcode)
                mp.check("#remember")
                mp.click("#unlockBtn")
                mp.wait_for_function("window.__attendanceSummary", timeout=30000)
                mp.screenshot(path=os.path.join(args.shots, "unlocked-phone.png"))
                mp.screenshot(path=os.path.join(args.shots, "unlocked-phone-full.png"), full_page=True)
                mp.locator("#grid").scroll_into_view_if_needed()
                mp.evaluate("document.querySelector('.roster').scrollIntoView()")
                mp.screenshot(path=os.path.join(args.shots, "heatmap-phone.png"))
                mp.locator("#grid .linkname").nth(1).click()
                mp.wait_for_selector("#modal:not([hidden])")
                mp.screenshot(path=os.path.join(args.shots, "details-phone.png"))
                # remember-me: reload in same tab auto-unlocks via sessionStorage, no localStorage used
                mp.reload(wait_until="networkidle")
                mp.wait_for_function("window.__attendanceSummary", timeout=30000)
                stores = mp.evaluate("({ss: Object.keys(sessionStorage).length, ls: Object.keys(localStorage).length})")
                print("remember-me reload auto-unlocked; storage:", stores, file=sys.stderr)
                m.close()
            browser.close()
    finally:
        if httpd:
            httpd.shutdown()
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    out = {"wrong_passcode_message": wrong_msg, "storage_keys_without_remember": ss_keys,
           "page_errors": errors, "summary": summary}
    print(json.dumps(out, indent=1))
    if args.summary_out:
        json.dump(out, open(args.summary_out, "w"))


if __name__ == "__main__":
    main()
