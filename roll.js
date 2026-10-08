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

  /* weekly: [{name, date, rows}] oldest first. Returns {weeks:[{label,date,visitors}], people:[{n,w}], unknownMarks} */
  function build(weekly) {
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
      if (!merged.has(k)) merged.set(k, { n: cleanName(n), s: new Array(W).fill(null) });
      const rec = merged.get(k);
      if (!rec.n.includes(",") && n.includes(",")) rec.n = cleanName(n);
      states.forEach((st, j) => { if (st === "P" || (st === "A" && rec.s[j] === null)) rec.s[j] = st; });
    }
    const people = [];
    for (const rec of merged.values()) {
      const first = rec.s.findIndex((x) => x !== null);
      if (first < 0) continue;
      people.push({ n: rec.n, w: rec.s.map((x, j) => (j < first ? "N" : x || "G")).join("") });
    }
    people.sort((a, b) => cmp(casefold(a.n), casefold(b.n)));
    const weeks = weekly.map((tab, j) => ({ label: `${MON[tab.date.getMonth()]} ${tab.date.getDate()}`, date: iso(tab.date), visitors: visitors[j] }));
    return { weeks, people, unknownMarks };
  }

  const api = { nameKey, cleanName, discoverTabs, pacificNow, tabDate, selectWeeklyTabs, parseCSV, build };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Roll = api;
})(typeof self !== "undefined" ? self : this);
