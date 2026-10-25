const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../budget.js');

let seq = 0;
const spend = (date, amount, method = 'card', who = '1') => ({ id: 'e' + ++seq, type: 'spend', date, amount, method, who, t: 1 });
const pay = (date, amount) => ({ id: 'p' + ++seq, type: 'pay', date, amount, t: 1 });
const settings = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { v, t: 1 }]));
const cfgOf = obj => B.configFrom(settings(obj));

// Aldrin's numbers on 16 Oct 2026: 9,328 in the bank, 2,000 kept for emergencies, 16 days left.
const R = { salary1: 47400, salary2: 26300, emergency: 2000, startDate: '2026-10-16', startMonthSpent: 64372, startCycleCard: 11788, startCycleUpi: 9884 };
const run = (entries, day, extra) => B.compute({ settings: settings(Object.assign({}, R, extra)), entries: Object.fromEntries(entries.map(e => [e.id, e])) }, day);

test('daily limit = money left ÷ days left', () => {
  const d = run([], '2026-10-16').daily;
  assert.deepEqual([d.pool, d.daysLeft, d.limit, d.left], [7328, 16, 458, 458]);
});

test("the daily limit is fixed for the month; leftovers and overspends land on tomorrow", () => {
  const d = run([spend('2026-10-16', 300, 'bank')], '2026-10-16').daily;
  assert.equal(d.left, 158);
  // ₹158 unspent today: tomorrow is ₹458 + ₹158.
  assert.deepEqual([d.tomorrow.limit, d.tomorrow.carry, d.tomorrow.available], [458, 158, 616]);
  // Nothing spent on the 16th: the 17th is ₹458 + ₹458.
  assert.deepEqual(['limit', 'carry', 'available'].map(k => run([], '2026-10-17').daily[k]), [458, 458, 916]);
  // ₹1,042 over on the 16th: the 17th is ₹458 − ₹1,042.
  assert.deepEqual(['carry', 'available'].map(k => run([spend('2026-10-16', 1500, 'bank')], '2026-10-17').daily[k]), [-1042, -584]);
  // The last day holds whatever is left, so the month ends at ₹0.
  assert.equal(run([], '2026-10-31').daily.available, 7328);
  // A new month starts clean at its own limit.
  assert.deepEqual(['limit', 'carry', 'available'].map(k => run([spend('2026-10-20', 9000, 'bank')], '2026-11-01').daily[k]), [run([spend('2026-10-20', 9000, 'bank')], '2026-11-01').daily.limit, 0, run([spend('2026-10-20', 9000, 'bank')], '2026-11-01').daily.limit]);
});

test('a card or UPI spend lowers the money left just like a bank spend', () => {
  for (const method of ['card', 'upi', 'bank']) {
    assert.equal(run([spend('2026-10-16', 300, method)], '2026-10-17').daily.pool, 7028, method);
  }
  // …but only the bank spend has left the bank so far.
  assert.equal(run([spend('2026-10-16', 300, 'card')], '2026-10-17').salary.left, 7328);
});

test('paying off a card spend does not lower the money left a second time', () => {
  const spendOnly = run([spend('2026-10-17', 300, 'card')], '2026-10-18').daily.pool;
  const spendAndPay = run([spend('2026-10-17', 300, 'card'), pay('2026-10-17', 21672), pay('2026-10-17', 300)], '2026-10-18').daily.pool;
  // The 21,672 bill from before the app is real money leaving the bank; the extra 300 just settles the new spend.
  assert.equal(spendOnly, 7028);
  assert.equal(spendAndPay, 7028 - 21672);
});

test('history shows each day: spent of that day\'s amount (limit + carry)', () => {
  const d = run([spend('2026-10-16', 300, 'bank'), spend('2026-10-17', 100, 'card')], '2026-10-18').daily;
  assert.deepEqual(d.history.map(h => [h.date, h.limit, h.available, h.spent]), [
    ['2026-10-18', 458, 974, 0], ['2026-10-17', 458, 616, 100], ['2026-10-16', 458, 458, 300],
  ]);
});

test('November: October’s leftover + salary − fixed costs − emergency − unpaid card debt, ÷ days', () => {
  const nov = { 'emergency:2026-11': 5000, fixed: [{ name: 'Hostel', amount: 14000 }, { name: 'Bike EMI', amount: 7280 }, { name: 'Wifi', amount: 489 }] };
  // Nothing spent in October: 9,328 carried + 73,700 − 21,769 = 61,259 in the bank;
  // minus 5,000 emergency and the 21,672 card bill still unpaid = 34,587 over 30 days.
  const d = run([], '2026-11-01', nov).daily;
  assert.deepEqual([d.pool, d.daysLeft, d.limit], [34587, 30, 1152]);
  // Paying the card bill doesn't change it (it was already kept aside) …
  assert.equal(run([pay('2026-11-05', 21672)], '2026-11-06', nov).daily.pool, 34587);
  // … but it does leave the bank.
  assert.equal(run([], '2026-11-06', nov).salary.left, 61259 - 5000);
  assert.equal(run([pay('2026-11-05', 21672)], '2026-11-06', nov).salary.left, 61259 - 5000 - 21672);
  // A card spend in November lowers it right away, and paying that off later doesn't again.
  assert.equal(run([spend('2026-11-02', 400, 'card')], '2026-11-03', nov).daily.pool, 34587 - 400);
  assert.equal(run([spend('2026-11-02', 400, 'card'), pay('2026-11-02', 22072)], '2026-11-03', nov).daily.pool, 34587 - 400);
  // Spend October's daily limits from the bank and only the emergency fund carries: 2,000 + 73,700 − 21,769.
  assert.equal(run([spend('2026-10-20', 7328, 'bank')], '2026-11-01', nov).salary.opening, 2000 + 73700 - 21769);
  // Spend it on the card instead: the bank keeps it, but the card debt kept aside grows by the same amount.
  assert.equal(run([spend('2026-10-20', 7328, 'card')], '2026-11-01', nov).daily.pool, 34587 - 7328);
  // Overspend October and November starts smaller.
  assert.equal(run([spend('2026-10-20', 10000, 'bank')], '2026-11-01', nov).salary.carried, 9328 - 10000);
  // It keeps rolling: December gets what November left in the bank (nothing logged, so all of it).
  assert.equal(run([], '2026-12-01', nov).salary.carried, 61259);
  // October still runs on its own numbers (₹2,000 emergency, no fixed costs).
  assert.equal(run([], '2026-10-16', nov).daily.pool, 7328);
  assert.equal(run([], '2026-10-31', nov).daily.tomorrow.fresh, true);
});

test('changing a salary moves the next month, not the start month', () => {
  const extra = { salary1: 50000, startBank: 9328 };
  assert.equal(run([], '2026-10-16', extra).daily.pool, 7328);
  assert.equal(run([], '2026-11-01', extra).salary.left, 9328 + 50000 + 26300 - 2000);
});

test('emergency fund per month: a month without one uses the latest earlier one', () => {
  const cfg = cfgOf({ emergency: 2000, 'emergency:2026-11': 5000 });
  assert.deepEqual(['2026-10', '2026-11', '2027-01'].map(mk => B.emergencyFor(cfg, mk)), [2000, 5000, 5000]);
});

test('deleted and future-dated spends are ignored', () => {
  const data = {
    settings: settings({ startDate: '2026-10-10', salary1: 22000, emergency: 0 }),
    entries: { a: Object.assign(spend('2026-10-10', 200), { id: 'a', deleted: true }), b: Object.assign(spend('2026-10-11', 50), { id: 'b' }) },
  };
  assert.equal(B.compute(data, '2026-10-10').daily.left, 1000); // 22,000 ÷ 22 days, untouched
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

test('bank balance = opening balance − bank spends − card bill payments − emergency', () => {
  const cfg = cfgOf({ salary1: 50000, salary2: 30000, emergency: 2000, startDate: '2026-10-10', startMonthSpent: 4000 });
  const entries = [
    spend('2026-10-10', 300, 'bank', '1'), spend('2026-10-10', 200, 'bank', '2'),
    spend('2026-10-10', 900, 'card'), spend('2026-10-10', 100, 'upi'), // on the card: not out of the bank yet
    pay('2026-10-11', 5000),                                            // the bill payment is what leaves the bank
    spend('2026-09-30', 999, 'bank'),
  ];
  const s = B.salary(cfg, entries, '2026-10-11');
  assert.deepEqual([s.total, s.opening, s.bank, s.paid, s.onCard], [80000, 76000, 500, 5000, 1000]);
  assert.deepEqual([s.byWho[1], s.byWho[2]], [300, 200]);
  assert.equal(s.left, 76000 - 500 - 5000 - 2000);
  assert.equal(B.salary(cfg, entries, '2026-10-10').left, 76000 - 500 - 2000);
  // The start day's bank balance, when given, is used as is.
  assert.equal(B.salary(cfgOf({ salary1: 1, startDate: '2026-10-10', startBank: 9328, emergency: 2000 }), [], '2026-10-10').left, 7328);
  // November: October's leftover (76,000 − 500 − 5,000) carries over, plus the salary.
  assert.equal(B.salary(cfg, entries, '2026-11-01').left, 70500 + 80000 - 2000);
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
    settings: settings({ startDate: '2026-10-22', salary1: 1000, emergency: 0 }),
    entries: { a: Object.assign(spend('2026-10-22', 65, 'bank'), { id: 'a' }), b: Object.assign(spend('2026-10-22', 100, 'card'), { id: 'b' }) },
  };
  const r = B.compute(data, '2026-10-22');
  assert.equal(r.daily.left, 100 - 165); // 1,000 ÷ 10 days left
  assert.equal(r.salary.left, 935); // only the bank spend; the card spend leaves the bank when the bill is paid
  assert.equal(r.salary.bank, 65);
  assert.deepEqual([r.card.cycle.card, r.card.cycle.upi, r.card.owed], [100, 0, 100]);
});

test('alerts: card due soon, overdue, over today, no money left', () => {
  const base = { emergency: 0, startDate: '2026-10-16' };
  const ids = (obj, entries, day) => { const data = { settings: settings(obj), entries: Object.fromEntries(entries.map(e => [e.id, e])) }; return B.alerts(B.compute(data, day), day).map(a => a.id); };
  assert.deepEqual(ids({ ...base, salary1: 8000, startCycleCard: 1000 }, [], '2026-10-16'), []);
  // Over today's limit (8,000 ÷ 16 = 500).
  assert.deepEqual(ids({ ...base, salary1: 8000 }, [spend('2026-10-16', 600)], '2026-10-16'), ['over-today']);
  // The month's money is gone.
  // The month's money is gone. Nothing was spent on the 17th itself, so only "money used up" shows.
  assert.deepEqual(ids({ ...base, salary1: 8000 }, [spend('2026-10-16', 8100)], '2026-10-17'), ['short']);
  assert.deepEqual(ids({ ...base, salary1: 8000 }, [spend('2026-10-16', 8100), spend('2026-10-17', 50)], '2026-10-17'), ['over-today', 'short']);
  // Card bill due in 3 days (cycle closed 18 Oct, due 8 Nov), then overdue.
  assert.deepEqual(ids({ ...base, salary1: 99999, startCycleCard: 1000 }, [], '2026-11-05'), ['card-due']);
  assert.deepEqual(ids({ ...base, salary1: 99999, startCycleCard: 1000 }, [], '2026-11-04'), []);
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

test('entries logged before the starting numbers were taken are ignored', () => {
  const at = Date.parse('2026-10-16T12:00:00');
  const data = {
    settings: settings({ startDate: '2026-10-16', startAt: at, startCycleCard: 1000, salary1: 8000, emergency: 0 }),
    entries: {
      old: Object.assign(spend('2026-10-16', 300, 'bank'), { id: 'old', ts: at - 60000 }),
      older: Object.assign(spend('2026-10-12', 999, 'card'), { id: 'older', ts: at - 4 * 86400000 }),
      now: Object.assign(spend('2026-10-16', 50, 'bank'), { id: 'now', ts: at + 60000 }),
    },
  };
  const r = B.compute(data, '2026-10-16');
  assert.equal(r.daily.left, 450); // 8,000 ÷ 16 = 500, minus the 50 logged after the reset
  assert.equal(r.salary.left, 7950);
  assert.equal(r.card.owed, 1000);
});

test("next month's daily limit as it stands: every spend now lowers it, a card payment doesn't", () => {
  const nov = { 'emergency:2026-11': 5000, fixed: [{ name: 'Hostel', amount: 14000 }, { name: 'Bike EMI', amount: 7280 }, { name: 'Wifi', amount: 489 }] };
  const n = run([], '2026-10-16', nov).daily.nextMonth;
  assert.deepEqual([n.month, n.pool, n.daysLeft, n.limit], ['2026-11', 34587, 30, 1152]);
  // Using every remaining October limit leaves only what was kept aside: 34,587 − 7,328.
  assert.deepEqual([n.fullUse.pool, n.fullUse.limit], [27259, 908]);
  // ₹1,000 spent today, on any button, costs November ₹1,000.
  for (const method of ['bank', 'card', 'upi']) {
    assert.equal(run([spend('2026-10-16', 1000, method)], '2026-10-16', nov).daily.nextMonth.pool, 33587, method);
  }
  // Paying the card bill early doesn't touch it.
  assert.equal(run([pay('2026-10-16', 21672)], '2026-10-16', nov).daily.nextMonth.pool, 34587);
  // Sticking to the limits doesn't change the full-use figure; overspending beyond the month's money does.
  assert.equal(run([spend('2026-10-16', 400, 'bank')], '2026-10-16', nov).daily.nextMonth.fullUse.pool, 27259);
  // On the last day only today's leftover is still unspent.
  const last = run([], '2026-10-31', nov).daily;
  assert.equal(last.nextMonth.fullUse.pool, last.nextMonth.pool - last.left);
});
