#!/usr/bin/env python3
"""Write config.enc.json: the encrypted pointer to the published roll sheet.

The page decrypts this with the passcode and then reads the sheet live. Run it whenever the
sheet's publish URL or the passcode changes:

    ATTENDANCE_SHEET_URL=... ATTENDANCE_PASSCODE=... python3 tools/encrypt_config.py
    (or leave either variable unset to be prompted; input is hidden)

* The URL is any "Publish to the web" link of the sheet, e.g. .../d/e/2PACX-.../pubhtml.
  It is reduced to its base (.../d/e/2PACX-.../) and is never printed or written in plain text.
* Encryption: PBKDF2-HMAC-SHA256 (>= 600,000 iterations, random 16-byte salt) -> AES-256-GCM
  (random 12-byte IV); output {v, salt, iv, iter, ct} in base64, same as build_encrypted.py.
"""
import argparse, getpass, json, os, re, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_encrypted import DEFAULT_ITER, MIN_ITER, encrypt, get_passcode  # noqa: E402

PUB_RE = re.compile(r"^https://docs\.google\.com/spreadsheets/d/e/(2PACX-[A-Za-z0-9_-]{20,})(?:/[^?#]*)?(?:[?#].*)?$")


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--out", default=os.path.join(root, "config.enc.json"))
    ap.add_argument("--title", default="Catechumen attendance", help="heading shown after unlocking")
    ap.add_argument("--weeks", type=int, default=8, help="how many recent Sundays to show")
    ap.add_argument("--iterations", type=int, default=DEFAULT_ITER)
    args = ap.parse_args()
    if args.iterations < MIN_ITER:
        sys.exit(f"--iterations must be >= {MIN_ITER}")

    url = os.environ.get("ATTENDANCE_SHEET_URL")
    if url is None:
        if not sys.stdin.isatty():
            sys.exit("Set ATTENDANCE_SHEET_URL or run interactively to be prompted.")
        url = getpass.getpass("Published sheet URL (hidden): ")
    m = PUB_RE.match(url.strip())
    if not m:
        sys.exit("That doesn't look like a 'Publish to the web' Google Sheets link (…/spreadsheets/d/e/2PACX-…/pubhtml).")
    base = f"https://docs.google.com/spreadsheets/d/e/{m[1]}/"
    passcode = get_passcode()
    cfg = {"v": 1, "pub": base, "weeks": args.weeks, "title": args.title}
    blob = encrypt(json.dumps(cfg, separators=(",", ":")).encode(), passcode, args.iterations)
    del passcode, cfg, base, url

    out = os.path.abspath(args.out)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out), prefix=".enc-", suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(blob, f)
        f.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, out)
    print(f"Wrote {out} (sheet link and settings encrypted; {args.weeks} weeks).", file=sys.stderr)


if __name__ == "__main__":
    main()
