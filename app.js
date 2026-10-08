/* Attendance dashboard: decrypts data.enc.json in the browser (PBKDF2-SHA256 -> AES-256-GCM).
   No data is present in this file or in index.html; nothing renders until decryption succeeds. */
(() => {
  "use strict";
  const DATA_URL = "data.enc.json";
  const MIN_ITER = 600000;
  const SS_PREFIX = "wa-key:";
  const LABEL = { P: "Attended", A: "Absent", N: "Not yet enrolled", G: "Not on that week's sheet" };

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64e = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
  const pct = (x) => (x == null ? "–" : Math.round(x * 100) + "%");

  let blob = null;      // encrypted file contents
  let D = null;         // decrypted payload + derived stats
  const ui = { q: "", filter: "all", sort: "name" };

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
    try {
      const r = await fetch(DATA_URL, { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      if (j.v !== 1 || !j.salt || !j.iv || !j.ct || !(j.iter >= MIN_ITER)) throw new Error("format");
      blob = j;
    } catch (e) {
      msg("The data file couldn't be loaded. Please try again later.");
      $("#unlockBtn").disabled = true;
      return;
    }
    const saved = sessionStorage.getItem(SS_PREFIX + blob.salt);
    if (saved) {
      msg("Unlocking…", true);
      try { show(await decryptWithBits(b64d(saved))); return; }
      catch { sessionStorage.removeItem(SS_PREFIX + blob.salt); msg(""); }
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
    try {
      const bits = await deriveKeyBits(pass, b64d(blob.salt), blob.iter);
      const data = await decryptWithBits(bits);
      if ($("#remember").checked) sessionStorage.setItem(SS_PREFIX + blob.salt, b64e(bits));
      input.value = "";
      show(data);
    } catch (e) {
      msg("That passcode didn't work. Please check it and try again.");
      input.select();
    } finally { btn.disabled = false; }
  });

  /* ---------- model ---------- */
  function build(data) {
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
      const status = streak >= 5 ? "red" : streak >= 3 ? "yellow" : "ok";
      return { id: i, name: p.n, w, present, recorded, pct: recorded ? present / recorded : null,
               lastIdx, first, streak, status, offLatest: w[last] === "G", key: p.n.toLowerCase() };
    });
    const weekly = weeks.map((_, j) => {
      let pr = 0, ab = 0;
      for (const p of people) { if (p.w[j] === "P") pr++; else if (p.w[j] === "A") ab++; }
      return { present: pr, onSheet: pr + ab, pct: pr + ab ? pr / (pr + ab) : null };
    });
    const count = (s) => people.filter((p) => p.status === s).length;
    return { ...data, W, people, weekly, red: count("red"), yellow: count("yellow"), ok: count("ok") };
  }

  const fmtDate = (iso, opts) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", opts || { month: "short", day: "numeric" });
  const lastAttended = (p) => (p.lastIdx < 0 ? "never" : fmtDate(D.weeks[p.lastIdx].date));
  const weeksTxt = (n) => n + (n === 1 ? " week" : " weeks");

  /* ---------- render ---------- */
  function show(data) {
    D = build(data);
    window.__attendanceSummary = {  // aggregate-only hook used by automated checks
      people: D.people.length, red: D.red, yellow: D.yellow, ok: D.ok,
      laterWeekOnly: D.people.filter((p) => p.first > 0).length,
      weekly: D.weekly.map((w, j) => ({ date: D.weeks[j].date, present: w.present, onSheet: w.onSheet, pct: w.pct })),
    };
    $("#lock").hidden = true;
    const app = $("#app");
    app.hidden = false;
    document.title = D.title || "Attendance";
    app.innerHTML = shell();
    renderRoster();
    wire();
  }

  function shell() {
    const W = D.W, L = D.weekly[W - 1], wk = D.weeks;
    const avg = D.weekly.reduce((a, w) => a + (w.pct || 0), 0) / D.weekly.filter((w) => w.pct != null).length;
    const maxP = Math.max(...D.weekly.map((w) => w.pct || 0), 0.01);
    const spark = D.weekly.map((w, j) => `<i style="height:${Math.max(6, Math.round(((w.pct || 0) / maxP) * 100))}%" title="${esc(wk[j].label)}: ${pct(w.pct)} (${w.present}/${w.onSheet})"></i>`).join("");
    const firstPct = D.weekly.find((w) => w.pct != null)?.pct;
    const delta = L.pct != null && firstPct != null ? Math.round((L.pct - firstPct) * 100) : null;
    const onLatest = D.people.filter((p) => p.w[W - 1] === "P" || p.w[W - 1] === "A").length;
    const updated = D.generated ? fmtDate(D.generated.slice(0, 10), { month: "long", day: "numeric", year: "numeric" }) : "";
    return `
      <div class="top">
        <div><h1>${esc(D.title || "Attendance")}</h1>
          <div class="sub">${esc(wk[0].label)} – ${esc(wk[W - 1].label)} · ${W} Sundays${updated ? " · updated " + esc(updated) : ""}</div></div>
        <button class="btn-ghost" id="lockBtn" type="button">Lock</button>
      </div>
      ${D.banner ? `<div class="banner">${esc(D.banner)}</div>` : ""}
      <section class="kpis" aria-label="Summary">
        <div class="kpi"><div class="k">Catechumens</div><div class="v">${D.people.length}</div><div class="s">${onLatest} on the ${esc(wk[W - 1].label)} sheet</div></div>
        <div class="kpi"><div class="k">Attended ${esc(wk[W - 1].label)}</div><div class="v">${L.present}</div><div class="s">${pct(L.pct)} of those on the sheet</div></div>
        <div class="kpi trend"><div class="k">Weekly attendance</div>
          <div class="v">${pct(L.pct)}<span class="s" style="font:500 12.5px var(--sans);margin-left:8px">${delta == null ? "" : (delta >= 0 ? "+" : "") + delta + " pts since " + esc(wk[0].label)} · avg ${pct(avg)}</span></div>
          <div class="spark" role="img" aria-label="Weekly attendance percentages">${spark}</div>
          <div class="spark-l"><span>${esc(wk[0].label)}</span><span>${esc(wk[W - 1].label)}</span></div></div>
        <div class="kpi red"><div class="k">Red</div><div class="v">${D.red}</div><div class="s">missed 5+ Sundays in a row</div></div>
        <div class="kpi amber"><div class="k">Yellow</div><div class="v">${D.yellow}</div><div class="s">missed 3–4 in a row</div></div>
      </section>
      <section class="panels">
        ${panel("red", "Red", "5+ Sundays missed in a row")}
        ${panel("yellow", "Yellow", "3–4 Sundays missed in a row")}
      </section>
      <section class="roster" aria-label="Everyone">
        <div class="roster-head">
          <h2>Everyone</h2>
          <input class="search" id="q" type="search" placeholder="Search by name" aria-label="Search by name" autocomplete="off" spellcheck="false">
          <div class="chips" role="group" aria-label="Filter">
            ${chip("all", "All", D.people.length)}${chip("red", "Red", D.red)}${chip("yellow", "Yellow", D.yellow)}${chip("ok", "OK", D.ok)}
          </div>
          <label class="sr-only" for="sort">Sort</label>
          <select class="sort" id="sort">
            <option value="name">Sort: name</option>
            <option value="streak">Sort: weeks absent</option>
            <option value="pct-asc">Sort: attendance % (low → high)</option>
            <option value="pct-desc">Sort: attendance % (high → low)</option>
          </select>
        </div>
        <div class="legend">
          <span><i class="sq c-P"></i>Attended</span><span><i class="sq c-A"></i>Absent</span>
          <span><i class="sq c-N"></i>Not yet enrolled</span><span><i class="sq c-G"></i>Not on that week's sheet</span>
        </div>
        <div class="grid-wrap"><div class="grid" id="grid" style="--weeks:${W}"></div></div>
      </section>
      <p class="foot">Weeks absent counts consecutive missed Sundays back from ${esc(wk[W - 1].label)}. Weeks before someone's first sign-in are "not yet enrolled", and weeks their name was missing from the sheet are skipped; neither counts as an absence. Attendance % = Sundays attended ÷ Sundays they were on the sheet.</p>`;
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
    };
    return list.sort(sorters[ui.sort]);
  }

  function renderRoster() {
    const wk = D.weeks;
    const head = `<div class="row head"><div class="nm"><span class="colh" style="text-align:left">Name</span></div>${wk.map((w) => `<div class="wk"><span>${esc(w.label)}</span></div>`).join("")}<div class="colh" title="Sundays missed in a row">Missed</div><div class="colh">%</div></div>`;
    const list = visible();
    const rows = list.map((p) => {
      const cells = [...p.w].map((c, j) => `<i class="sq c-${c}" title="${esc(wk[j].label)}: ${LABEL[c]}"></i>`).join("");
      const sc = p.status === "ok" ? "" : p.status;
      return `<div class="row"><div class="nm"><span class="dot ${sc}" aria-hidden="true"></span><button class="linkname" data-id="${p.id}" title="${esc(p.name)}">${esc(p.name)}</button></div>${cells}<div class="cell-num ${sc}">${p.streak}</div><div class="cell-num">${pct(p.pct)}</div></div>`;
    }).join("");
    $("#grid").innerHTML = head + (rows || `<div class="noresults">No one matches.</div>`);
  }

  function openDetails(id) {
    const p = D.people[id], wk = D.weeks;
    const statusTxt = { red: "Red · 5+ in a row", yellow: "Yellow · 3–4 in a row", ok: "OK" }[p.status];
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
      <ul class="hist">${hist}</ul>
      ${p.offLatest ? `<p class="note">Not on the ${esc(wk[wk.length - 1].label)} sheet.</p>` : ""}`;
    const m = $("#modal");
    m.hidden = false;
    m._return = document.activeElement;
    $(".modal-x", m).focus();
  }
  function closeDetails() { const m = $("#modal"); if (m.hidden) return; m.hidden = true; m._return?.focus?.(); }

  function wire() {
    const app = $("#app");
    app.addEventListener("click", (e) => {
      const n = e.target.closest("[data-id]");
      if (n) return openDetails(+n.dataset.id);
      const c = e.target.closest("[data-filter]");
      if (c) {
        ui.filter = c.dataset.filter;
        app.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.filter === ui.filter));
        renderRoster();
      }
    });
    let t;
    $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { ui.q = e.target.value; renderRoster(); }, 80); });
    $("#sort").addEventListener("change", (e) => { ui.sort = e.target.value; renderRoster(); });
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
