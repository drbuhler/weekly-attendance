/**
 * Weekly roll-sheet maintenance for the catechumen attendance sheet (Google Apps Script).
 *
 * Install: in the sheet, Extensions > Apps Script, paste this whole file, save, then run
 * `setupAttendanceSheet` once from the editor and approve the permissions. That creates the
 * History / Archive / Name check tabs, backfills History, adds the Baptized checkboxes and
 * installs a trigger that runs `weeklyUpdate` every Sunday around 3 PM Pacific.
 * An "Attendance" menu also appears in the sheet (reload it after installing).
 *
 * What weeklyUpdate does, in this order (each step is safe to re-run):
 *  1. ARCHIVE   Names on the previous Sunday's tab but not on the newest one are copied to the
 *               Archive tab with their week-by-week history and the date they left. Martha picks
 *               the Reason (Baptized / Chrismated / Washed out / Moved / Other). If the person was
 *               marked Baptized in column D, Reason is pre-filled "Baptized".
 *  2. COMEBACKS If someone on the Archive is back on the newest tab, their Archive row gets a
 *               "Returned" date; the dashboard then restores their old history.
 *  3. NEW TAB   Makes next Sunday's tab (e.g. "Oct 18") as a copy of the newest tab, with every
 *               check box cleared and the newcomer names cleared. New names are NEVER moved onto
 *               the main list. Rows marked Baptized are highlighted with a note so Martha can remove them.
 *  4. HISTORY   Every weekly tab 6+ weeks old is copied to the History tab (all of its name cells and
 *               check boxes), verified, and only then hidden. A tab is never hidden if its copy failed.
 *               (Published pages leave hidden tabs out; the dashboard reads them back from History.)
 *  5. NAME CHECK Rewrites the "Name check" tab: likely duplicates and near-misspellings on the newest
 *               tab (main list, NEW NAMES area and Archive). Nothing is ever merged automatically.
 *               Pairs listed on the "Name check exceptions" tab (e.g. a father and son) are skipped.
 *  NEW NAMES are never copied onto the main list by this script; the dashboard counts them only as
 *  that Sunday's Visitors.
 *
 * The dashboard reads History, Archive and the weekly tabs from the published sheet, so these tabs
 * must stay VISIBLE and be included in File > Share > Publish to web.
 */

const CFG = {
  TZ: 'America/Los_Angeles',
  COL_CHECK: 2,        // B  main-list check box
  COL_NAME: 3,         // C  main-list name, "Last, First"
  COL_BAPTIZED: 4,     // D  Baptized marker (check box)
  COL_NEW_CHECK: 8,    // H  NEW NAMES check box
  COL_NEW_NAME: 9,     // I  NEW NAMES name
  HISTORY: 'History',
  ARCHIVE: 'Archive',
  NAME_CHECK: 'Name check',
  NAME_CHECK_EXCEPTIONS: 'Name check exceptions', // two names per row that are confirmed different people (e.g. father/son)
  FIRST_WEEKLY_TAB: '2026-08-09', // older "Mon D" tabs (e.g. the 'May 17' master grid, summer tabs) are left alone
  HIDE_AFTER_WEEKS: 6,     // tabs this many weeks old (or older) are copied to History, then hidden
  KEEP_HISTORY_WEEKS: 26,  // History rows older than this are trimmed
  REASONS: ['Baptized', 'Chrismated', 'Washed out', 'Moved', 'Other'],
  CLEAR_OFFLIST_NAMES: true, // on the new tab, clear write-in names in column C that have no comma
  RUN_HOUR: 15,              // Sunday trigger hour (Pacific), after the 12:00 PM cutoff
  DASHBOARD: 'Dashboard',
  DASHBOARD_COUNT_COLS: [5, 7], // E, G: "sessions attended" counts that Sheets turned into dates
};
const HISTORY_HEAD = ['Date', 'Section', 'Name', 'Checked'];
const ARCHIVE_HEAD = ['Name', 'Left on', 'Last on list', 'Reason', 'First seen', 'Sundays on list',
  'Sundays present', 'Returned', 'Week history', 'Archived on'];
const NAME_CHECK_HEAD = ['Name', 'Where', 'Looks like', 'Where', 'Why', 'Checked on'];

/* ------------------------------------------------------------------ menu & setup */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Attendance')
    .addItem('Run weekly update now', 'weeklyUpdate')
    .addItem('Check names now', 'nameCheckNow')
    .addSeparator()
    .addItem('Set up (first time)', 'setupAttendanceSheet')
    .addItem('Fix Dashboard session counts shown as dates', 'fixDashboardSessionCounts')
    .addToUi();
}

function setupAttendanceSheet() {
  const ss = SpreadsheetApp.getActive();
  const hist = ensureSheet_(ss, CFG.HISTORY, HISTORY_HEAD);
  hist.getRange('A:A').setNumberFormat('@');
  const arc = ensureSheet_(ss, CFG.ARCHIVE, ARCHIVE_HEAD);
  arc.getRange('B:C').setNumberFormat('@');
  arc.getRange('E:E').setNumberFormat('@');
  arc.getRange('H:H').setNumberFormat('@');
  arc.getRange('J:J').setNumberFormat('@');
  arc.getRange(2, 4, arc.getMaxRows() - 1, 1).setDataValidation(reasonRule_());
  ensureSheet_(ss, CFG.NAME_CHECK, NAME_CHECK_HEAD);
  ensureSheet_(ss, CFG.NAME_CHECK_EXCEPTIONS, ['Name', 'Is NOT the same person as']);

  // Baptized check boxes in column D next to every main-list name, on the newest and upcoming tabs
  const today = todayIso_();
  const tabs = datedTabs_(ss);
  const recent = tabs.filter((t) => t.iso <= today).slice(-1).concat(tabs.filter((t) => t.iso > today));
  recent.forEach((t) => addBaptizedBoxes_(t.sheet));

  // backfill History from every old tab (hidden or not) and hide the old visible ones
  historyAndHide_(ss, true);
  // put people who already left the list (in the last KEEP_HISTORY_WEEKS) on the Archive, so
  // Martha can fill in Reasons for this year's baptisms
  backfillArchive_(ss);

  // weekly trigger
  const have = ScriptApp.getProjectTriggers().some((tr) => tr.getHandlerFunction() === 'weeklyUpdate');
  if (!have) {
    ScriptApp.newTrigger('weeklyUpdate').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY)
      .atHour(CFG.RUN_HOUR).inTimezone(CFG.TZ).create();
  }
  SpreadsheetApp.getActive().toast('Attendance setup finished.');
}

function addBaptizedBoxes_(sheet) {
  const n = sheet.getLastRow();
  if (n < 1) return;
  const names = sheet.getRange(1, CFG.COL_NAME, n, 1).getValues();
  const d = sheet.getRange(1, CFG.COL_BAPTIZED, n, 1);
  const dv = d.getValues();
  names.forEach((r, i) => {
    if (isListName_(r[0]) && (dv[i][0] === '' || dv[i][0] === null)) sheet.getRange(i + 1, CFG.COL_BAPTIZED).insertCheckboxes();
  });
  const first = names.findIndex((r) => isListName_(r[0]));
  if (first > 0 && sheet.getRange(first, CFG.COL_BAPTIZED).getValue() === '') sheet.getRange(first, CFG.COL_BAPTIZED).setValue('Baptized');
}

/* ------------------------------------------------------------------ weekly run */

function weeklyUpdate() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) throw new Error('Another attendance update is running.');
  const errors = [];
  const step = (name, fn) => { try { fn(); } catch (e) { errors.push(name + ': ' + (e && e.message || e)); console.error(name, e); } };
  try {
    const ss = SpreadsheetApp.getActive();
    ensureSheet_(ss, CFG.HISTORY, HISTORY_HEAD);
    ensureSheet_(ss, CFG.ARCHIVE, ARCHIVE_HEAD);
    ensureSheet_(ss, CFG.NAME_CHECK, NAME_CHECK_HEAD);
    const today = todayIso_();
    const done = () => datedTabs_(ss).filter((t) => t.iso <= today);
    step('archive', () => {
      const d = done();
      if (d.length >= 2) archiveDepartures_(ss, d[d.length - 2], d[d.length - 1]);
    });
    step('comebacks', () => { const d = done(); if (d.length) markComebacks_(ss, d[d.length - 1]); });
    step('new tab', () => { const d = done(); if (d.length) createNextTab_(ss, d[d.length - 1], today); });
    step('history', () => historyAndHide_(ss, false));
    step('name check', () => nameCheckNow());
  } finally {
    lock.releaseLock();
  }
  if (errors.length) throw new Error('Attendance update finished with problems: ' + errors.join(' | '));
}

/* 1. ARCHIVE */
function archiveDepartures_(ss, prevTab, newestTab) {
  const prev = readTab_(prevTab.sheet), newest = readTab_(newestTab.sheet);
  const stillHere = new Set([...newest.main.keys(), ...newest.checkedNew]);
  const leaving = [...prev.main.entries()].filter(([k]) => !stillHere.has(k));
  if (!leaving.length) return;
  const arc = ss.getSheetByName(CFG.ARCHIVE);
  const existing = arc.getLastRow() > 1 ? arc.getRange(2, 1, arc.getLastRow() - 1, 2).getDisplayValues() : [];
  const have = new Set(existing.map((r) => nameKey(r[0]) + '|' + r[1]));
  const weeks = allWeeks_(ss);
  const rows = [];
  for (const [k, p] of leaving) {
    if (have.has(k + '|' + newestTab.iso)) continue;
    const h = personHistory(weeks, k);
    rows.push([p.name, newestTab.iso, prevTab.iso, p.baptized ? 'Baptized' : '', h.first, String(h.onList), String(h.present), '',
      h.text, todayIso_()]);
  }
  if (!rows.length) return;
  const start = arc.getLastRow() + 1;
  arc.getRange(start, 1, rows.length, ARCHIVE_HEAD.length).setNumberFormat('@').setValues(rows);
  arc.getRange(start, 4, rows.length, 1).setDataValidation(reasonRule_());
}

/* first-time setup: everyone who left the list in the loaded weeks and is not back on the newest tab */
function backfillArchive_(ss) {
  const weeks = allWeeks_(ss);
  if (weeks.length < 2) return;
  const newest = weeks[weeks.length - 1];
  const here = new Set([...newest.main.keys(), ...newest.checkedNew]);
  const leftOn = new Map(); // key -> {name, left, last, baptized}
  for (let i = 1; i < weeks.length; i++) {
    const a = weeks[i - 1], b = weeks[i];
    for (const [k, p] of a.main) {
      if (!b.main.has(k) && !b.checkedNew.has(k) && !here.has(k)) leftOn.set(k, { name: p.name, left: b.iso, last: a.iso, baptized: p.baptized });
    }
  }
  const arc = ss.getSheetByName(CFG.ARCHIVE);
  const existing = arc.getLastRow() > 1 ? arc.getRange(2, 1, arc.getLastRow() - 1, 1).getDisplayValues() : [];
  const have = new Set(existing.map((r) => nameKey(r[0])));
  const rows = [];
  leftOn.forEach((p, k) => {
    if (have.has(k)) return;
    const h = personHistory(weeks, k);
    rows.push([p.name, p.left, p.last, p.baptized ? 'Baptized' : '', h.first, String(h.onList), String(h.present), '', h.text, todayIso_()]);
  });
  if (!rows.length) return;
  rows.sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const start = arc.getLastRow() + 1;
  arc.getRange(start, 1, rows.length, ARCHIVE_HEAD.length).setNumberFormat('@').setValues(rows);
  arc.getRange(start, 4, rows.length, 1).setDataValidation(reasonRule_());
}

/* 2. COMEBACKS */
function markComebacks_(ss, newestTab) {
  const arc = ss.getSheetByName(CFG.ARCHIVE);
  if (arc.getLastRow() < 2) return;
  const onList = readTab_(newestTab.sheet).main;
  const vals = arc.getRange(2, 1, arc.getLastRow() - 1, 8).getDisplayValues();
  vals.forEach((r, i) => {
    if (r[0] && !r[7] && onList.has(nameKey(r[0])) && r[1] <= newestTab.iso) {
      arc.getRange(i + 2, 8).setNumberFormat('@').setValue(newestTab.iso);
    }
  });
}

/* 3. NEW TAB */
function createNextTab_(ss, newestTab, today) {
  const t = parseIso_(today);
  const next = new Date(t.getTime() + ((7 - t.getDay()) % 7 || 7) * 864e5); // next Sunday after today
  const iso = isoOf_(next);
  if (datedTabs_(ss).some((x) => x.iso === iso)) return; // already made (by hand or earlier run)
  const name = Utilities.formatDate(next, CFG.TZ, 'MMM d');
  const sh = newestTab.sheet.copyTo(ss).setName(name);
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(newestTab.sheet.getIndex() + 1);
  const n = sh.getLastRow();
  if (n < 1) return;
  sh.getRange(1, CFG.COL_CHECK, n, 1).uncheck();
  sh.getRange(1, CFG.COL_NEW_CHECK, n, 1).uncheck();
  const vals = sh.getRange(1, 1, n, CFG.COL_NEW_NAME).getValues();
  // newcomer names: everything below the "NEW NAMES" heading in column I
  const head = vals.findIndex((r) => String(r[CFG.COL_NEW_NAME - 1]).toUpperCase().indexOf('NEW NAMES') >= 0);
  if (head >= 0 && head + 1 < n) sh.getRange(head + 2, CFG.COL_NEW_NAME, n - head - 1, 1).clearContent();
  // write-in names in column C without a comma (below the start of the main list)
  const firstList = vals.findIndex((r) => isListName_(r[CFG.COL_NAME - 1]));
  vals.forEach((r, i) => {
    const c = r[CFG.COL_NAME - 1];
    if (CFG.CLEAR_OFFLIST_NAMES && firstList >= 0 && i > firstList && typeof c === 'string' && c.trim() && c.indexOf(',') < 0) {
      sh.getRange(i + 1, CFG.COL_NAME).clearContent();
    }
    if (isListName_(c) && isMark(r[CFG.COL_BAPTIZED - 1])) {
      sh.getRange(i + 1, 1, 1, CFG.COL_BAPTIZED).setBackground('#dbeafe');
      sh.getRange(i + 1, CFG.COL_NAME).setNote('Marked Baptized. Please remove this name from the list when ready; ' +
        'the weekly update will move it to the Archive with Reason "Baptized".');
    }
  });
}

/* 4. HISTORY + HIDE */
function historyAndHide_(ss, backfillAll) {
  const hist = ensureSheet_(ss, CFG.HISTORY, HISTORY_HEAD);
  const cutoff = isoOf_(new Date(parseIso_(todayIso_()).getTime() - CFG.HIDE_AFTER_WEEKS * 7 * 864e5));
  const keepFrom = isoOf_(new Date(parseIso_(todayIso_()).getTime() - CFG.KEEP_HISTORY_WEEKS * 7 * 864e5));
  let body = hist.getLastRow() > 1 ? hist.getRange(2, 1, hist.getLastRow() - 1, 4).getDisplayValues() : [];
  const datesIn = () => new Set(body.map((r) => r[0]));
  const old = datedTabs_(ss).filter((t) => t.iso <= cutoff && t.iso >= keepFrom);
  const toHide = [];
  for (const t of old) {
    const hidden = t.sheet.isSheetHidden();
    if (hidden && !(backfillAll && !datesIn().has(t.iso))) continue;
    const rows = historyRows(t.iso, t.sheet.getRange(1, 1, Math.max(1, t.sheet.getLastRow()), CFG.COL_NEW_NAME).getValues());
    body = body.filter((r) => r[0] !== t.iso).concat(rows);
    if (!hidden) toHide.push({ t, n: rows.length });
  }
  body = body.filter((r) => r[0] >= keepFrom).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // rewrite History in one go, then verify before hiding anything
  const lastRow = hist.getLastRow();
  if (lastRow > 1) hist.getRange(2, 1, lastRow - 1, 4).clearContent();
  if (body.length) hist.getRange(2, 1, body.length, 4).setNumberFormat('@').setValues(body);
  SpreadsheetApp.flush();
  const check = body.length ? hist.getRange(2, 1, body.length, 1).getDisplayValues() : [];
  const count = {};
  check.forEach((r) => { count[r[0]] = (count[r[0]] || 0) + 1; });
  for (const { t, n } of toHide) {
    if ((count[t.iso] || 0) === n && n > 0) t.sheet.hideSheet();
    else console.warn('Not hiding ' + t.sheet.getName() + ': History copy did not verify');
  }
}

/* 5. NAME CHECK */
function nameCheckNow() {
  const ss = SpreadsheetApp.getActive();
  const today = todayIso_();
  const d = datedTabs_(ss).filter((t) => t.iso <= today);
  const tabs = datedTabs_(ss);
  const target = tabs.filter((t) => t.iso > today)[0] || d[d.length - 1]; // the tab Martha is editing now
  if (!target) return;
  const tab = readTab_(target.sheet);
  const entries = [...tab.main.values()].map((p) => ({ n: p.name, where: 'list' }))
    .concat(tab.newNames.map((n) => ({ n, where: 'NEW NAMES' })));
  const arc = ss.getSheetByName(CFG.ARCHIVE);
  if (arc && arc.getLastRow() > 1) {
    arc.getRange(2, 1, arc.getLastRow() - 1, 8).getDisplayValues()
      .filter((r) => r[0] && !r[7]).forEach((r) => entries.push({ n: r[0], where: 'Archive' }));
  }
  const ex = ss.getSheetByName(CFG.NAME_CHECK_EXCEPTIONS);
  const notSame = new Set();
  if (ex && ex.getLastRow() > 1) {
    ex.getRange(2, 1, ex.getLastRow() - 1, 2).getDisplayValues().forEach((r) => {
      if (r[0] && r[1]) { notSame.add(nameKey(r[0]) + '|' + nameKey(r[1])); notSame.add(nameKey(r[1]) + '|' + nameKey(r[0])); }
    });
  }
  const pairs = nameCheck(entries, notSame);
  const out = ensureSheet_(ss, CFG.NAME_CHECK, NAME_CHECK_HEAD);
  if (out.getLastRow() > 1) out.getRange(2, 1, out.getLastRow() - 1, NAME_CHECK_HEAD.length).clearContent();
  const stamp = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd HH:mm');
  const rows = pairs.map((p) => [p.a, p.aw === 'list' ? target.sheet.getName() + ' list' : p.aw, p.b,
    p.bw === 'list' ? target.sheet.getName() + ' list' : p.bw, p.why, stamp]);
  if (rows.length) out.getRange(2, 1, rows.length, NAME_CHECK_HEAD.length).setValues(rows);
}

/* Dashboard tab: counts like "6/15" were turned into dates (Jun 15) by Sheets. This rewrites every
   date in columns E and G as plain text "6 of 15" and sets those columns to plain text so it can't
   happen again. (Manual equivalent: select E:G > Format > Number > Plain text, then retype.) */
function fixDashboardSessionCounts() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.DASHBOARD);
  if (!sh || sh.getLastRow() < 1) return;
  for (const c of CFG.DASHBOARD_COUNT_COLS) {
    const rg = sh.getRange(1, c, sh.getLastRow(), 1);
    const v = rg.getValues();
    const isDate = (x) => Object.prototype.toString.call(x) === '[object Date]';
    rg.setNumberFormat('@');
    v.forEach((r, i) => { if (isDate(r[0])) sh.getRange(i + 1, c).setValue((r[0].getMonth() + 1) + ' of ' + r[0].getDate()); });
  }
}

/* ------------------------------------------------------------------ sheet helpers */

function ensureSheet_(ss, name, head) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name, ss.getNumSheets());
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  if (sh.isSheetHidden()) sh.showSheet(); // must stay visible to be published
  return sh;
}

function reasonRule_() {
  return SpreadsheetApp.newDataValidation().requireValueInList(CFG.REASONS, true).setAllowInvalid(false).build();
}

function todayIso_() { return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'); }

/* weekly tabs named like "Oct 4" / "Sept 20", oldest first, with the nearest-year date */
function datedTabs_(ss) {
  const today = parseIso_(todayIso_());
  return ss.getSheets().map((sheet) => {
    const d = tabDateNear(sheet.getName(), today);
    return d ? { sheet, iso: isoOf_(d) } : null;
  }).filter((t) => t && t.iso >= CFG.FIRST_WEEKLY_TAB).sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
}

/* one weekly tab -> {main: Map(key -> {name, checked, baptized}), checkedNew: Set(keys), newNames: [name]} */
function readTab_(sheet) {
  const n = Math.max(1, sheet.getLastRow());
  return parseTabValues(sheet.getRange(1, 1, n, CFG.COL_NEW_NAME).getValues());
}

/* every week we know about: dated tabs (hidden or not) + History dates that no longer have a tab */
function allWeeks_(ss) {
  const weeks = new Map();
  const hist = ss.getSheetByName(CFG.HISTORY);
  if (hist && hist.getLastRow() > 1) {
    const byDate = new Map();
    hist.getRange(2, 1, hist.getLastRow() - 1, 4).getDisplayValues().forEach((r) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r[0])) return;
      const row = ['', '', '', '', '', '', '', '', ''];
      if (r[1] === 'main') { row[1] = r[3]; row[2] = r[2]; } else if (r[1] === 'new') { row[7] = r[3]; row[8] = r[2]; } else return;
      if (!byDate.has(r[0])) byDate.set(r[0], []);
      byDate.get(r[0]).push(row);
    });
    byDate.forEach((rows, iso) => weeks.set(iso, parseTabValues(rows)));
  }
  const today = todayIso_();
  datedTabs_(ss).filter((t) => t.iso <= today).forEach((t) => weeks.set(t.iso, readTab_(t.sheet)));
  return [...weeks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([iso, w]) => ({ iso, ...w }));
}

/* ------------------------------------------------------------------ pure helpers (no Sheets calls) */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const PRESENT = ['true', 'x', 'yes', 'y', '1', 'present', '✓', '✔'];
const MARKS = PRESENT.concat(['baptized', 'baptised', 'chrismated', 'b']);

function parseIso_(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return new Date(+m[1], +m[2] - 1, +m[3], 12); }
function isoOf_(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

/* "Oct 4" -> the date with that month/day nearest to `today` (handles Dec/Jan) */
function tabDateNear(name, today) {
  const m = /^\s*([A-Za-z]+)\.?\s*(\d{1,2})\s*$/.exec(name);
  if (!m) return null;
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  let best = null;
  for (const y of [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1]) {
    const d = new Date(y, mo - 1, +m[2], 12);
    if (d.getMonth() !== mo - 1) return null;
    if (!best || Math.abs(d - today) < Math.abs(best - today)) best = d;
  }
  return best;
}

function cellText(v) { return v === true ? 'TRUE' : v === false ? 'FALSE' : v == null ? '' : String(v); }
function isChecked(v) { return v === true || PRESENT.indexOf(String(v == null ? '' : v).trim().toLowerCase()) >= 0; }
function isMark(v) { return v === true || MARKS.indexOf(String(v == null ? '' : v).trim().toLowerCase()) >= 0; }
function isListName_(v) { return typeof v === 'string' && v.trim() !== '' && v.indexOf(',') >= 0; }

/* same key as the dashboard: case, spacing, punctuation and word order ignored */
function nameKey(name) {
  const t = String(name).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
  return t.sort().join(' ');
}

function parseTabValues(values) {
  const main = new Map(), checkedNew = new Set(), newNames = [];
  for (const r of values) {
    const b = r[CFG.COL_CHECK - 1], c = r[CFG.COL_NAME - 1], dmark = r[CFG.COL_BAPTIZED - 1];
    const h = r[CFG.COL_NEW_CHECK - 1], i = r[CFG.COL_NEW_NAME - 1];
    if (isListName_(c)) {
      const k = nameKey(c), prev = main.get(k);
      main.set(k, { name: c.trim(), checked: isChecked(b) || !!(prev && prev.checked), baptized: isMark(dmark) || !!(prev && prev.baptized) });
    } else if (typeof c === 'string' && c.trim() && !/^\d+(\.\d+)?$/.test(c.trim())) {
      if (isChecked(b)) checkedNew.add(nameKey(c));
    }
    if (typeof i === 'string' && i.trim() && i.toUpperCase().indexOf('NEW NAMES') < 0) {
      newNames.push(i.trim());
      if (isChecked(h)) checkedNew.add(nameKey(i));
    }
  }
  return { main, checkedNew, newNames };
}

/* History rows for one tab: every non-empty name cell in C (with B) and I (with H) */
function historyRows(iso, values) {
  const rows = [];
  for (const r of values) {
    const c = r[CFG.COL_NAME - 1], i = r[CFG.COL_NEW_NAME - 1];
    if (typeof c === 'string' && c.trim()) rows.push([iso, 'main', c, cellText(r[CFG.COL_CHECK - 1])]);
    if (typeof i === 'string' && i.trim()) rows.push([iso, 'new', i, cellText(r[CFG.COL_NEW_CHECK - 1])]);
  }
  return rows;
}

/* per-person history across weeks: P = checked (or checked in through NEW NAMES once on the list), A = on the list, not checked */
function personHistory(weeks, key) {
  const parts = [];
  let first = '', onList = 0, present = 0, seen = false;
  for (const w of weeks) {
    const m = w.main.get(key);
    let st = null;
    if (m) st = m.checked || w.checkedNew.has(key) ? 'P' : 'A';
    else if (seen && w.checkedNew.has(key)) st = 'P';
    if (!st) continue;
    if (m) seen = true;
    if (!first) first = w.iso;
    onList++;
    if (st === 'P') present++;
    parts.push(w.iso + ':' + st);
  }
  return { first, onList, present, text: parts.join(' ') };
}

/* --- name check: same rules as assets/roll.2.js (port of crossref_lib.norm_key + edit distance) --- */
const SUFFIX = ['jr', 'sr', 'ii', 'iii', 'iv', 'v'];
function normName(s) {
  s = String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/\(.*?\)/g, ' ').toLowerCase().replace(/\./g, ' ').replace(/[^a-z,' \-]/g, ' ').replace(/\s+/g, ' ').trim();
  let last, first;
  if (s.indexOf(',') >= 0) { const i = s.indexOf(','); last = s.slice(0, i); first = s.slice(i + 1); }
  else { const p = s.split(' '); if (p.length < 2) return null; last = p[p.length - 1]; first = p.slice(0, -1).join(' '); }
  const clean = (x) => x.replace(/'/g, '').replace(/-/g, ' ').split(' ').filter((t) => t && SUFFIX.indexOf(t) < 0).join(' ');
  if (s.indexOf(',') < 0 && SUFFIX.indexOf(last.replace(/[' -]/g, '')) >= 0) { const p = first.split(' '); if (p.length < 2) return null; last = p.pop(); first = p.join(' '); }
  last = clean(last); first = clean(first);
  return last && first ? { last, first } : null;
}
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const phon = (x) => x.replace(/(ai|ay|ey)/g, 'a').replace(/e$/, '').replace(/(.)\1/g, '$1').replace(/y/g, 'i');
const near = (a, b) => editDistance(a, b, 1) <= 1 || phon(a) === phon(b);
function nameCheck(entries, notSame) {
  notSame = notSame || new Set();
  const E = entries.map((e) => Object.assign({}, e, { nn: normName(e.n), k: nameKey(e.n) })).filter((e) => e.nn);
  const out = [], seen = {};
  const firstTok = (x) => x.split(' ')[0];
  const toks = (x) => (x.last + ' ' + x.first).split(' ').sort().join(' ');
  for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
    const a = E[i], b = E[j];
    if (a.where !== 'list' && b.where !== 'list') continue;
    if (a.k === b.k) continue; // same person (or a checked-in newcomer already on the list)
    if (notSame.has(a.k + '|' + b.k)) continue; // confirmed different people
    const A = a.nn, B = b.nn;
    let why = null;
    if ((A.last === B.last && A.first === B.first) || toks(A) === toks(B)) why = 'same name once case, spacing, order, hyphens and Jr./Sr. are ignored';
    else if (A.last === B.first && A.first === B.last) why = 'first and last name swapped';
    else if (A.last === B.last && (near(A.first, B.first) || near(firstTok(A.first), firstTok(B.first))) && Math.min(A.first.length, B.first.length) >= 3) why = 'first names differ by one letter or sound alike';
    else if ((A.first === B.first || firstTok(A.first) === firstTok(B.first)) && Math.min(A.last.length, B.last.length) >= 4 && near(A.last, B.last)) why = 'last names differ by one letter or sound alike';
    if (!why) continue;
    const x = a.where === 'list' ? a : b, y = x === a ? b : a;
    const id = [x.n, x.where, y.n, y.where].join('|');
    if (seen[id]) continue;
    seen[id] = 1;
    out.push({ a: x.n, aw: x.where, b: y.n, bw: y.where, why });
  }
  return out.sort((p, q) => (p.a.toLowerCase() < q.a.toLowerCase() ? -1 : 1));
}

if (typeof module !== 'undefined') {
  module.exports = { CFG, tabDateNear, nameKey, parseTabValues, historyRows, personHistory, normName, nameCheck, isMark, isChecked, cellText };
}
