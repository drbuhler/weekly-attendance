/* Attendance dashboard.
   The passcode decrypts data.enc.json in the browser (PBKDF2-SHA256 -> AES-256-GCM). That file holds
   (a) the last good snapshot of the roster and (b) where the published roll sheet lives. The snapshot
   is shown immediately; the page then reads the sheet LIVE (visible weekly tabs + the History tab)
   and swaps in the live data if it loads and looks sane. If the live read fails for ANY reason the
   snapshot stays on screen with a "showing data as of" note. Nothing renders before the passcode. */
(() => {
  "use strict";
  const DATA_URL = "data.enc.json";
  const DEFAULT_WEEKS = 8;
  const LIVE_TIMEOUT_MS = 20000;
  const MIN_ITER = 600000;
  const SS_PREFIX = "wa-key:";
  const LABEL = { P: "Attended", A: "Absent", N: "Not yet enrolled", G: "Not on that week's sheet" };

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64e = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
  const pct = (x) => (x == null ? "–" : Math.round(x * 100) + "%");

  let blob = null;      // encrypted file
  let SNAP = null;      // decrypted snapshot payload (fallback)
  let LIVE = null;      // live-sheet settings {pub, weeks} from the payload
  let D = null;         // what is on screen + derived stats
  let loading = false;
  const ui = { q: "", filter: "all", sort: "name" };
  const status = { mode: "snapshot", text: "" };

  /* ---------- crypto ---------- */
  async function deriveKeyBits(pass, salt, iter) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
    return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, 256);
  }
  async function decryptWithBits(bits) {
    const key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(blob.iv) }, key, b64d(blob.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  /* ---------- lock screen ---------- */
  const msg = (t, info) => { const m = $("#lockMsg"); m.textContent = t || ""; m.classList.toggle("info", !!info); };

  async function loadBlob() {
    for (let attempt = 0; attempt < 3 && !blob; attempt++) {
      try {
        const r = await fetch(DATA_URL, { cache: "no-store" });
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        if (j.v !== 1 || !j.salt || !j.iv || !j.ct || !(j.iter >= MIN_ITER)) throw new Error("format");
        blob = j;
      } catch (e) { await new Promise((res) => setTimeout(res, 800 * (attempt + 1))); }
    }
    if (!blob) {
      msg("This page couldn't load just now. Please check your connection and reload.");
      $("#unlockBtn").disabled = true;
      return;
    }
    const saved = sessionStorage.getItem(SS_PREFIX + blob.salt);
    if (saved) {
      msg("Unlocking…", true);
      let payload = null;
      try { payload = await decryptWithBits(b64d(saved)); } catch { sessionStorage.removeItem(SS_PREFIX + blob.salt); msg(""); }
      if (payload) { start(payload); return; }
    }
    $("#pass").focus();
  }

  $("#lockForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!blob) return;
    const input = $("#pass"), btn = $("#unlockBtn");
    const pass = input.value;
    if (!pass) return;
    btn.disabled = true; msg("Unlocking…", true);
    let payload = null;
    try {
      const bits = await deriveKeyBits(pass, b64d(blob.salt), blob.iter);
      payload = await decryptWithBits(bits);
      if ($("#remember").checked) sessionStorage.setItem(SS_PREFIX + blob.salt, b64e(bits));
      input.value = "";
    } catch (e) {
      msg("That passcode didn't work. Please check it and try again.");
      input.select();
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    start(payload);
  });

  /* ---------- snapshot first, then live ---------- */
  const fmtStamp = (isoStr) => {
    const d = new Date(isoStr);
    return isNaN(d) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  function snapshotData() {
    return { title: SNAP.title, banner: SNAP.banner || "", weeks: SNAP.weeks, people: SNAP.people, archiveRows: SNAP.archive || [], older: SNAP.older || null,
             unknownMarks: 0, source: "snapshot" };
  }

  function start(payload) {
    SNAP = payload;
    LIVE = payload.live && typeof payload.live.pub === "string" ? payload.live : null;
    const asOf = fmtStamp(SNAP.generated);
    if (LIVE) { status.mode = "checking"; status.text = `Showing saved data as of ${asOf} · checking the live roll sheet…`; }
    else { status.mode = "snapshot"; status.text = `Showing data as of ${asOf}`; }
    show(snapshotData());
    if (LIVE) goLive();
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  }

  async function fetchText(url) {
    const r = await fetch(url, { cache: "no-store", credentials: "omit", redirect: "follow" });
    if (!r.ok) throw new Error("http " + r.status);
    const t = await r.text();
    return t;
  }
  const csvText = (t) => { if (/^\s*<(!doctype|html)/i.test(t)) throw new Error("not csv"); return t; };

  async function loadLive(cfg) {
    const base = cfg.pub, n = cfg.weeks || DEFAULT_WEEKS, now = new Date();
    const tabs = Roll.discoverTabs(await fetchText(base + "pubhtml"));
    if (!tabs.length) throw new Error("no tabs");
    const visible = Roll.selectWeeklyTabs(tabs, now, n);
    const histTab = tabs.find(Roll.isHistoryTab);
    const arcTab = tabs.find((t) => /^\s*archive\s*$/i.test(t.name));
    const csvUrl = (gid) => `${base}pub?gid=${encodeURIComponent(gid)}&single=true&output=csv`;
    const [arc, hist, texts] = await Promise.all([
      arcTab ? fetchText(csvUrl(arcTab.gid)).then((t) => Roll.parseCSV(csvText(t))).catch(() => null) : Promise.resolve([]),
      histTab ? fetchText(csvUrl(histTab.gid)).then((t) => Roll.historyWeeks(Roll.parseCSV(csvText(t)))).catch(() => null) : Promise.resolve(null),
      Promise.all(visible.map((t) => fetchText(csvUrl(t.gid)).then(csvText))),
    ]);
    visible.forEach((t, j) => { t.rows = Roll.parseCSV(texts[j]); });
    const weekly = Roll.combineWeeks(visible, hist || [], now, n);
    if (!weekly.length) throw new Error("no weekly tabs");
    const out = Roll.build(weekly);
    return { title: SNAP.title, banner: "", weeks: out.weeks, people: out.people, unknownMarks: out.unknownMarks,
             archiveRows: arc || [], archiveOk: arc !== null, older: SNAP.older || null, source: "live", loadedAt: new Date(), historyFound: !!histTab, historyOk: hist !== null,
             historyWeeksUsed: weekly.filter((w) => w.fromHistory).length, wanted: n };
  }

  /* reject live results that look broken (e.g. the sheet layout changed) rather than show them */
  function looksSane(L) {
    if (!L.people.length || !L.weeks.length) return false;
    if (SNAP && SNAP.people && L.people.length < 0.5 * SNAP.people.length) return false;
    const last = L.weeks.length - 1;
    return L.people.some((p) => p.w[last] === "P" || p.w[last] === "A");
  }

  async function goLive() {
    if (loading || !LIVE) return;
    loading = true;
    const btn = $("#refreshBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
    try {
      const L = await withTimeout(loadLive(LIVE), LIVE_TIMEOUT_MS);
      if (!looksSane(L)) throw new Error("implausible");
      const t = L.loadedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      let extra = "";
      if (L.weeks.length < L.wanted) extra = L.historyFound
        ? ` · ${L.weeks.length} of ${L.wanted} weeks available`
        : ` · only ${L.weeks.length} weeks visible (no History tab), so streaks may be shorter`;
      else if (L.historyFound && !L.historyOk) extra = " · History tab couldn't be read";
      if (!L.archiveOk) extra += " · Archive tab couldn't be read";
      status.mode = "live"; status.text = `Live from the roll sheet · loaded ${t}${extra}`;
      show(L);
    } catch (e) {
      const asOf = D && D.source === "live" ? "loaded earlier" : `as of ${fmtStamp(SNAP.generated)}`;
      status.mode = "fallback";
      status.text = D && D.source === "live"
        ? "Couldn't reach the live roll sheet just now · still showing the data loaded earlier"
        : `Showing saved data ${asOf} · the live roll sheet couldn't be reached right now`;
      paintStatus();
    } finally {
      loading = false;
      const b = $("#refreshBtn");
      if (b) { b.disabled = false; b.textContent = "Refresh"; }
    }
  }
  const refresh = () => goLive();

  function paintStatus() {
    const n = $("#liveNote");
    if (!n) return;
    n.innerHTML = `<span class="live-dot" aria-hidden="true"></span>${esc(status.text)}`;
    n.className = "live " + status.mode;
  }

  /* ---------- model ---------- */
  function build(raw) {
    const data = Roll.applyRules(raw, raw.archiveRows, new Date());
    const weeks = data.weeks, W = weeks.length, last = W - 1;
    const people = data.people.map((p, i) => {
      const w = p.w;
      let present = 0, recorded = 0, lastIdx = -1, first = -1;
      for (let j = 0; j < W; j++) {
        const c = w[j];
        if (first < 0 && c !== "N") first = j;
        if (c === "P") { present++; recorded++; lastIdx = j; } else if (c === "A") recorded++;
      }
      let streak = 0;
      for (let j = last; j >= 0; j--) {
        const c = w[j];
        if (c === "A") streak++; else if (c === "G") continue; else break;
      }
      // marked Baptized: shown, but outside red/yellow and the weekly counts
      const status = p.b ? "baptized" : streak >= 5 ? "red" : streak >= 3 ? "yellow" : "ok";
      return { id: i, name: p.n, w, present, recorded, pct: recorded ? present / recorded : null,
               lastIdx, first, streak, status, offLatest: w[last] === "G", key: p.n.toLowerCase(),
               cameBack: !!p.cameBack, restored: p.restored || 0,
               lastSeen: p.lastSeen || "", sessions: p.sessions || 0, since: p.since || "" };
    });
    const weekly = weeks.map((_, j) => {
      let pr = 0, ab = 0;
      for (const p of people) { if (p.status === "baptized") continue; if (p.w[j] === "P") pr++; else if (p.w[j] === "A") ab++; }
      const v = weeks[j].visitors;  // count only; visitors are never in the people list
      return { present: pr, onSheet: pr + ab, pct: pr + ab ? pr / (pr + ab) : null, visitors: Number.isInteger(v) ? v : null };
    });
    const count = (s) => people.filter((p) => p.status === s).length;
    return { ...data, W, people, weekly, red: count("red"), yellow: count("yellow"), ok: count("ok"), baptized: count("baptized") };
  }

  const fmtDate = (iso, opts) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", opts || { month: "short", day: "numeric" });
  const monYear = (iso) => fmtDate(iso, { month: "short", year: "numeric" });
  /* most recent of the loaded weeks and the older record; "never" only with no record anywhere */
  const lastAttended = (p) => (p.lastIdx >= 0 ? fmtDate(D.weeks[p.lastIdx].date) : p.lastSeen ? "Last seen " + monYear(p.lastSeen) : "never");
  const lastShort = (p) => (p.lastIdx >= 0 ? fmtDate(D.weeks[p.lastIdx].date) : p.lastSeen ? monYear(p.lastSeen) : "never");
  const weeksTxt = (n) => n + (n === 1 ? " week" : " weeks");

  /* ---------- render ---------- */
  function show(data) {
    D = build(data);
    window.__attendanceSummary = {  // aggregate-only hook used by automated checks
      source: D.source, status: status.mode, historyWeeksUsed: D.historyWeeksUsed || 0,
      people: D.people.length, red: D.red, yellow: D.yellow, ok: D.ok, unknownMarks: D.unknownMarks || 0,
      markedBaptized: D.baptized, leftList: D.leftCount, nameCheck: D.nameCheck.length, cameBack: D.people.filter((p) => p.cameBack).length,
      archive: { rows: D.archive.rows, baptizedThisYear: D.archive.baptizedThisYear, chrismatedThisYear: D.archive.chrismatedThisYear, recent: D.archive.recent.length },
      laterWeekOnly: D.people.filter((p) => p.first > 0).length,
      olderRecord: !!D.older, lastSeenOlder: D.people.filter((p) => p.lastIdx < 0 && p.lastSeen).length,
      neverAnywhere: D.people.filter((p) => !p.lastSeen).length,
      redNever: D.people.filter((p) => p.status === "red" && !p.lastSeen).length,
      redLastSeenOlder: D.people.filter((p) => p.status === "red" && p.lastIdx < 0 && p.lastSeen).length,
      weekly: D.weekly.map((w, j) => ({ date: D.weeks[j].date, present: w.present, onSheet: w.onSheet, pct: w.pct, visitors: w.visitors })),
    };
    $("#lock").hidden = true;
    const app = $("#app");
    app.hidden = false;
    document.title = D.title || "Attendance";
    const keep = { q: ui.q };
    app.innerHTML = shell();
    if (keep.q) $("#q").value = keep.q;
    $("#sort").value = ui.sort;
    renderRoster();
    wire();
  }

  function shell() {
    const W = D.W, L = D.weekly[W - 1], wk = D.weeks;
    const avg = D.weekly.reduce((a, w) => a + (w.pct || 0), 0) / D.weekly.filter((w) => w.pct != null).length;
    const maxP = Math.max(...D.weekly.map((w) => w.pct || 0), 0.01);
    const visTxt = (n) => (n == null ? "" : ` · ${n} visitor${n === 1 ? "" : "s"}`);
    const spark = D.weekly.map((w, j) => `<i style="height:${Math.max(6, Math.round(((w.pct || 0) / maxP) * 100))}%" title="${esc(wk[j].label)}: ${pct(w.pct)} (${w.present}/${w.onSheet})${visTxt(w.visitors)}"></i>`).join("");
    const hasVis = D.weekly.some((w) => w.visitors != null);
    const visRow = hasVis ? `<div class="spark-v" title="Checked in but not yet on the main list; not counted in any other figure"><div class="lbl">Visitors per week</div><div class="nums">${D.weekly.map((w, j) => `<span title="${esc(wk[j].label)}: ${w.visitors == null ? "no count" : w.visitors + " visitors"}">${w.visitors == null ? "·" : w.visitors}</span>`).join("")}</div></div>` : "";
    const firstPct = D.weekly.find((w) => w.pct != null)?.pct;
    const delta = L.pct != null && firstPct != null ? Math.round((L.pct - firstPct) * 100) : null;
    const tracked = D.people.length - D.baptized;
    const A = D.archive;
    const celebrate = A.baptizedThisYear || A.chrismatedThisYear || A.recent.length || D.baptized ? `
      <section class="celebrate" aria-label="Baptisms">
        <div class="cel-main"><span class="cel-ico" aria-hidden="true">🎉</span><div><div class="cel-v">${A.baptizedThisYear}</div><div class="cel-k">Baptized this year${A.chrismatedThisYear ? ` · ${A.chrismatedThisYear} chrismated` : ""}</div></div></div>
        ${A.recent.length ? `<ul class="cel-list">${A.recent.map((r) => `<li><b>${esc(r.n)}</b> <span>${esc(r.reason.toLowerCase())} · ${esc(fmtDate(r.date))}</span></li>`).join("")}</ul>` : ""}
        ${D.baptized ? `<button type="button" class="cel-marked" data-filter="baptized">${D.baptized} marked baptized on the list · ready to remove</button>` : ""}
      </section>` : "";
    const nc = D.nameCheck;
    const WHERE = { list: "on the list", left: "no longer on the list", archive: "on the Archive" };
    const nameCheck = nc.length ? `
      <details class="namecheck"><summary><h2>Name check</h2><span class="count">${nc.length}</span><span class="hint">possible duplicates or misspellings, for a human to review — nothing is merged automatically</span></summary>
        <table><thead><tr><th>Name</th><th>Looks like</th><th>Why</th></tr></thead><tbody>
        ${nc.map((x) => `<tr><td>${esc(x.a)}</td><td>${esc(x.b)} <span class="muted">(${WHERE[x.bw]})</span></td><td class="muted">${esc(x.why)}</td></tr>`).join("")}
        </tbody></table></details>` : "";
    return `
      <div class="top">
        <div><h1>${esc(D.title || "Attendance")}</h1>
          <div class="sub">${esc(wk[0].label)} – ${esc(wk[W - 1].label)} · ${W} Sundays</div>
          <div class="live ${status.mode}" id="liveNote" role="status"><span class="live-dot" aria-hidden="true"></span>${esc(status.text)}</div></div>
        <div class="top-btns">
          ${LIVE ? `<button class="btn-ghost" id="refreshBtn" type="button"${loading ? " disabled" : ""}>${loading ? "Refreshing…" : "Refresh"}</button>` : ""}
          <button class="btn-ghost" id="lockBtn" type="button">Lock</button>
        </div>
      </div>
      ${D.banner ? `<div class="banner">${esc(D.banner)}</div>` : ""}
      <section class="kpis" aria-label="Summary">
        <div class="kpi"><div class="k">Catechumens</div><div class="v">${tracked}</div><div class="s">on the ${esc(wk[W - 1].label)} list${D.leftCount ? ` · ${D.leftCount} who left aren't counted` : ""}</div></div>
        <div class="kpi"><div class="k">Attended ${esc(wk[W - 1].label)}</div><div class="v">${L.present}</div><div class="s">${pct(L.pct)} of those on the sheet</div>${L.visitors == null ? "" : `<div class="s vis" title="Checked in but not yet on the main list. Not included in any other figure.">+ ${L.visitors} visitor${L.visitors === 1 ? "" : "s"}</div>`}</div>
        <div class="kpi trend"><div class="k">Weekly attendance</div>
          <div class="v">${pct(L.pct)}<span class="s" style="font:500 12.5px var(--sans);margin-left:8px">${delta == null ? "" : (delta >= 0 ? "+" : "") + delta + " pts since " + esc(wk[0].label)} · avg ${pct(avg)}</span></div>
          <div class="spark" role="img" aria-label="Weekly attendance percentages">${spark}</div>
          <div class="spark-l"><span>${esc(wk[0].label)}</span><span>${esc(wk[W - 1].label)}</span></div>${visRow}</div>
        <div class="kpi red"><div class="k">Red</div><div class="v">${D.red}</div><div class="s">missed 5+ Sundays in a row</div></div>
        <div class="kpi amber"><div class="k">Yellow</div><div class="v">${D.yellow}</div><div class="s">missed 3–4 in a row</div></div>
      </section>
      ${celebrate}
      <section class="panels">
        ${panel("red", "Red", "5+ Sundays missed in a row")}
        ${panel("yellow", "Yellow", "3–4 Sundays missed in a row")}
      </section>
      <section class="roster" aria-label="Everyone">
        <div class="roster-head">
          <h2>Everyone</h2>
          <input class="search" id="q" type="search" placeholder="Search by name" aria-label="Search by name" autocomplete="off" spellcheck="false">
          <div class="chips" role="group" aria-label="Filter">
            ${chip("all", "All", D.people.length)}${chip("red", "Red", D.red)}${chip("yellow", "Yellow", D.yellow)}${chip("ok", "OK", D.ok)}${D.baptized ? chip("baptized", "Baptized", D.baptized) : ""}
          </div>
          <label class="sr-only" for="sort">Sort</label>
          <select class="sort" id="sort">
            <option value="name">Sort: name</option>
            <option value="streak">Sort: weeks absent</option>
            <option value="pct-asc">Sort: attendance % (low → high)</option>
            <option value="pct-desc">Sort: attendance % (high → low)</option>
            <option value="last-asc">Sort: last seen (longest ago first)</option>
          </select>
        </div>
        <div class="legend">
          <span><i class="sq c-P"></i>Attended</span><span><i class="sq c-A"></i>Absent</span>
          <span><i class="sq c-N"></i>Not yet enrolled</span><span><i class="sq c-G"></i>Not on that week's sheet</span>
        </div>
        <div class="grid-wrap"><div class="grid" id="grid" style="--weeks:${W}"></div></div>
      </section>
      ${nameCheck}
      <p class="foot">"Last seen" uses the loaded weeks and, before them, the sheet's older tabs (master grids since May 2025 and the summer tabs). Weeks absent counts consecutive missed Sundays back from ${esc(wk[W - 1].label)}. Weeks before someone's first sign-in are "not yet enrolled", and weeks their name was missing from the sheet are skipped; neither counts as an absence. Attendance % = Sundays attended ÷ Sundays they were on the sheet. Only people on the ${esc(wk[W - 1].label)} list are tracked; anyone who has left the list is left out of every figure. People marked Baptized (column D) are shown but not counted.${hasVis ? " Visitors are people who checked in but aren't on the main list yet; they appear only as a weekly count and aren't part of any other figure." : ""} A Sunday's tab is counted from 12:00 PM Pacific that day.${D.unknownMarks ? ` ${D.unknownMarks} unrecognized check mark${D.unknownMarks === 1 ? " was" : "s were"} treated as blank.` : ""}</p>`;
  }

  function chip(v, label, n) { return `<button type="button" class="chip" data-filter="${v}" aria-pressed="${ui.filter === v}">${label}<b>${n}</b></button>`; }

  function panel(status, title, hint) {
    const list = D.people.filter((p) => p.status === status).sort((a, b) => b.streak - a.streak || a.key.localeCompare(b.key));
    const cls = status === "red" ? "red" : "amber";
    const rows = list.map((p) => `<tr><td><button class="linkname" data-id="${p.id}">${esc(p.name)}</button></td><td>${esc(lastAttended(p))}</td><td class="num">${p.streak}</td></tr>`).join("");
    return `<div class="panel ${cls}"><header><h2>${title}</h2><span class="count">${list.length}</span><span class="hint">${hint}</span></header>
      <div class="plist">${list.length ? `<table><thead><tr><th>Name</th><th>Last attended</th><th class="num">Weeks absent</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">No one right now.</div>`}</div></div>`;
  }

  function visible() {
    const q = ui.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = D.people.filter((p) => (ui.filter === "all" || p.status === ui.filter) && q.every((t) => p.key.includes(t)));
    const byName = (a, b) => a.key.localeCompare(b.key);
    const pv = (p, hi) => (p.pct == null ? (hi ? -1 : 2) : p.pct);
    const sorters = {
      name: byName,
      streak: (a, b) => b.streak - a.streak || byName(a, b),
      "pct-asc": (a, b) => pv(a, false) - pv(b, false) || byName(a, b),
      "pct-desc": (a, b) => pv(b, true) - pv(a, true) || byName(a, b),
      "last-asc": (a, b) => (a.lastSeen || "").localeCompare(b.lastSeen || "") || byName(a, b),
    };
    return list.sort(sorters[ui.sort]);
  }

  function renderRoster() {
    const wk = D.weeks;
    const head = `<div class="row head"><div class="nm"><span class="colh" style="text-align:left">Name</span></div>${wk.map((w) => `<div class="wk"><span>${esc(w.label)}</span></div>`).join("")}<div class="colh" title="Sundays missed in a row">Missed</div><div class="colh">%</div><div class="colh">Last seen</div></div>`;
    const list = visible();
    const rows = list.map((p) => {
      const cells = [...p.w].map((c, j) => `<i class="sq c-${c}" title="${esc(wk[j].label)}: ${LABEL[c]}"></i>`).join("");
      const sc = p.status === "ok" ? "" : p.status;
      const tag = p.status === "baptized" ? `<span class="tag">baptized</span>` : "";
      return `<div class="row"><div class="nm"><span class="dot ${sc}" aria-hidden="true"></span><button class="linkname" data-id="${p.id}" title="${esc(p.name)}">${esc(p.name)}</button>${tag}</div>${cells}<div class="cell-num ${sc}">${p.status === "baptized" ? "–" : p.streak}</div><div class="cell-num">${pct(p.pct)}</div><div class="cell-num last${p.lastSeen ? "" : " never"}">${esc(lastShort(p))}</div></div>`;
    }).join("");
    $("#grid").innerHTML = head + (rows || `<div class="noresults">No one matches.</div>`);
  }

  function openDetails(id) {
    const p = D.people[id], wk = D.weeks;
    const statusTxt = { red: "Red · 5+ in a row", yellow: "Yellow · 3–4 in a row", ok: "OK", baptized: "Marked baptized · not counted" }[p.status];
    const hist = wk.map((w, j) => ({ w, c: p.w[j] })).reverse()
      .map(({ w, c }) => `<li><span class="d">${esc(fmtDate(w.date))}</span><i class="sq c-${c}"></i><span>${LABEL[c]}</span></li>`).join("");
    $("#modalBody").innerHTML = `
      <h3 id="mName">${esc(p.name)}</h3><span class="pill ${p.status}">${statusTxt}</span>
      <div class="stats">
        <div class="stat"><div class="k">Last attended</div><div class="v">${esc(lastAttended(p))}</div></div>
        <div class="stat"><div class="k">Absent streak</div><div class="v">${weeksTxt(p.streak)}</div></div>
        <div class="stat"><div class="k">Attendance</div><div class="v">${pct(p.pct)} <span class="muted" style="font:13px var(--sans)">(${p.present} of ${p.recorded})</span></div></div>
        <div class="stat"><div class="k">First on sheet</div><div class="v">${p.first >= 0 ? esc(fmtDate(wk[p.first].date)) : "–"}</div></div>
      </div>
      ${p.sessions ? `<p class="note">Attended ${p.sessions} Sunday${p.sessions === 1 ? "" : "s"} on record since ${esc(monYear(p.since))}${p.lastIdx < 0 ? `, most recently ${esc(fmtDate(p.lastSeen, { month: "short", day: "numeric", year: "numeric" }))}` : ""}.</p>` : `<p class="note">No attendance on record in this sheet, including the older tabs.</p>`}
      <ul class="hist">${hist}</ul>
      ${p.status === "baptized" ? `<p class="note">Marked Baptized in column D. Remove the name from the list when ready; the weekly script will move it to the Archive.</p>` : ""}
      ${p.cameBack ? `<p class="note">Came back after being on the Archive${p.restored ? `; ${weeksTxt(p.restored)} restored from it` : ""}.</p>` : ""}`;
    const m = $("#modal");
    m.hidden = false;
    m._return = document.activeElement;
    $(".modal-x", m).focus();
  }
  function closeDetails() { const m = $("#modal"); if (m.hidden) return; m.hidden = true; m._return?.focus?.(); }

  let appWired = false;
  function wire() {
    const app = $("#app");
    if (!appWired) { appWired = true; app.addEventListener("click", (e) => {
      const n = e.target.closest("[data-id]");
      if (n) return openDetails(+n.dataset.id);
      const c = e.target.closest("[data-filter]");
      if (c) {
        ui.filter = c.dataset.filter;
        app.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.filter === ui.filter));
        renderRoster();
      }
    }); }
    let t;
    $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { ui.q = e.target.value; renderRoster(); }, 80); });
    $("#sort").addEventListener("change", (e) => { ui.sort = e.target.value; renderRoster(); });
    if ($("#refreshBtn")) $("#refreshBtn").addEventListener("click", refresh);
    $("#lockBtn").addEventListener("click", () => {
      Object.keys(sessionStorage).filter((k) => k.startsWith(SS_PREFIX)).forEach((k) => sessionStorage.removeItem(k));
      location.reload();
    });
  }
  $("#modal").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDetails(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetails(); });

  if (!window.crypto?.subtle) { msg("This browser can't open the page (secure connection required)."); return; }
  loadBlob();
})();
