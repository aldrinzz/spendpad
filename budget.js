/* LavishTracker budget maths: pure functions, no DOM.
   Loaded by the app (as window.Budget) and by the node tests (via require). */
(function (root) {
  'use strict';

  // ---------- calendar days ----------
  // Days are local 'YYYY-MM-DD' strings, so they compare and sort as plain text.
  const pad = n => String(n).padStart(2, '0');
  const ymd = (y, m, d) => y + '-' + pad(m) + '-' + pad(d); // m is 1-12
  const parts = s => s.split('-').map(Number);
  const toUTC = s => { const [y, m, d] = parts(s); return Date.UTC(y, m - 1, d); };
  const fromUTC = ms => { const d = new Date(ms); return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); };

  function today(now) {
    const d = now || new Date();
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  const addDays = (s, n) => fromUTC(toUTC(s) + n * 86400000);
  const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
  const monthOf = s => s.slice(0, 7);
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  // A day of the month, clamped to the month's length (the 31st of a 30-day month is the 30th).
  function dayIn(y, m, day) {
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return ymd(y, m, Math.min(day, daysInMonth(y, m)));
  }
  const shiftMonth = (mk, n) => { const [y, m] = parts(mk); return dayIn(y, m + n, 1).slice(0, 7); };

  // ---------- settings ----------
  const DEFAULTS = {
    name1: 'Me', name2: 'Friend', salary1: 0, salary2: 0,
    emergency: 2000, statementDay: 19, dueDay: 8, cardLimit: 0, safePct: 30,
    fixed: [], // monthly fixed costs, [{ name, amount }], taken off on the 1st of every month after the start month
    // Where things stood when the app was first used. startBank (the bank balance that day) wins over startMonthSpent.
    startDate: null, startAt: 0, startBank: null, startMonthSpent: 0, startCycleCard: 0, startCycleUpi: 0, startBill: 0,
  };

  // settings is { key: { v, t } } as stored and synced; this flattens it to plain values.
  function configFrom(settings) {
    const v = k => { const s = settings[k]; return s && s.v != null && s.v !== '' ? s.v : DEFAULTS[k]; };
    // 'emergency:2026-11' sets one month's emergency fund; months without one use the latest earlier one.
    const emergencies = {};
    for (const k in settings) if (k.startsWith('emergency:') && settings[k].v != null && settings[k].v !== '') emergencies[k.slice(10)] = +settings[k].v;
    const cleanFixed = list => (Array.isArray(list) ? list : []).filter(f => f && typeof f === 'object').map(f => ({ name: String(f.name || ''), amount: Math.max(0, +f.amount || 0), via: f.via === 'card' ? 'card' : 'bank' }));
    const fixed = cleanFixed(v('fixed'));
    // 'salary1:2027-02', 'salary2:2027-02', 'fixed:2027-02' set the value from that month on.
    const byMonth = { salary1: {}, salary2: {}, fixed: {} };
    for (const k in settings) {
      const m = /^(salary1|salary2|fixed):(\d{4}-\d{2})$/.exec(k);
      if (!m || settings[k].v == null || settings[k].v === '') continue;
      byMonth[m[1]][m[2]] = m[1] === 'fixed' ? cleanFixed(settings[k].v) : +settings[k].v;
    }
    // 'statementDay:2026-10-20' = 15: the bank moved the statement day on that date; statements already made keep theirs.
    const statementChanges = Object.keys(settings).filter(k => /^statementDay:\d{4}-\d{2}-\d{2}$/.test(k) && settings[k].v != null && settings[k].v !== '')
      .sort().map(k => ({ at: k.slice(13), day: +settings[k].v }));
    // { from: 'YYYY-MM', amount }: the emergency fund grows by `amount` every month from `from`.
    // { from: 'YYYY-MM', amount }: the daily limit is capped at `amount` from `from`; whatever a month
    // has beyond that goes into the emergency fund and stays there.
    const c = v('dailyCap');
    const dailyCap = c && typeof c === 'object' && /^\d{4}-\d{2}$/.test(c.from) && +c.amount > 0 ? { from: c.from, amount: +c.amount } : null;
    const g = v('emergencyGrowth');
    const emergencyGrowth = g && typeof g === 'object' && /^\d{4}-\d{2}$/.test(g.from) ? { from: g.from, amount: Math.max(0, +g.amount || 0) } : { from: '9999-12', amount: 0 };
    return {
      emergencies, fixed, byMonth, statementChanges, emergencyGrowth, dailyCap,
      name1: v('name1'), name2: v('name2'), salary1: +v('salary1'), salary2: +v('salary2'),
      emergency: +v('emergency'),
      statementDay: +v('statementDay'), dueDay: +v('dueDay'), cardLimit: +v('cardLimit'), safePct: +v('safePct'),
      start: {
        date: v('startDate'), at: +v('startAt'), bank: v('startBank') == null ? null : +v('startBank'), monthSpent: +v('startMonthSpent'),
        cycleCard: +v('startCycleCard'), cycleUpi: +v('startCycleUpi'), bill: +v('startBill'),
      },
    };
  }

  // ---------- daily limit ----------
  // Each morning: money left this month ÷ days left (today included). Spend less and every
  // remaining day rises a little; spend more and they all drop. The month always ends at ₹0.
  //
  // Money left = bank balance (salary − Bank spends − card bills paid − emergency fund)
  //            − Card/UPI spends that haven't been paid off yet,
  // so a card spend lowers it straight away and the bill payment doesn't lower it again.
  // Payments go first towards the card debt that existed when the month (or the app) started.
  const latestFor = (map, mk, base) => {
    if (map[mk] != null) return map[mk];
    const earlier = Object.keys(map).filter(k => k < mk).sort().pop();
    return earlier ? map[earlier] : base;
  };
  const salaryFor = (cfg, mk, who) => latestFor((cfg.byMonth || {})['salary' + who] || {}, mk, cfg['salary' + who]);
  const fixedFor = (cfg, mk) => latestFor((cfg.byMonth || {}).fixed || {}, mk, cfg.fixed);
  // The emergency fund for a month: the latest amount set for it or an earlier month, plus the monthly
  // growth for every month after that one (from the growth's start). Set 0 growth to keep it flat.
  function emergencyFor(cfg, mk) {
    const set = cfg.emergencies[mk] != null ? mk : Object.keys(cfg.emergencies).filter(k => k < mk).sort().pop();
    let amount = set ? cfg.emergencies[set] : cfg.emergency;
    const g = cfg.emergencyGrowth || { amount: 0 };
    if (g.amount) for (let m = set ? shiftMonth(set, 1) : g.from; m <= mk; m = shiftMonth(m, 1)) if (m >= g.from) amount += g.amount;
    return amount;
  }

  // How a month opens. The start month opens on the bank balance Aldrin gave. Every later month opens on
  // whatever was left in the bank at the end of the month before (emergency fund included, since it never
  // left), plus both salaries, minus the fixed costs; it then keeps aside its own emergency fund and the
  // card debt that's still unpaid.
  let memo = null;
  function monthOpen(cfg, entries, mk) {
    if (memo && memo.cfg === cfg && memo.entries === entries && memo.map.has(mk)) return memo.map.get(mk);
    const r = monthOpenRaw(cfg, entries, mk);
    if (memo && memo.cfg === cfg && memo.entries === entries) memo.map.set(mk, r);
    return r;
  }
  function monthOpenRaw(cfg, entries, mk) {
    const st = cfg.start;
    const inStart = !!st.date && monthOf(st.date) === mk;
    const s1 = salaryFor(cfg, mk, 1), s2 = salaryFor(cfg, mk, 2), fixedList = fixedFor(cfg, mk);
    const salary = s1 + s2;
    const fixed = inStart ? 0 : fixedList.filter(f => f.via !== 'card').reduce((n, f) => n + f.amount, 0);
    const fixedCard = inStart ? 0 : fixedList.filter(f => f.via === 'card').reduce((n, f) => n + f.amount, 0);
    const from = inStart ? st.date : mk + '-01';
    let carried = 0, savedBefore = 0;
    if (!inStart && st.date && monthOf(st.date) < mk) {
      const prev = monthOpen(cfg, entries, shiftMonth(mk, -1));
      const t = monthTotals(entries, prev.from, from);
      carried = prev.opening - t.bankOut - t.paid;
      savedBefore = prev.savedTotal;
    }
    const opening = inStart ? (st.bank != null ? st.bank : salary - st.monthSpent) : carried + salary - fixed;
    const debtBefore = inStart ? st.bill + st.cycleCard + st.cycleUpi : card(cfg, entries, addDays(from, -1)).owed; // signed: negative = paid ahead
    // The emergency fund: its planned amount, plus every earlier month's extra savings (still in the bank).
    const planned = emergencyFor(cfg, mk) + savedBefore;
    // With a daily cap, this month's money beyond cap × days is saved into the fund too.
    let saved = 0;
    if (!inStart && cfg.dailyCap && mk >= cfg.dailyCap.from) {
      const money = opening - planned - debtBefore - fixedCard; // the month's money on its 1st
      saved = Math.max(0, money - cfg.dailyCap.amount * daysLeftIn(from));
    }
    return {
      inStart, from, salary, s1, s2, fixedList, fixed, fixedCard, carried, opening, debtBefore,
      emergency: planned + saved, emergencyPlanned: emergencyFor(cfg, mk), savedBefore, saved, savedTotal: savedBefore + saved,
    };
  }

  // Anything that changes what's owed on the card: Card/UPI spends and card adjustments
  // ('adj': + interest or fees, − refunds or cashback). Adjustments aren't spending, so they
  // never count against a day's limit, but they do change the card debt and so the month's money.
  const isCardCharge = e => (e.type === 'spend' && e.method !== 'bank') || e.type === 'adj';

  // Fixed costs marked 'paid by card' are charged to the card on the 1st of every month after the start month.
  function fixedCardCharges(cfg, upTo) {
    const st = cfg.start, out = [];
    if (!st.date) return out;
    for (let mk = shiftMonth(monthOf(st.date), 1); mk <= monthOf(upTo); mk = shiftMonth(mk, 1)) {
      const amount = fixedFor(cfg, mk).filter(f => f.via === 'card').reduce((n, f) => n + f.amount, 0);
      if (amount) out.push({ date: mk + '-01', amount });
    }
    return out;
  }

  // Totals for the month from its first tracked day up to (but not including) `until`.
  function monthTotals(entries, from, until) {
    const t = { bankOut: 0, paid: 0, onCard: 0, byWho: { 1: 0, 2: 0 } };
    for (const e of entries) {
      if (e.date < from || e.date >= until) continue;
      if (e.type === 'pay') t.paid += e.amount;
      else if (e.type === 'spend' && e.method === 'bank') { t.bankOut += e.amount; t.byWho[e.who] = (t.byWho[e.who] || 0) + e.amount; }
      else if (isCardCharge(e)) t.onCard += e.amount;
    }
    return t;
  }

  // Money left at the start of day d = bank balance − card debt that's being kept aside.
  // In the start month only new card spends are kept aside (payments go to the old bill first),
  // which matches how Aldrin worked out the first ₹458. From the next month all unpaid card debt is.
  function moneyLeft(cfg, entries, d, mk) {
    const o = monthOpen(cfg, entries, mk || monthOf(d));
    const t = monthTotals(entries, o.from, d);
    const bank = o.opening - o.emergency - t.bankOut - t.paid;
    const unpaid = o.inStart
      ? t.onCard - Math.max(0, t.paid - o.debtBefore)
      : o.debtBefore + o.fixedCard + t.onCard - t.paid;
    return bank - unpaid;
  }

  function daysLeftIn(d) {
    const [y, m] = parts(d);
    return daysBetween(d, ymd(y, m, daysInMonth(y, m))) + 1;
  }

  function limitOn(cfg, entries, d) {
    const pool = moneyLeft(cfg, entries, d), daysLeft = daysLeftIn(d);
    return { pool, daysLeft, limit: Math.floor(pool / daysLeft) };
  }

  // The daily limit is fixed for the month: the month's money ÷ its days, set on its first day.
  // Each day gets that limit plus whatever earlier days left (or minus what they overspent), so
  // ₹200 over today shows tomorrow as "limit − ₹200". Anything else that changes the month's money
  // (fees, refunds, a salary edit) lands in the same running carry. Day = money left − the limit
  // kept for every later day, so the month still ends at exactly ₹0.
  function monthBase(cfg, entries, mk, from) {
    return moneyLeft(cfg, entries, from, mk) / daysLeftIn(from);
  }
  function dayFigures(cfg, entries, d, base) {
    const pool = moneyLeft(cfg, entries, d), daysLeft = daysLeftIn(d);
    const available = Math.floor(pool - base * (daysLeft - 1) + 1e-9);
    const limit = Math.floor(base + 1e-9);
    return { pool, daysLeft, limit, available, carry: available - limit };
  }

  function daily(cfg, entries, day) {
    const mk = monthOf(day), st = cfg.start;
    let from = st.date && monthOf(st.date) === mk ? st.date : mk + '-01';
    if (from > day) from = day;
    const base = monthBase(cfg, entries, mk, from);
    const spentOn = {};
    for (const e of entries) {
      if (e.type === 'spend' && e.date >= from && e.date <= day) spentOn[e.date] = (spentOn[e.date] || 0) + e.amount;
    }
    const history = [];
    for (let d = from; d <= day; d = addDays(d, 1)) {
      const f = dayFigures(cfg, entries, d, base), spent = spentOn[d] || 0;
      history.push(Object.assign(f, { date: d, spent, left: f.available - spent }));
    }
    const now = history[history.length - 1];
    const next = addDays(day, 1);
    const fresh = monthOf(next) !== mk;
    const t = dayFigures(cfg, entries, next, fresh ? monthBase(cfg, entries, monthOf(next), next) : base);
    const tomorrow = Object.assign({ date: next, fresh }, t);
    // Next month's daily limit as things stand: if nothing more is spent this month, everything left
    // carries over. Every spend lowers it right away; card bill payments don't (that debt is already kept aside).
    const nm = shiftMonth(mk, 1), n = limitOn(cfg, entries, nm + '-01');
    // And if every remaining day's limit gets used, what's still unspent this month won't carry over.
    const unspent = Math.max(0, fresh ? now.left : t.pool);
    const no = monthOpen(cfg, entries, nm);
    const nextMonth = {
      month: nm, pool: n.pool, daysLeft: n.daysLeft, limit: n.limit,
      parts: { carried: no.carried, salary: no.salary, fixed: no.fixed, fixedCard: no.fixedCard, emergency: no.emergency, emergencyPlanned: no.emergencyPlanned, savedBefore: no.savedBefore, saved: no.saved, cardDebt: no.debtBefore },
      fullUse: { pool: n.pool - unspent, limit: Math.floor((n.pool - unspent) / n.daysLeft) },
    };
    const endOfToday = moneyLeft(cfg, entries, next, mk);
    return Object.assign({ month: mk, base, history: history.reverse(), tomorrow, nextMonth, endOfToday }, now);
  }
  // ---------- credit card ----------
  // The cycle containing `day`: statement day to the day before the next statement day.
  function cycleOf(day, statementDay) {
    const [y, m] = parts(day);
    let start = dayIn(y, m, statementDay);
    if (start > day) start = dayIn(y, m - 1, statementDay);
    const [sy, sm] = parts(start);
    return { start, end: addDays(dayIn(sy, sm + 1, statementDay), -1) };
  }

  // Cycles when the statement day has been changed: the old day runs until the first new-day date after the change.
  function cycleFor(cfg, day) {
    const rules = [{ E: '', day: cfg.statementDay }];
    for (const c of cfg.statementChanges || []) { // already in the order they were made
      const [y, m] = parts(c.at); const same = dayIn(y, m, c.day);
      // A later change replaces an earlier one whose first new-day statement hadn't come yet.
      while (rules.length > 1 && rules[rules.length - 1].E > c.at) rules.pop();
      rules.push({ E: same > c.at ? same : dayIn(y, m + 1, c.day), day: c.day });
    }
    let i = 0; while (i + 1 < rules.length && rules[i + 1].E <= day) i++;
    const c = cycleOf(day, rules[i].day), nextE = rules[i + 1] && rules[i + 1].E;
    return { start: c.start, end: nextE && nextE <= c.end ? addDays(nextE, -1) : c.end };
  }

  // First due day strictly after the statement date.
  function dueAfter(statement, dueDay) {
    const [y, m] = parts(statement);
    const same = dayIn(y, m, dueDay);
    return same > statement ? same : dayIn(y, m + 1, dueDay);
  }

  // bill  = statements already generated (everything before this cycle) minus every payment.
  // cycle = spends since this cycle started, split Card / UPI; it becomes the next bill.
  function card(cfg, entries, day) {
    const cyc = cycleFor(cfg, day);
    const st = cfg.start;
    let billed = st.bill, paid = 0, cardAmt = 0, upiAmt = 0, otherAmt = 0;
    const fixedOnCard = fixedCardCharges(cfg, day);
    if (st.date && st.date >= cyc.start) { cardAmt += st.cycleCard; upiAmt += st.cycleUpi; }
    else billed += st.cycleCard + st.cycleUpi;

    for (const e of entries) {
      if (e.date > day) continue;
      if (e.type === 'pay') paid += e.amount;
      else if (isCardCharge(e)) { // bank payments never touch the card
        if (e.date < cyc.start) billed += e.amount;
        else if (e.type === 'adj') otherAmt += e.amount;
        else if (e.method === 'upi') upiAmt += e.amount;
        else cardAmt += e.amount;
      }
    }
    for (const f of fixedOnCard) {
      if (f.date < cyc.start) billed += f.amount; else otherAmt += f.amount;
    }
    const billLeft = billed - paid; // negative means paid ahead
    const total = cardAmt + upiAmt + otherAmt;
    const owed = billLeft + total;
    const billDue = dueAfter(cyc.start, cfg.dueDay);
    // Each statement keeps its own due date; payments clear the oldest first.
    const stmts = {}; const add = (sd, a) => { if (a) stmts[sd] = (stmts[sd] || 0) + a; };
    const sOf = new Map(), stmtOf = d => { if (!sOf.has(d)) sOf.set(d, addDays(cycleFor(cfg, d).end, 1)); return sOf.get(d); };
    add(st.date ? cycleFor(cfg, st.date).start : cyc.start, st.bill);
    if (!(st.date && st.date >= cyc.start)) add(st.date ? stmtOf(st.date) : cyc.start, st.cycleCard + st.cycleUpi);
    for (const e of entries) if (e.date <= day && isCardCharge(e) && e.date < cyc.start) add(stmtOf(e.date), e.amount);
    for (const f of fixedOnCard) if (f.date < cyc.start) add(stmtOf(f.date), f.amount);
    // Refunds and cashback act like payments: they clear the oldest statement first.
    let rest = paid, overdueAmount = 0, overdueSince = null;
    for (const sd in stmts) if (stmts[sd] < 0) { rest -= stmts[sd]; delete stmts[sd]; }
    for (const e of entries) if (e.type === 'adj' && e.amount < 0 && e.date >= cyc.start && e.date <= day) rest -= e.amount;
    for (const sd of Object.keys(stmts).sort()) {
      const left = Math.max(0, stmts[sd] - rest); rest = Math.max(0, rest - stmts[sd]);
      const due = dueAfter(sd, cfg.dueDay);
      if (left > 0 && day > due) { overdueAmount += left; if (!overdueSince) overdueSince = due; }
    }
    const cap = Math.max(0, Math.min(billLeft, owed));
    if (overdueAmount > cap) overdueAmount = cap;
    if (!overdueAmount) overdueSince = null;
    const paidAhead = Math.min(total, Math.max(0, -billLeft));
    const cycleDue = dueAfter(addDays(cyc.end, 1), cfg.dueDay);
    const next = billLeft > 0 ? { date: billDue, amount: billLeft } : { date: cycleDue, amount: Math.max(0, owed) };
    next.inDays = daysBetween(day, next.date);
    // Credit utilisation: what's owed against the card limit; staying under safePct helps the credit score.
    const used = Math.max(0, owed), safe = Math.round(cfg.cardLimit * cfg.safePct / 100);
    const util = { limit: cfg.cardLimit, safePct: cfg.safePct, safe, used, pct: cfg.cardLimit ? used / cfg.cardLimit * 100 : 0, room: safe - used };
    return {
      util,
      owed,
      paid,
      credit: Math.max(0, -billLeft),
      bill: { left: Math.max(0, billLeft), due: billDue, overdue: overdueAmount > 0, overdueAmount, overdueSince, lateBy: overdueAmount > 0 ? daysBetween(overdueSince, day) : 0 },
      cycle: { start: cyc.start, end: cyc.end, card: cardAmt, upi: upiAmt, other: otherAmt, total, paidAhead, net: total - paidAhead, due: cycleDue, closesIn: daysBetween(day, cyc.end) },
      next,
    };
  }

  // ---------- bank balance ----------
  // Works like the bank account: combined salary - Bank spends - card bill payments - emergency fund.
  // Card and UPI-on-card spends leave the bank only when the card bill is paid, so they aren't taken off twice.
  function salary(cfg, entries, day) {
    const o = monthOpen(cfg, entries, monthOf(day));
    const t = monthTotals(entries, o.from, addDays(day, 1));
    return {
      total: o.salary, s1: o.s1, s2: o.s2, inStart: o.inStart, opening: o.opening, carried: o.carried, startDate: o.from,
      fixed: o.fixed, fixedCard: o.fixedCard, fixedList: o.inStart ? [] : o.fixedList, emergency: o.emergency,
      emergencyPlanned: o.emergencyPlanned, savedBefore: o.savedBefore, saved: o.saved,
      bank: t.bankOut, paid: t.paid, onCard: t.onCard, byWho: t.byWho,
      left: o.opening - o.emergency - t.bankOut - t.paid,
    };
  }

  // Anything logged before the starting numbers were taken is already inside them.
  function liveEntries(data, cfg) {
    cfg = cfg || configFrom(data.settings);
    return Object.values(data.entries).filter(e => !e.deleted && !(cfg.start.at && e.ts < cfg.start.at));
  }
  function compute(data, day) {
    const cfg = configFrom(data.settings);
    const entries = liveEntries(data, cfg);
    memo = { cfg, entries, map: new Map() };
    try { return { cfg, entries, daily: daily(cfg, entries, day), card: card(cfg, entries, day), salary: salary(cfg, entries, day) }; }
    finally { memo = null; }
  }

  // ---------- alerts ----------
  // Warnings shown at the top of the screen. Numbers only; the app words them.
  function alerts(r, day) {
    const out = [], c = r.card, d = r.daily, s = r.salary;
    if (c.bill.overdue) out.push({ id: 'card-overdue', level: 'bad', sheet: 'card', amount: c.bill.overdueAmount, date: c.bill.overdueSince, days: c.bill.lateBy });
    const dueSoon = c.next.amount - (c.bill.overdueAmount || 0);
    if (dueSoon > 0 && c.next.inDays >= 0 && c.next.inDays <= 3) out.push({ id: 'card-due', level: 'warn', sheet: 'card', amount: dueSoon, date: c.next.date, days: c.next.inDays });
    if (c.util.limit && c.util.room < 0) out.push({ id: 'card-util', level: 'bad', sheet: 'card', amount: -c.util.room, pct: c.util.pct, safePct: c.util.safePct });
    if (d.left < 0 && d.spent > 0) out.push({ id: 'over-today', level: 'bad', sheet: 'today', amount: -d.left });
    // The formula always stretches what's left over the remaining days, so the only shortfall is none left at all.
    const end = d.endOfToday != null ? d.endOfToday : d.pool;
    if (end < 0 || (end === 0 && d.daysLeft > 1)) out.push({ id: 'short', level: 'bad', sheet: 'today', amount: end < 0 ? -end : 0 });
    return out;
  }

  // ---------- sync ----------
  // Entries merge by id and settings by key; the newer edit (higher t) wins.
  function merge(into, incoming) {
    let changed = false;
    for (const e of incoming.entries || []) {
      const cur = into.entries[e.id];
      if (!cur || e.t > cur.t) { into.entries[e.id] = e; changed = true; }
    }
    const s = incoming.settings || {};
    for (const k in s) {
      const cur = into.settings[k];
      if (!cur || s[k].t > cur.t) { into.settings[k] = s[k]; changed = true; }
    }
    return changed;
  }

  function parseMoney(text) {
    const raw = String(text == null ? '' : text).trim();
    if (raw === '') return null;
    const cleaned = raw.replace(/[^\d.]/g, '');
    if (!/\d/.test(cleaned)) return null;
    const n = Math.round(Number(cleaned));
    return Number.isFinite(n) ? n : null;
  }

  const api = {
    DEFAULTS, today, addDays, daysBetween, monthOf, shiftMonth,
    configFrom, cycleOf, moneyLeft, emergencyFor, salaryFor, fixedFor, dueAfter, daily, card, salary, compute, liveEntries, alerts, merge, parseMoney, fixedCardCharges,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Budget = api;
})(typeof self !== 'undefined' ? self : this);
