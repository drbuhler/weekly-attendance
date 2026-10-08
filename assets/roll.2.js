/* Roll-sheet parsing: a faithful port of tools/export_weekly_tabs.py + the merge step of
   tools/build_encrypted.py, run in the browser against the published Google Sheet.
   Pure functions, no DOM. Visitor names are only used transiently to count them. */
(function (root) {
  "use strict";
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const PRESENT = new Set(["true", "x", "yes", "y", "1", "present", "✓", "✔"]);
  const ABSENT = new Set(["false", "no", "n", "0", "absent"]);
  const TOKEN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // code-unit order, like Python str sort

  function casefold(s) { return s.toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ"); }
  /* 'Doe, Jane' == 'jane  DOE' (case/spacing/punctuation/word order) */
  function nameKey(name) { return (casefold(String(name).normalize("NFKC")).match(TOKEN) || []).sort(cmp).join(" "); }
  function cleanName(name) { return String(name).trim().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", "); }

  /* Tab list from the published sheet's pubhtml page: [{name, gid}] */
  function discoverTabs(html) {
    const out = [], seen = new Set();
    const re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\d+)"/g;
    let m;
    while ((m = re.exec(html))) {
      const name = m[1].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\(.)/g, "$1");
      if (!seen.has(m[2])) { seen.add(m[2]); out.push({ name, gid: m[2] }); }
    }
    return out;
  }

  /* Current date/time on the Pacific clock, whatever the viewer's own time zone. */
  const TZ = "America/Los_Angeles";
  function pacificNow(now) {
    const parts = {};
    for (const p of new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now)) parts[p.type] = +p.value;
    return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour % 24, min: parts.minute };
  }

  /* "Oct 4" / "Sept 20" / "July5" -> Date (noon, used only as a calendar date) or null. Year: this
     year unless the month is later than the current month (then last year), like tab_date() in
     the Python export. `pt` is pacificNow(). */
  function tabDate(name, pt) {
    const m = /^\s*([A-Za-z]+)\.?\s*(\d{1,2})\s*$/.exec(name);
    if (!m) return null;
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    const year = month <= pt.m ? pt.y : pt.y - 1;
    const day = +m[2], d = new Date(year, month - 1, day, 12);
    return d.getMonth() === month - 1 && d.getDate() === day ? d : null;
  }
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  /* A weekly tab counts only from 12:00 PM Pacific on its own date (check-ins finish ~11:30 AM).
     Future tabs, and today's tab before noon, are ignored entirely: no absences, streaks, KPIs or
     visitors. Returns the latest n eligible tabs, oldest first. Non-date tabs are ignored. */
  const CUTOFF_HOUR = 12;
  function selectWeeklyTabs(tabs, now, n) {
    const pt = pacificNow(now || new Date());
    const todayIso = `${pt.y}-${String(pt.m).padStart(2, "0")}-${String(pt.d).padStart(2, "0")}`;
    return tabs.map((t) => ({ ...t, date: tabDate(t.name, pt) }))
      .filter((t) => {
        if (!t.date) return false;
        const di = iso(t.date);
        return di < todayIso || (di === todayIso && pt.h >= CUTOFF_HOUR);
      })
      .sort((a, b) => a.date - b.date)
      .slice(-n);
  }

  /* ---------- History tab (keeps weeks whose tabs were hidden) ----------
     Layout (row 1 = header): Date | Section | Name | Checked
       Date    : the Sunday, as text yyyy-mm-dd (M/D/YYYY and "Oct 4, 2026" also accepted)
       Section : "main" = a column B/C pair of that week's tab; "new" = a column H/I pair
                 (NEW NAMES area). Every non-empty name cell of the tab is copied.
       Name    : the name cell exactly as on the tab
       Checked : the checkbox cell exactly as on the tab (TRUE / FALSE / x / blank)
     Each History date becomes a virtual weekly tab with the same cells, so the same rules apply. */
  function parseHistoryDate(v) {
    const s = String(v || "").trim();
    let m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return mkDate(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return mkDate(+m[3], +m[1], +m[2]);
    if ((m = /^([A-Za-z]+)\.?\s*(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
      const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
      return mo ? mkDate(+m[3], mo, +m[2]) : null;
    }
    return null;
  }
  function mkDate(y, mo, d) {
    const x = new Date(y, mo - 1, d, 12);
    return x.getFullYear() === y && x.getMonth() === mo - 1 && x.getDate() === d ? x : null;
  }
  /* History CSV rows -> [{name:"History yyyy-mm-dd", date, rows, fromHistory:true}] */
  function historyWeeks(rows) {
    if (!rows.length) return [];
    const head = rows[0].map((h) => String(h).trim().toLowerCase());
    let ci = { date: head.indexOf("date"), sec: head.indexOf("section"), name: head.indexOf("name"), chk: head.indexOf("checked") };
    let body = rows.slice(1);
    if (Object.values(ci).some((x) => x < 0)) { ci = { date: 0, sec: 1, name: 2, chk: 3 }; if (parseHistoryDate(rows[0][0])) body = rows; }
    const byDate = new Map();
    for (const r of body) {
      const d = parseHistoryDate(r[ci.date]);
      const name = r[ci.name], chk = r[ci.chk] == null ? "" : r[ci.chk];
      const sec = String(r[ci.sec] || "").trim().toLowerCase();
      if (!d || typeof name !== "string" || !name.trim()) continue;
      const k = iso(d);
      if (!byDate.has(k)) byDate.set(k, { name: "History " + k, date: d, rows: [], fromHistory: true });
      const row = ["", "", "", "", "", "", "", "", ""];
      if (sec === "main" || sec === "c") { row[1] = chk; row[2] = name; }
      else if (sec === "new" || sec === "i") { row[7] = chk; row[8] = name; }
      else continue;
      byDate.get(k).rows.push(row);
    }
    return [...byDate.values()];
  }
  const isHistoryTab = (t) => /^\s*history\s*$/i.test(t.name);

  /* Merge visible weekly tabs with History weeks: a visible tab wins over History for the same
     date; the noon-Pacific rule applies to both; latest n, oldest first. */
  function combineWeeks(visible, history, now, n) {
    const pt = pacificNow(now || new Date());
    const todayIso = `${pt.y}-${String(pt.m).padStart(2, "0")}-${String(pt.d).padStart(2, "0")}`;
    const ok = (d) => { const di = iso(d); return di < todayIso || (di === todayIso && pt.h >= CUTOFF_HOUR); };
    const byDate = new Map();
    for (const h of history) if (ok(h.date)) byDate.set(iso(h.date), h);
    for (const v of visible) if (v.date && ok(v.date)) byDate.set(iso(v.date), v);
    return [...byDate.values()].sort((a, b) => a.date - b.date).slice(-n);
  }

  /* RFC-4180 CSV -> array of rows */
  function parseCSV(text) {
    const rows = []; let row = [], f = "", q = false, i = 0;
    const N = text.length;
    while (i < N) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
        f += c; i++; continue;
      }
      if (c === '"') { q = true; i++; }
      else if (c === ",") { row.push(f); f = ""; i++; }
      else if (c === "\n" || c === "\r") { row.push(f); rows.push(row); row = []; f = ""; i += c === "\r" && text[i + 1] === "\n" ? 2 : 1; }
      else { f += c; i++; }
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  const isText = (v) => typeof v === "string" && v.trim() !== "" && !/^-?\d+(\.\d+)?$/.test(v.trim());
  const isTrue = (v) => typeof v === "string" && v.trim().toUpperCase() === "TRUE";
  /* main-list checkbox -> "P" | "A" | null (same value sets as build_encrypted.cell_state) */
  function cellState(v) {
    const s = casefold(String(v == null ? "" : v).trim());
    if (s === "") return null;
    if (PRESENT.has(s)) return "P";
    if (ABSENT.has(s)) return "A";
    return null; // unrecognised mark: treated as blank (the Python build refuses such files)
  }

  /* column D of the weekly tab = "Baptized" marker (checkbox, x, or the word) */
  const MARK = new Set([...PRESENT, "baptized", "baptised", "chrismated", "b"]);
  const isMark = (v) => MARK.has(casefold(String(v == null ? "" : v).trim()));

  /* weekly: [{name, date, rows}] oldest first. Returns {weeks:[{label,date,visitors}], people:[{n,w,b?}], unknownMarks}
     b:1 = marked Baptized (column D) on the newest tab. */
  function build(weekly) {
    const marked = new Set();   // keys marked in column D on the newest tab
    const roster = new Map();   // main-list spelling -> Map(tabIndex -> raw value or true)
    const keyNames = new Map(); // key -> Set(spellings)
    const onMain = new Set();
    const visitors = [];
    weekly.forEach((tab, t) => {
      const weekMain = new Set();
      let weekVisit = new Set();
      for (const r of tab.rows) {
        const b = r[1], c = r[2], h = r[7], i = r[8];
        if (isText(c)) {
          if (c.includes(",")) {
            const n = c.trim(), k = nameKey(c);
            if (!roster.has(n)) roster.set(n, new Map());
            roster.get(n).set(t, b);
            weekMain.add(k);
            if (t === weekly.length - 1 && isMark(r[3])) marked.add(k);
            if (!keyNames.has(k)) keyNames.set(k, new Set());
            keyNames.get(k).add(n);
          } else if (isTrue(b)) weekVisit.add(nameKey(c));            // off-list row, checked in
        }
        if (isText(i) && !i.toUpperCase().includes("NEW NAMES") && isTrue(h)) weekVisit.add(nameKey(i)); // NEW NAMES area
      }
      weekMain.forEach((k) => onMain.add(k));
      weekVisit.delete("");
      let v = 0;
      for (const k of weekVisit) {
        if (onMain.has(k)) {   // already on the main list: present this week
          const names = keyNames.get(k);
          if (![...names].some((n) => roster.get(n).get(t) === true)) names.forEach((n) => roster.get(n).set(t, true));
        } else v++;
      }
      visitors.push(v);
      weekVisit = null; // visitor names are not kept
    });

    // merge (build_encrypted.load): rows in sorted-name order, merged by key
    const W = weekly.length, merged = new Map();
    let unknownMarks = 0;
    for (const n of [...roster.keys()].sort(cmp)) {
      const k = nameKey(n);
      if (!k) continue;
      const vals = roster.get(n);
      const states = [];
      for (let j = 0; j < W; j++) {
        const raw = vals.has(j) ? vals.get(j) : "";
        const st = raw === true ? "P" : cellState(raw);
        if (st === null && raw !== true && String(raw == null ? "" : raw).trim() !== "") unknownMarks++;
        states.push(st);
      }
      if (!merged.has(k)) merged.set(k, { n: cleanName(n), s: new Array(W).fill(null), key: k });
      const rec = merged.get(k);
      if (!rec.n.includes(",") && n.includes(",")) rec.n = cleanName(n);
      states.forEach((st, j) => { if (st === "P" || (st === "A" && rec.s[j] === null)) rec.s[j] = st; });
    }
    const people = [];
    for (const rec of merged.values()) {
      const first = rec.s.findIndex((x) => x !== null);
      if (first < 0) continue;
      const p = { n: rec.n, w: rec.s.map((x, j) => (j < first ? "N" : x || "G")).join("") };
      if (marked.has(rec.key)) p.b = 1;
      people.push(p);
    }
    people.sort((a, b) => cmp(casefold(a.n), casefold(b.n)));
    const weeks = weekly.map((tab, j) => ({ label: `${MON[tab.date.getMonth()]} ${tab.date.getDate()}`, date: iso(tab.date), visitors: visitors[j] }));
    return { weeks, people, unknownMarks };
  }

  /* ---------- Archive tab (written by tools/weekly_tab.gs) ----------
     Header row with (at least) Name, Left on, Reason; optional Last on list, Returned, Week history.
     Week history = "2026-08-16:P 2026-08-23:A …". Returns [{n, key, left, reason, returned, hist:Map(iso->P|A)}]. */
  function parseArchive(rows) {
    if (!rows || rows.length < 2) return [];
    const head = rows[0].map((h) => casefold(String(h).trim()));
    const col = (...names) => head.findIndex((h) => names.includes(h));
    const ci = { n: col("name"), left: col("left on", "left", "date left"), reason: col("reason"),
                 ret: col("returned", "returned on"), hist: col("week history", "history") };
    if (ci.n < 0) return [];
    const out = [];
    for (const r of rows.slice(1)) {
      const n = r[ci.n];
      if (typeof n !== "string" || !n.trim()) continue;
      const left = ci.left >= 0 ? parseHistoryDate(r[ci.left]) : null;
      const hist = new Map();
      if (ci.hist >= 0) for (const m of String(r[ci.hist] || "").matchAll(/(\d{4}-\d{2}-\d{2})\s*:\s*([PA])/g)) hist.set(m[1], m[2]);
      out.push({ n: cleanName(n), key: nameKey(n), left: left ? iso(left) : "", reason: String(ci.reason >= 0 ? r[ci.reason] || "" : "").trim(),
                 returned: ci.ret >= 0 && String(r[ci.ret] || "").trim() !== "", hist });
    }
    return out;
  }

  /* ---------- Name check (port of crossref_lib.norm_key + edit distance) ---------- */
  const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
  function normName(s) {
    s = String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    s = s.replace(/\(.*?\)/g, " ").toLowerCase().replace(/\./g, " ").replace(/[^a-z,' \-]/g, " ").replace(/\s+/g, " ").trim();
    let last, first;
    if (s.includes(",")) { const i = s.indexOf(","); last = s.slice(0, i); first = s.slice(i + 1); }
    else { const p = s.split(" "); if (p.length < 2) return null; last = p[p.length - 1]; first = p.slice(0, -1).join(" "); }
    const clean = (x) => x.replace(/'/g, "").replace(/-/g, " ").split(" ").filter((t) => t && !SUFFIX.has(t)).join(" ");
    // "Smith Jr, John" / "John Smith Jr": a bare suffix after the comma-less split moves the surname
    if (!s.includes(",") && SUFFIX.has(last.replace(/[' -]/g, ""))) { const p = first.split(" "); if (p.length < 2) return null; last = p.pop(); first = p.join(" "); }
    last = clean(last); first = clean(first);
    return last && first ? { last, first } : null;
  }
  /* optimal-string-alignment distance (a swap of two letters counts as one) */
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  }
  /* entries: [{n, where}] -> [{a, b, why}] pairs worth a human look. Never merges anything.
     Only pairs that include at least one entry with where === "list" are reported. */
  function nameCheck(entries) {
    const E = entries.map((e) => ({ ...e, nn: normName(e.n), k: nameKey(e.n) })).filter((e) => e.nn);
    const out = [], seen = new Set();
    for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
      const a = E[i], b = E[j];
      if (a.where !== "list" && b.where !== "list") continue;
      if (a.k === b.k) continue;   // same key: already merged as one person (or an Archive comeback)
      const A = a.nn, B = b.nn;
      let why = null;
      const firstTok = (x) => x.split(" ")[0];
      const toks = (x) => (x.last + " " + x.first).split(" ").sort().join(" ");
      if ((A.last === B.last && A.first === B.first) || toks(A) === toks(B)) why = "same name once case, spacing, order, hyphens and Jr./Sr. are ignored";
      else if (A.last === B.first && A.first === B.last) why = "first and last name swapped";
      else if (A.last === B.last && (editDistance(A.first, B.first, 1) <= 1 || editDistance(firstTok(A.first), firstTok(B.first), 1) <= 1) && Math.min(A.first.length, B.first.length) >= 3) why = "first names differ by one letter";
      else if ((A.first === B.first || firstTok(A.first) === firstTok(B.first)) && Math.min(A.last.length, B.last.length) >= 4 && editDistance(A.last, B.last, 1) <= 1) why = "last names differ by one letter";
      if (!why) continue;
      const id = [a.n, a.where, b.n, b.where].join("|");
      if (seen.has(id)) continue;
      seen.add(id);
      const [x, y] = a.where === "list" ? [a, b] : [b, a];
      out.push({ a: x.n, aw: x.where, b: y.n, bw: y.where, why });
    }
    return out.sort((p, q) => cmp(casefold(p.a), casefold(q.a)));
  }

  /* ---------- the tracking rules, applied to the snapshot and to live data alike ----------
     1. Canonical roster: only people on the NEWEST counted tab (its main list, or credited
        through the newcomer area that week) are tracked; everyone else drops out of every count.
     2. Enrollment: weeks before someone's first appearance are "N" (never absent).
     3. Comebacks: a tracked person who is on the Archive gets weeks restored from its Week history
        where the loaded tabs have no row for them.
     4. b:1 (marked Baptized) people are kept on screen but out of red/yellow and the weekly counts.
     Returns {weeks, people, left, archive:{baptizedThisYear, chrismatedThisYear, recent}, nameCheck} */
  function applyRules(data, archiveRows, now) {
    const W = data.weeks.length, last = W - 1;
    const archive = parseArchive(archiveRows || []);
    const arcByKey = new Map();
    for (const a of archive) { if (!arcByKey.has(a.key)) arcByKey.set(a.key, []); arcByKey.get(a.key).push(a); }
    const tracked = [], left = [];
    for (const p0 of data.people) {
      if (!(p0.w[last] === "P" || p0.w[last] === "A")) { left.push(p0); continue; }
      let w = p0.w.split("");
      let restored = 0;
      for (const a of arcByKey.get(nameKey(p0.n)) || []) {
        data.weeks.forEach((wk, j) => {
          if ((w[j] === "N" || w[j] === "G") && a.hist.has(wk.date)) { w[j] = a.hist.get(wk.date); restored++; }
        });
      }
      if (restored) {
        const first = w.findIndex((c) => c === "P" || c === "A");
        w = w.map((c, j) => (j < first ? "N" : c === "N" ? "G" : c));
      }
      const p = { n: p0.n, w: w.join("") };
      if (p0.b) p.b = 1;
      if (restored) p.restored = restored;
      if (arcByKey.has(nameKey(p0.n))) p.cameBack = 1;
      tracked.push(p);
    }
    const year = String(pacificNow(now || new Date()).y);
    const live = archive.filter((a) => !a.returned);
    const isBapt = (a) => /^bapti[sz]ed/i.test(a.reason), isChrism = (a) => /^chrismated/i.test(a.reason);
    const nowD = now || new Date(), yearAgo = iso(new Date(nowD.getTime() - 365 * 864e5));
    const recent = live.filter((a) => (isBapt(a) || isChrism(a)) && a.left && a.left >= yearAgo).sort((a, b) => cmp(b.left, a.left)).slice(0, 6)
      .map((a) => ({ n: a.n, reason: isBapt(a) ? "Baptized" : "Chrismated", date: a.left }));
    const entries = [
      ...tracked.map((p) => ({ n: p.n, where: "list" })),
      ...left.filter((p) => /[PA]/.test(p.w)).map((p) => ({ n: p.n, where: "left" })),
      ...live.map((a) => ({ n: a.n, where: "archive" })),
    ];
    return {
      ...data, people: tracked, leftCount: left.length,
      archive: { rows: archive.length, baptizedThisYear: live.filter((a) => isBapt(a) && a.left.startsWith(year)).length,
                 chrismatedThisYear: live.filter((a) => isChrism(a) && a.left.startsWith(year)).length, recent },
      nameCheck: nameCheck(entries),
    };
  }

  const api = { parseArchive, normName, editDistance, nameCheck, applyRules, isMark, nameKey, cleanName, discoverTabs, pacificNow, tabDate, selectWeeklyTabs, historyWeeks, isHistoryTab, combineWeeks, parseCSV, build };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Roll = api;
})(typeof self !== "undefined" ? self : this);
