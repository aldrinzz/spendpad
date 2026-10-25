const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../budget.js');
let seq = 0;
const spend = (date, amount, method = 'card', who = '1') => ({ id: 'e' + ++seq, type: 'spend', date, amount, method, who, t: 1 });
const pay = (date, amount) => ({ id: 'p' + ++seq, type: 'pay', date, amount, t: 1 });
const settings = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { v, t: 1 }]));
const R = { salary1: 47400, salary2: 26300, emergency: 2000, startDate: '2026-10-16', startMonthSpent: 64372, startCycleCard: 11788, startCycleUpi: 9884 };
const NOV = { startBank: 9328, 'emergency:2026-11': 5000, fixed: [{ name: 'Hostel fees', amount: 14000 }, { name: 'Bike EMI', amount: 7280 }, { name: 'Wifi', amount: 489 }] };
const run = (entries, day, extra) => B.compute({ settings: settings(Object.assign({}, R, NOV, extra)), entries: Object.fromEntries(entries.map(e => [e.id, e])) }, day);
const al = (r, d) => B.alerts(r, d).map(a => [a.id, a.amount, a.days]);

test('an unpaid bill stays overdue after the next statement', () => {
  for (const [day, late] of [['2026-11-19', 11], ['2026-12-09', 31], ['2026-12-19', 41], ['2027-01-09', 62]]) {
    const r = run([], day), b = r.card.bill;
    assert.deepEqual([b.overdue, b.overdueAmount, b.overdueSince, b.lateBy], [true, 21672, '2026-11-08', late], day);
    assert.deepEqual(al(r, day)[0], ['card-overdue', 21672, late], day);
  }
  assert.equal(run([pay('2026-11-05', 10000)], '2026-11-19').card.bill.overdueAmount, 11672);
  assert.equal(run([pay('2026-11-20', 21672)], '2026-11-21').card.bill.overdue, false);
  const E = [spend('2026-11-10', 2000)];
  assert.deepEqual(al(run(E, '2026-12-06'), '2026-12-06'), [['card-overdue', 21672, 28], ['card-due', 2000, 2]]);
  assert.deepEqual(al(run(E, '2026-12-09'), '2026-12-09'), [['card-overdue', 23672, 31]]);
  assert.equal(run([], '2026-11-19').daily.pool, 34587); // money maths untouched
  assert.equal(run([pay('2026-11-07', 21672), spend('2026-11-02', 5000)], '2026-11-19').card.bill.overdue, false);
});

test('a credit on the card (paid more than owed) counts as money, so paying never moves the limits', () => {
  for (const amt of [21672, 22000, 25000]) {
    const d = run([pay('2026-11-05', amt)], '2026-11-06').daily;
    assert.deepEqual([d.pool, d.limit, d.nextMonth.pool, d.nextMonth.limit], [34587, 1152, 86518, 2790], String(amt));
  }
  assert.equal(run([pay('2026-11-05', 25000)], '2026-12-01').daily.pool, 86518);
  assert.equal(run([pay('2026-11-05', 25000), spend('2026-12-02', 3328)], '2026-12-03').daily.pool, 83190);
  assert.equal(run([pay('2026-11-05', 25000), spend('2026-11-06', 1000)], '2026-11-07').daily.pool, 33587);
  assert.equal(run([pay('2026-10-20', 25000)], '2026-10-20').daily.nextMonth.pool, 34587);
  assert.equal(run([pay('2026-10-20', 25000)], '2026-10-21').daily.pool, -14344); // same as paying exactly 21,672
  assert.equal(run([pay('2026-11-05', 25000)], '2027-01-01').daily.pool, 138449);
});

test('a salary or fixed-cost change only moves the month it starts in', () => {
  const E = [pay('2026-11-05', 21672)];
  const dec = run(E, '2026-12-15', { 'salary1:2026-12': 50000 }).salary;
  assert.deepEqual([dec.carried, dec.opening, dec.s1], [39587, 94118, 50000]);
  assert.equal(run(E, '2026-12-15', { 'salary1:2026-12': 50000 }).daily.limit, 2874); // 89,118 ÷ 31
  assert.equal(run(E, '2027-01-15', { 'salary1:2026-12': 50000 }).salary.carried, 94118);
  const noEmi = [{ name: 'Hostel fees', amount: 14000 }, { name: 'Wifi', amount: 489 }];
  const jan = run(E, '2027-01-15', { 'fixed:2027-01': noEmi }).salary;
  assert.deepEqual([jan.carried, jan.opening, jan.fixed], [91518, 150729, 14489]);
  assert.equal(run(E, '2027-02-15', { 'salary2:2027-02': 0 }).salary.opening, 169080);
  assert.equal(run(E, '2026-11-15', { 'salary1:2026-12': 50000 }).daily.limit, 1152); // November untouched
  assert.equal(run(E, '2026-11-15', { 'salary1:2026-12': 50000 }).daily.nextMonth.pool, 89118);
  const oct = run([], '2026-10-16', { 'salary1:2026-11': 50000 }).daily;
  assert.deepEqual([oct.pool, oct.limit, oct.nextMonth.pool], [7328, 458, 37187]);
  assert.equal(run(E, '2026-12-15').salary.opening, 91518); // no keys: same as today
});

test("the 'money used up' alert counts today's spends and the last day", () => {
  const ids = (E, d) => B.alerts(run(E, d), d).filter(a => a.id === 'short').map(a => a.amount);
  assert.deepEqual(ids([spend('2026-10-20', 8000, 'bank')], '2026-10-20'), [672]);
  assert.deepEqual(ids([spend('2026-10-31', 9000)], '2026-10-31'), [1672]);
  assert.deepEqual(ids([spend('2026-10-31', 7328, 'upi')], '2026-10-31'), []); // month ends at exactly 0: fine
  assert.deepEqual(ids([spend('2026-10-20', 7328, 'bank')], '2026-10-20'), [0]); // gone with 11 days to go
  assert.deepEqual(ids([pay('2026-10-25', 8000)], '2026-10-25'), [672]);
  assert.deepEqual(ids([pay('2026-11-05', 21672)], '2026-11-05'), []);
});

test('lists and numbers use the same entries', () => {
  const at = Date.parse('2026-10-16T20:49:25+05:30');
  const data = { settings: settings(Object.assign({}, R, NOV, { startAt: at })), entries: {
    old: { id: 'old', type: 'spend', date: '2026-10-16', amount: 450, method: 'upi', who: '2', ts: at - 3 * 3600e3, t: 1 },
    op: { id: 'op', type: 'pay', date: '2026-10-12', amount: 5000, ts: at - 8 * 86400e3, t: 1 },
    n: { id: 'n', type: 'spend', date: '2026-10-16', amount: 120, method: 'bank', who: '1', ts: at + 3600e3, t: 1 } } };
  assert.deepEqual(B.liveEntries(data).map(e => e.id), ['n']);
  const r = B.compute(data, '2026-10-20');
  assert.deepEqual(r.entries.map(e => e.id), ['n']);
  assert.equal(r.daily.history.find(h => h.date === '2026-10-16').spent, 120);
  assert.equal(r.card.paid, 0);
});

test('paying ahead inside a cycle: the cycle bill shows what is still due', () => {
  const c = run([pay('2026-11-05', 21672), spend('2026-11-10', 5000), pay('2026-11-15', 3000)], '2026-11-16').card;
  assert.deepEqual([c.cycle.total, c.cycle.paidAhead, c.cycle.net, c.owed, c.next.amount], [5000, 3000, 2000, 2000, 2000]);
});

test('changing the statement day keeps the bill already made', () => {
  const k = { 'statementDay:2026-10-20': 15 };
  const r = run([], '2026-11-07', k);
  assert.deepEqual([r.card.bill.left, r.card.next.date, r.card.next.amount], [21672, '2026-11-08', 21672]);
  assert.deepEqual(B.alerts(r, '2026-11-07').map(a => a.id), ['card-due']);
  assert.deepEqual(B.alerts(run([], '2026-11-09', k), '2026-11-09').map(a => a.id), ['card-overdue']);
  assert.deepEqual(run([], '2026-10-20', k).card.cycle, Object.assign(run([], '2026-10-20', k).card.cycle, { start: '2026-10-19', end: '2026-11-14' }));
  const c = run([pay('2026-11-05', 21672), spend('2026-11-10', 1000)], '2026-11-16', k).card;
  assert.deepEqual([c.bill.left, c.bill.due, c.cycle.start, c.cycle.end], [1000, '2026-12-08', '2026-11-15', '2026-12-14']);
  assert.equal(run([], '2026-10-20', k).daily.limit, 458);
});

test('next month breakdown adds up', () => {
  const r = run([], '2026-10-20');
  const s = B.salary(r.cfg, r.entries, '2026-11-01'), debt = B.card(r.cfg, r.entries, '2026-10-31').owed;
  assert.deepEqual([s.carried, s.total, s.fixed, s.emergency, debt], [9328, 73700, 21769, 5000, 21672]);
  assert.equal(s.carried + s.total - s.fixed - s.emergency - debt, r.daily.nextMonth.pool);
});

test('typed amounts keep rupees and drop paise', () => {
  assert.deepEqual(['21672.33', '₹21,672.33', '1084.00', '489.50', '21,672', '1.2.3', '', '.'].map(B.parseMoney), [21672, 21672, 1084, 490, 21672, null, null, null]);
  const d = run([pay('2026-11-05', B.parseMoney('21672.33'))], '2026-11-06');
  assert.deepEqual([d.daily.pool, d.daily.limit, d.card.owed], [34587, 1152, 0]);
});

test("'over today' only on a day something was spent", () => {
  // Paying the old bill in October pushes the limit below zero with nothing spent: only "money used up".
  const ids = (E, d) => B.alerts(run(E, d), d).map(a => a.id);
  assert.deepEqual(ids([pay('2026-10-20', 21672)], '2026-10-21'), ['short']);
  assert.deepEqual(ids([pay('2026-10-20', 21672), spend('2026-10-21', 10, 'bank')], '2026-10-21'), ['over-today', 'short']);
});

test('card adjustments: fees add to the card and the month, refunds take off; never today\'s spending', () => {
  const adj = (date, amount) => ({ id: 'a' + ++seq, type: 'adj', date, amount, t: 1 });
  const base = run([], '2026-11-10');
  const fee = run([adj('2026-11-10', 500)], '2026-11-10');
  assert.equal(fee.card.owed, base.card.owed + 500);
  assert.equal(fee.daily.spent, 0);                       // not counted as today's spending
  assert.equal(fee.daily.left, base.daily.left);           // today's limit was set this morning
  assert.equal(run([adj('2026-11-10', 500)], '2026-11-11').daily.pool, run([], '2026-11-11').daily.pool - 500);
  assert.equal(fee.salary.left, base.salary.left);         // nothing left the bank
  const refund = run([adj('2026-11-10', -3000)], '2026-11-11');
  assert.equal(refund.daily.pool, run([], '2026-11-11').daily.pool + 3000);
  assert.equal(refund.card.owed, base.card.owed - 3000);
  // A fee charged before the statement becomes part of that bill.
  assert.equal(run([adj('2026-11-15', 500)], '2026-11-20').card.bill.left, 21672 + 500);
});

test('a fixed cost paid by card goes on the card each month instead of leaving the bank', () => {
  const viaCard = { fixed: [{ name: 'Hostel fees', amount: 14000 }, { name: 'Bike EMI', amount: 7280 }, { name: 'Wifi', amount: 489, via: 'card' }] };
  const bank = run([], '2026-11-01'), card = run([], '2026-11-01', viaCard);
  // Same money for the month either way: it's kept aside as card debt instead.
  assert.equal(card.daily.pool, bank.daily.pool);
  assert.equal(card.salary.left, bank.salary.left + 489);  // still in the bank until the card bill is paid
  assert.equal(card.card.owed, bank.card.owed + 489);
  assert.equal(card.card.cycle.other, 489);
  // Paying the card bill (which now includes it) doesn't move the limit.
  assert.equal(run([pay('2026-11-05', 21672 + 489)], '2026-11-06', viaCard).daily.pool, run([], '2026-11-06', viaCard).daily.pool);
  // Next month as it stands counts it too, and the parts add up.
  const n = run([], '2026-10-20', viaCard).daily.nextMonth, p = n.parts;
  assert.equal(n.pool, bank.daily.pool);
  assert.equal(p.carried + p.salary - p.fixed - p.fixedCard - p.emergency - p.cardDebt, n.pool);
  assert.deepEqual([p.fixed, p.fixedCard], [21280, 489]);
  // October (the start month) has no fixed costs at all.
  assert.equal(run([], '2026-10-20', viaCard).card.owed, run([], '2026-10-20').card.owed);
});

test('a later statement-day correction wins over an earlier change that had not started yet', () => {
  const both = { 'statementDay:2026-11-01': 25, 'statementDay:2026-11-20': 21 }, only = { 'statementDay:2026-11-20': 21 };
  for (const d of ['2026-11-26', '2026-12-22', '2027-01-22']) assert.deepEqual(run([], d, both).card.cycle.start, run([], d, only).card.cycle.start, d);
  assert.equal(run([], '2026-11-26', both).card.cycle.start, '2026-11-21');
});

test('refunds clear overdue bills, and nothing is overdue while the card is in credit', () => {
  const adj = (date, amount) => ({ id: 'r' + ++seq, type: 'adj', date, amount, t: 1 });
  assert.equal(run([adj('2026-10-25', -5000)], '2026-11-25').card.bill.overdueAmount, 16672);
  assert.equal(run([adj('2026-11-20', -5000)], '2026-11-25').card.bill.overdueAmount, 16672);
  for (const date of ['2026-10-25', '2026-11-20']) {
    const r = run([adj(date, -25000)], '2026-11-25');
    assert.equal(r.card.bill.overdue, false, date);
    assert.deepEqual(B.alerts(r, '2026-11-25').filter(a => a.id === 'card-overdue'), [], date);
  }
});

test('typing no digits is not an amount', () => {
  assert.deepEqual(['-', 'abc', '₹', ',', '-500'].map(B.parseMoney), [null, null, null, null, 500]);
});
