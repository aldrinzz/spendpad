// Runs google-sheet/Code.gs against a fake Google Sheet, so the sync rules are tested without a Google account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fakeBook() {
  const sheets = {};
  const makeSheet = () => {
    let cells = [];
    return {
      cells: () => cells,
      getDataRange: () => ({ getValues: () => (cells.length ? cells.map(r => r.slice()) : [['']]) }),
      getRange: (row, col, nRows, nCols) => ({
        setValues(values) {
          assert.equal(values.length, nRows);
          values.forEach((r, i) => { assert.equal(r.length, nCols); cells[row - 1 + i] = r.slice(); });
        },
        setNumberFormat() {},
      }),
      clearContents() { cells = []; },
      setFrozenRows() {},
    };
  };
  return {
    sheets,
    getSheetByName: name => sheets[name] || null,
    insertSheet: name => (sheets[name] = makeSheet()),
  };
}

function loadScript(key) {
  const book = fakeBook();
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => book },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: text => ({ setMimeType: () => ({ text }) }),
    },
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'google-sheet', 'Code.gs'), 'utf8').replace("'CHANGE-ME';", JSON.stringify(key) + ';');
  vm.runInContext(src, ctx);
  const post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { book, post, ctx };
}

const entry = (id, t, extra) => Object.assign({ id, date: '2026-10-10', amount: 100, method: 'card', who: '1', type: 'spend', deleted: false, ts: t, t, note: '' }, extra);

test('refuses a wrong key, and the unedited placeholder key', () => {
  const { post } = loadScript('secret');
  assert.deepEqual(post({ key: 'nope', entries: [entry('a', 1)] }), { ok: false, error: 'Wrong sync key' });
  const fresh = loadScript('CHANGE-ME');
  assert.equal(fresh.post({ key: 'CHANGE-ME' }).ok, false);
});

test('stores entries and settings and hands them back with the right types', () => {
  const { post, book } = loadScript('secret');
  const out = post({ key: 'secret', entries: [entry('a', 1)], settings: { 'limit:2026-10': { v: 500, t: 1 }, name1: { v: 'Asha', t: 1 } } });
  assert.equal(out.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(out.entries)), [entry('a', 1)]);
  assert.deepEqual(JSON.parse(JSON.stringify(out.settings)), { 'limit:2026-10': { v: 500, t: 1 }, name1: { v: 'Asha', t: 1 } });
  // The sheet is readable by a person: a header row, then one row per expense.
  assert.deepEqual([...book.sheets.Entries.cells()[0]], ['date', 'amount', 'method', 'who', 'type', 'deleted', 'id', 'ts', 't', 'note']);
  assert.deepEqual([...book.sheets.Entries.cells()[1].slice(0, 4)], ['2026-10-10', '100', 'card', '1']);
});

test('the second phone gets the first phone’s data, and newer edits win', () => {
  const { post } = loadScript('secret');
  post({ key: 'secret', entries: [entry('a', 5)], settings: { emergency: { v: 2000, t: 5 } } });
  // Phone 2 sends an older copy of 'a', a newer delete of nothing, and its own spend.
  const out = post({ key: 'secret', entries: [entry('a', 1, { amount: 999 }), entry('b', 6, { who: '2', method: 'upi' })], settings: { emergency: { v: 1, t: 2 } } });
  const byId = Object.fromEntries(out.entries.map(e => [e.id, e]));
  assert.equal(byId.a.amount, 100);
  assert.equal(byId.b.method, 'upi');
  assert.equal(out.settings.emergency.v, 2000);
  // A later delete from phone 1 replaces the row.
  const out2 = post({ key: 'secret', entries: [entry('b', 9, { who: '2', method: 'upi', deleted: true })] });
  assert.equal(out2.entries.find(e => e.id === 'b').deleted, true);
});

test('a pull with nothing to send just returns everything', () => {
  const { post } = loadScript('secret');
  post({ key: 'secret', entries: [entry('a', 1), entry('b', 2)] });
  assert.equal(post({ key: 'secret' }).entries.length, 2);
});

test('notes and list settings (like the quick-note list) survive the round trip', () => {
  const { post } = loadScript('secret');
  const notes = [{ name: 'Zomato/Swiggy', subs: ['Breakfast', 'Lunch', 'Dinner'] }, { name: 'Milk', subs: [] }];
  post({ key: 'secret', entries: [entry('a', 1, { note: 'Zomato/Swiggy · Lunch' })], settings: { notes: { v: notes, t: 1 } } });
  const out = post({ key: 'secret' });
  assert.equal(out.entries[0].note, 'Zomato/Swiggy · Lunch');
  assert.deepEqual(JSON.parse(JSON.stringify(out.settings.notes.v)), notes);
});
