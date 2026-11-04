/**
 * LavishTracker sync. Paste this into your Google Sheet: Extensions → Apps Script.
 * Both phones send their changes here; the sheet keeps every expense and setting,
 * and the newer edit of each one wins. See SETUP.md for the 5-minute setup.
 */

// Pick any secret phrase and type the same one into the app's Settings → Sync key.
const SYNC_KEY = 'CHANGE-ME';

const ENTRY_COLS = ['date', 'amount', 'method', 'who', 'type', 'deleted', 'id', 'ts', 't', 'note'];
const SETTING_COLS = ['key', 'value', 't'];

function doGet(e) { return reply_(e && e.parameter); }
function doPost(e) { return reply_(JSON.parse(e.postData.contents)); }

function reply_(req) {
  let out;
  try { out = sync_(req || {}); } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function sync_(req) {
  if (SYNC_KEY === 'CHANGE-ME') return { ok: false, error: 'Set SYNC_KEY in the Apps Script first' };
  if (req.key !== SYNC_KEY) return { ok: false, error: 'Wrong sync key' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // the two phones never write over each other
  try {
    const book = SpreadsheetApp.getActiveSpreadsheet();
    const entries = readEntries_(book);
    const settings = readSettings_(book);
    let entriesChanged = false, settingsChanged = false;
    (req.entries || []).forEach(function (e) {
      const cur = entries[e.id];
      if (e.id && (!cur || e.t > cur.t)) { entries[e.id] = cleanEntry_(e); entriesChanged = true; }
    });
    const incoming = req.settings || {};
    Object.keys(incoming).forEach(function (k) {
      const s = incoming[k], cur = settings[k];
      if (!cur || s.t > cur.t) { settings[k] = { v: s.v, t: Number(s.t) }; settingsChanged = true; }
    });
    if (entriesChanged) writeEntries_(book, entries);
    if (settingsChanged) writeSettings_(book, settings);
    return { ok: true, entries: Object.keys(entries).map(function (id) { return entries[id]; }), settings: settings };
  } finally {
    lock.releaseLock();
  }
}

function cleanEntry_(e) {
  return {
    id: String(e.id), date: String(e.date), amount: Number(e.amount) || 0,
    method: e.method ? String(e.method) : null, who: String(e.who || '1'), type: String(e.type || 'spend'),
    deleted: e.deleted === true || e.deleted === 'true' || e.deleted === 'TRUE',
    ts: Number(e.ts) || 0, t: Number(e.t) || 0,
    note: e.note ? String(e.note) : '',
  };
}

function sheet_(book, name, cols) {
  let sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function rows_(sh, cols) {
  const values = sh.getDataRange().getValues();
  return values.slice(1).filter(function (r) { return r.join('') !== ''; }).map(function (r) {
    const o = {};
    cols.forEach(function (c, i) { o[c] = r[i]; });
    return o;
  });
}

// Every cell is stored as plain text so Sheets never turns dates or ids into something else.
function writeRows_(sh, cols, rows) {
  sh.clearContents();
  const values = [cols].concat(rows.map(function (o) { return cols.map(function (c) { return o[c] == null ? '' : String(o[c]); }); }));
  const range = sh.getRange(1, 1, values.length, cols.length);
  range.setNumberFormat('@');
  range.setValues(values);
}

function readEntries_(book) {
  const out = {};
  rows_(sheet_(book, 'Entries', ENTRY_COLS), ENTRY_COLS).forEach(function (o) { if (o.id) out[o.id] = cleanEntry_(o); });
  return out;
}

function writeEntries_(book, entries) {
  const list = Object.keys(entries).map(function (id) { return entries[id]; }).sort(function (a, b) { return a.ts - b.ts; });
  writeRows_(sheet_(book, 'Entries', ENTRY_COLS), ENTRY_COLS, list);
}

function readSettings_(book) {
  const out = {};
  rows_(sheet_(book, 'Settings', SETTING_COLS), SETTING_COLS).forEach(function (o) {
    if (o.key) out[o.key] = { v: JSON.parse(o.value), t: Number(o.t) || 0 };
  });
  return out;
}

function writeSettings_(book, settings) {
  const list = Object.keys(settings).sort().map(function (k) { return { key: k, value: JSON.stringify(settings[k].v), t: settings[k].t }; });
  writeRows_(sheet_(book, 'Settings', SETTING_COLS), SETTING_COLS, list);
}
