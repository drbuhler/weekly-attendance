#!/usr/bin/env python3
"""Pre-commit guard: refuse to commit anything that looks like plaintext roster data.

Runs on the files staged for commit (or, with --all, on every tracked file). Fails if:
  * a data-like file is staged (csv/tsv/xlsx/json/... other than data.enc.json),
  * data.enc.json is not exactly {v, salt, iv, iter, ct} with base64 values and iter >= 600000,
  * any staged text contains spreadsheet-style check-in rows (True,False,... runs) or
    lines that look like '"Last, First",True,...' CSV records.
Install with:  sh tools/install-hooks.sh
"""
import base64, json, re, subprocess, sys

ALLOWED_DATA = {"data.enc.json"}
BLOCKED_EXT = re.compile(r"\.(csv|tsv|xlsx?|xlsm|ods|numbers|json|jsonl|ndjson|sqlite|db|parquet|pkl|pickle)$", re.I)
CHECKIN_RUN = re.compile(r"(?i)\b(true|false)\b\s*,\s*\b(true|false)\b\s*,\s*\b(true|false)\b")
CSV_PERSON = re.compile(r'^\s*"[^",\n]{2,40},\s*[^",\n]{2,40}"\s*,\s*(true|false|x)?\s*,', re.I | re.M)


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True).stdout


def check_enc(raw: bytes):
    try:
        j = json.loads(raw)
    except Exception:
        return "data.enc.json is not valid JSON"
    if set(j) != {"v", "salt", "iv", "iter", "ct"}:
        return "data.enc.json must contain only v, salt, iv, iter, ct"
    if not isinstance(j["iter"], int) or j["iter"] < 600_000:
        return "data.enc.json iteration count below 600000"
    try:
        if len(base64.b64decode(j["salt"], validate=True)) != 16 or len(base64.b64decode(j["iv"], validate=True)) != 12:
            return "data.enc.json salt/iv have wrong length"
        base64.b64decode(j["ct"], validate=True)
    except Exception:
        return "data.enc.json fields are not base64"
    return None


def main():
    all_files = "--all" in sys.argv
    if all_files:
        files = [f for f in git("ls-files", "-z").decode().split("\0") if f]
        read = lambda f: open(f, "rb").read()
    else:
        files = [f for f in git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").decode().split("\0") if f]
        read = lambda f: git("show", f":{f}")
    problems = []
    for f in files:
        base = f.rsplit("/", 1)[-1]
        data = read(f)
        if base in ALLOWED_DATA and "/" not in f:
            err = check_enc(data)
            if err:
                problems.append(f"{f}: {err}")
            continue
        if BLOCKED_EXT.search(f):
            problems.append(f"{f}: data files are never committed (only data.enc.json)")
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if f.startswith("tools/check_staged.py"):
            continue
        if CHECKIN_RUN.search(text) or CSV_PERSON.search(text):
            problems.append(f"{f}: contains what looks like roster/check-in rows")
    if problems:
        print("Commit blocked: possible plaintext attendance data.\n  " + "\n  ".join(problems), file=sys.stderr)
        print("Only data.enc.json (made by tools/build_encrypted.py) may hold data.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
