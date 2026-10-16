const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../budget.js');

let seq = 0;
const spend = (date, amount, method = 'card', who = '1') => ({ id: 'e' + ++seq, type: 'spend', date, amount, method, who, t: 1 });
const pay = (date, amount) => ({ id: 'p' + ++seq, type: 'pay', date, amount, t: 1 });
const settings = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { v, t: 1 }]));
const cfgOf = obj => B.configFrom(settings(obj));

test('leftover carries into tomorrow and shows as limit + carry', () => {
  const cfg = cfgOf({ 'limit:2026-10': 500, startDate: '2026-10-10' });
  const d = B.daily(cfg, [spend('2026-10-10', 400)], '2026-10-11');
  assert.equal(d.limit, 500);
  assert.equal(d.carry, 100);
  assert.equal(d.available, 600);
  assert.equal(d.left, 600);
});

test('overspending takes away from tomorrow', () => {
  const cfg = cfgOf({ 'limit:2026-10': 500, startDate: '2026-10-10' });
  const d = B.daily(cfg, [spend('2026-10-10', 600)], '2026-10-11');
  assert.equal(d.carry, -100);
  assert.equal(d.available, 400);
});

test('carry keeps adding up day by day, including no-spend days', () => {
  const cfg = cfgOf({ 'limit:2026-10': 500, startDate: '2026-10-10' });
  const entries = [spend('2026-10-10', 400), spend('2026-10-11', 300)]; // +100, +200, then the 12th untouched (+500)
  const d = B.daily(cfg, entries, '2026-10-13');
  assert.equal(d.carry, 800);
  assert.equal(d.available, 1300);
});

test("today's spends come off what's left today", () => {
  const cfg = cfgOf({ 'limit:2026-10': 500, startDate: '2026-10-10' });
  const d = B.daily(cfg, [spend('2026-10-10', 120, 'card'), spend('2026-10-10', 80, 'upi')], '2026-10-10');
  assert.equal(d.spent, 200);
  assert.equal(d.left, 300);
});

test('carry resets on the 1st and the new month limit applies', () => {
  const cfg = cfgOf({ 'limit:2026-10': 500, 'limit:2026-11': 600, startDate: '2026-10-30' });
  const d = B.daily(cfg, [spend('2026-10-30', 100), spend('2026-10-31', 100)], '2026-11-01');
  assert.equal(d.carry, 0);
  assert.equal(d.available, 600);
});

test('a month without its own limit uses the previous one', () => {
  const cfg = cfgOf({ 'limit:2026-10': 500 });
  assert.deepEqual(B.limitFor(cfg, '2026-11'), { amount: 500, set: false });
  assert.equal(B.daily(cfg, [], '2026-11-01').available, 500);
});

test('tomorrow preview: carries within the month, fresh at month end', () => {
  const cfg = cfgOf({ 'limit:2026-10': 500, 'limit:2026-11': 450, startDate: '2026-10-10' });
  const mid = B.daily(cfg, [spend('2026-10-10', 400)], '2026-10-10');
  assert.deepEqual([mid.tomorrow.limit, mid.tomorrow.carry, mid.tomorrow.fresh], [500, 100, false]);
  const end = B.daily(cfg, [], '2026-10-31');
  assert.deepEqual([end.tomorrow.limit, end.tomorrow.carry, end.tomorrow.fresh], [450, 0, true]);
});

test('starting carry applies on the first tracked day only', () => {
  const cfg = cfgOf({ 'limit:2026-10': 500, startDate: '2026-10-10', startCarry: 300 });
  assert.equal(B.daily(cfg, [], '2026-10-10').available, 800);
  assert.equal(B.daily(cfg, [], '2026-10-11').available, 1300);
  assert.equal(B.daily(cfg, [], '2026-11-01').available, 500);
});

test('deleted and future-dated spends are ignored', () => {
  const data = {
    settings: settings({ 'limit:2026-10': 500, startDate: '2026-10-10' }),
    entries: { a: Object.assign(spend('2026-10-10', 200), { id: 'a', deleted: true }), b: Object.assign(spend('2026-10-11', 50), { id: 'b' }) },
  };
  assert.equal(B.compute(data, '2026-10-10').daily.left, 500);
});

test('card cycle runs 19th to 18th and the bill is due on the 8th', () => {
  assert.deepEqual(B.cycleOf('2026-10-10', 19), { start: '2026-09-19', end: '2026-10-18' });
  assert.deepEqual(B.cycleOf('2026-10-19', 19), { start: '2026-10-19', end: '2026-11-18' });
  assert.deepEqual(B.cycleOf('2026-12-25', 19), { start: '2026-12-19', end: '2027-01-18' });
  assert.equal(B.dueAfter('2026-10-19', 8), '2026-11-08');
  assert.equal(B.dueAfter('2026-12-19', 8), '2027-01-08');
});

test('statement day 31 clamps to short months', () => {
  assert.deepEqual(B.cycleOf('2026-02-28', 31), { start: '2026-02-28', end: '2026-03-30' });
});

test('card: this cycle split by Card / UPI, older spends are the bill', () => {
  const cfg = cfgOf({ startDate: '2026-09-01' });
  const entries = [spend('2026-09-10', 1000, 'card'), spend('2026-09-25', 700, 'card'), spend('2026-10-05', 300, 'upi')];
  const c = B.card(cfg, entries, '2026-10-10');
  assert.equal(c.bill.left, 1000);
  assert.equal(c.bill.due, '2026-10-08');
  assert.equal(c.bill.overdue, true);
  assert.equal(c.bill.lateBy, 2);
  assert.deepEqual([c.cycle.card, c.cycle.upi, c.cycle.total], [700, 300, 1000]);
  assert.equal(c.cycle.due, '2026-11-08');
  assert.equal(c.owed, 2000);
});

test('card: payments clear the bill, then the next due is this cycle', () => {
  const cfg = cfgOf({ startDate: '2026-10-10', startBill: 5000, startCycleCard: 2000, startCycleUpi: 500 });
  const c = B.card(cfg, [pay('2026-10-10', 5000), spend('2026-10-10', 250, 'upi')], '2026-10-10');
  assert.equal(c.bill.left, 0);
  assert.deepEqual([c.cycle.card, c.cycle.upi], [2000, 750]);
  assert.equal(c.owed, 2750);
  assert.deepEqual(c.next, { date: '2026-11-08', amount: 2750, inDays: 29 });
});

test('card: opening cycle spends become the bill once that cycle closes', () => {
  const cfg = cfgOf({ startDate: '2026-10-10', startCycleCard: 2000, startCycleUpi: 500 });
  const c = B.card(cfg, [], '2026-10-20');
  assert.equal(c.bill.left, 2500);
  assert.equal(c.bill.due, '2026-11-08');
  assert.equal(c.cycle.total, 0);
});

test('card: paying more than the bill shows as credit', () => {
  const cfg = cfgOf({ startDate: '2026-10-10', startBill: 1000 });
  const c = B.card(cfg, [pay('2026-10-10', 1500), spend('2026-10-10', 800)], '2026-10-10');
  assert.equal(c.credit, 500);
  assert.equal(c.owed, 300);
});

test('bank balance = salary - bank spends - card bill payments - emergency', () => {
  const cfg = cfgOf({ salary1: 50000, salary2: 30000, emergency: 2000, startDate: '2026-10-10', startMonthSpent: 4000 });
  const entries = [
    spend('2026-10-10', 300, 'bank', '1'), spend('2026-10-10', 200, 'bank', '2'),
    spend('2026-10-10', 900, 'card'), spend('2026-10-10', 100, 'upi'), // on the card: not out of the bank yet
    pay('2026-10-11', 5000),                                            // the bill payment is what leaves the bank
    spend('2026-09-30', 999, 'bank'),
  ];
  const s = B.salary(cfg, entries, '2026-10-11');
  assert.equal(s.total, 80000);
  assert.deepEqual([s.before, s.bank, s.paid, s.onCard], [4000, 500, 5000, 1000]);
  assert.deepEqual([s.byWho[1], s.byWho[2]], [300, 200]);
  assert.equal(s.left, 80000 - 4000 - 500 - 5000 - 2000);
  // The day before the payment it hasn't left the bank yet.
  assert.equal(B.salary(cfg, entries, '2026-10-10').left, 80000 - 4000 - 500 - 2000);
  // November: the pre-app figure no longer counts.
  assert.equal(B.salary(cfg, entries, '2026-11-01').left, 78000);
});

test('merge keeps the newer edit of each entry and setting', () => {
  const local = { entries: { a: { id: 'a', amount: 1, t: 5 }, b: { id: 'b', amount: 2, t: 5 } }, settings: { x: { v: 1, t: 5 } } };
  const changed = B.merge(local, {
    entries: [{ id: 'a', amount: 9, t: 9 }, { id: 'b', amount: 8, t: 1 }, { id: 'c', amount: 3, t: 1 }],
    settings: { x: { v: 2, t: 3 }, y: { v: 7, t: 1 } },
  });
  assert.equal(changed, true);
  assert.deepEqual(Object.values(local.entries).map(e => e.amount), [9, 2, 3]);
  assert.deepEqual([local.settings.x.v, local.settings.y.v], [1, 7]);
  assert.equal(B.merge(local, { entries: [{ id: 'a', amount: 9, t: 9 }] }), false);
});

test('bank payments count for the day and the salary, never the card', () => {
  const data = {
    settings: settings({ 'limit:2026-10': 500, startDate: '2026-10-10', salary1: 1000, emergency: 0 }),
    entries: { a: Object.assign(spend('2026-10-10', 65, 'bank'), { id: 'a' }), b: Object.assign(spend('2026-10-10', 100, 'card'), { id: 'b' }) },
  };
  const r = B.compute(data, '2026-10-10');
  assert.equal(r.daily.left, 335);
  assert.equal(r.salary.left, 935); // only the bank spend; the card spend leaves the bank when the bill is paid
  assert.equal(r.salary.bank, 65);
  assert.deepEqual([r.card.cycle.card, r.card.cycle.upi, r.card.owed], [100, 0, 100]);
});

test('alerts: card due soon, overdue, over today, running short', () => {
  const base = { 'limit:2026-10': 500, emergency: 0, startDate: '2026-10-10' };
  const ids = (obj, entries, day) => { const data = { settings: settings(obj), entries: Object.fromEntries(entries.map(e => [e.id, e])) }; return B.alerts(B.compute(data, day), day).map(a => a.id); };
  // Plenty of salary, nothing due soon: no alerts. (22 days x 500 = 11,000 needed.)
  assert.deepEqual(ids({ ...base, salary1: 11000, startCycleCard: 1000 }, [], '2026-10-10'), []);
  // One rupee short for the month.
  assert.deepEqual(ids({ ...base, salary1: 10999 }, [], '2026-10-10'), ['short']);
  // Over today's limit.
  assert.deepEqual(ids({ ...base, salary1: 99999 }, [spend('2026-10-10', 600)], '2026-10-10'), ['over-today']);
  // Card bill due in 3 days (cycle closed 18 Oct, due 8 Nov).
  assert.deepEqual(ids({ ...base, salary1: 99999, startCycleCard: 1000 }, [], '2026-11-05'), ['card-due']);
  assert.deepEqual(ids({ ...base, salary1: 99999, startCycleCard: 1000 }, [], '2026-11-04'), []);
  // Unpaid after the due date.
  assert.deepEqual(ids({ ...base, salary1: 99999, startCycleCard: 1000 }, [], '2026-11-09'), ['card-overdue']);
});

test('card utilisation against the 30% safe zone', () => {
  const day = '2026-10-10';
  const util = cycle => B.compute({ settings: settings({ startDate: day, cardLimit: 80000, safePct: 30, startCycleCard: cycle, salary1: 99999 }), entries: {} }, day);
  const ok = util(20955);
  assert.deepEqual([ok.card.util.safe, ok.card.util.room, Math.round(ok.card.util.pct)], [24000, 3045, 26]);
  assert.deepEqual(B.alerts(ok, day).map(a => a.id), []);
  const over = util(25000);
  assert.deepEqual(B.alerts(over, day).map(a => [a.id, a.amount]), [['card-util', 1000]]);
  // No limit set: nothing to track.
  assert.equal(B.compute({ settings: settings({ startDate: day, startCycleCard: 99999, salary1: 999999 }), entries: {} }, day).card.util.room < 0, true);
  assert.deepEqual(B.alerts(B.compute({ settings: settings({ startDate: day, startCycleCard: 99999, salary1: 999999 }), entries: {} }, day), day).map(a => a.id), []);
});
