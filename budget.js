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
    limit: 500, emergency: 2000, statementDay: 19, dueDay: 8, cardLimit: 0, safePct: 30,
    // What happened before the app was first used.
    startDate: null, startCarry: 0, startMonthSpent: 0, startCycleCard: 0, startCycleUpi: 0, startBill: 0,
  };

  // settings is { key: { v, t } } as stored and synced; this flattens it to plain values.
  function configFrom(settings) {
    const v = k => { const s = settings[k]; return s && s.v != null && s.v !== '' ? s.v : DEFAULTS[k]; };
    const limits = {};
    for (const k in settings) {
      if (k.startsWith('limit:') && settings[k].v != null && settings[k].v !== '') limits[k.slice(6)] = Number(settings[k].v);
    }
    return {
      name1: v('name1'), name2: v('name2'), salary1: +v('salary1'), salary2: +v('salary2'),
      limits, defaultLimit: DEFAULTS.limit, emergency: +v('emergency'),
      statementDay: +v('statementDay'), dueDay: +v('dueDay'), cardLimit: +v('cardLimit'), safePct: +v('safePct'),
      start: {
        date: v('startDate'), carry: +v('startCarry'), monthSpent: +v('startMonthSpent'),
        cycleCard: +v('startCycleCard'), cycleUpi: +v('startCycleUpi'), bill: +v('startBill'),
      },
    };
  }

  // A month without its own limit uses the latest earlier month's limit.
  function limitFor(cfg, mk) {
    if (cfg.limits[mk] != null) return { amount: cfg.limits[mk], set: true };
    const earlier = Object.keys(cfg.limits).filter(k => k < mk).sort().pop();
    return { amount: earlier ? cfg.limits[earlier] : cfg.defaultLimit, set: false };
  }

  // ---------- daily limit ----------
  // Each day gets the month's limit plus whatever the previous day left (or minus what it overspent).
  // The running carry starts fresh on the 1st of every month.
  function daily(cfg, entries, day) {
    const mk = monthOf(day);
    const limit = limitFor(cfg, mk).amount;
    const st = cfg.start;
    let from = mk + '-01', carry = 0;
    if (st.date && monthOf(st.date) === mk && st.date <= day) { from = st.date; carry = st.carry; }

    const spentOn = {};
    for (const e of entries) {
      if (e.type === 'spend' && e.date >= from && e.date <= day) spentOn[e.date] = (spentOn[e.date] || 0) + e.amount;
    }
    const history = [];
    for (let d = from; d <= day; d = addDays(d, 1)) {
      const available = limit + carry, spent = spentOn[d] || 0;
      history.push({ date: d, limit, carry, available, spent, left: available - spent });
      carry = available - spent;
    }
    const now = history[history.length - 1];
    const next = addDays(day, 1);
    const tomorrow = monthOf(next) === mk
      ? { date: next, limit, carry: now.left, fresh: false }
      : { date: next, limit: limitFor(cfg, monthOf(next)).amount, carry: 0, fresh: true };
    return Object.assign({ month: mk, history: history.reverse(), tomorrow }, now);
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

  // First due day strictly after the statement date.
  function dueAfter(statement, dueDay) {
    const [y, m] = parts(statement);
    const same = dayIn(y, m, dueDay);
    return same > statement ? same : dayIn(y, m + 1, dueDay);
  }

  // bill  = statements already generated (everything before this cycle) minus every payment.
  // cycle = spends since this cycle started, split Card / UPI; it becomes the next bill.
  function card(cfg, entries, day) {
    const cyc = cycleOf(day, cfg.statementDay);
    const st = cfg.start;
    let billed = st.bill, paid = 0, cardAmt = 0, upiAmt = 0;
    if (st.date && st.date >= cyc.start) { cardAmt += st.cycleCard; upiAmt += st.cycleUpi; }
    else billed += st.cycleCard + st.cycleUpi;

    for (const e of entries) {
      if (e.date > day) continue;
      if (e.type === 'pay') paid += e.amount;
      else if (e.type === 'spend' && e.method !== 'bank') { // bank payments never touch the card
        if (e.date < cyc.start) billed += e.amount;
        else if (e.method === 'upi') upiAmt += e.amount;
        else cardAmt += e.amount;
      }
    }
    const billLeft = billed - paid; // negative means paid ahead
    const total = cardAmt + upiAmt;
    const owed = billLeft + total;
    const billDue = dueAfter(cyc.start, cfg.dueDay);
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
      bill: { left: Math.max(0, billLeft), due: billDue, overdue: billLeft > 0 && day > billDue, lateBy: Math.max(0, daysBetween(billDue, day)) },
      cycle: { start: cyc.start, end: cyc.end, card: cardAmt, upi: upiAmt, total, due: cycleDue, closesIn: daysBetween(day, cyc.end) },
      next,
    };
  }

  // ---------- bank balance ----------
  // Works like the bank account: combined salary - Bank spends - card bill payments - emergency fund.
  // Card and UPI-on-card spends leave the bank only when the card bill is paid, so they aren't taken off twice.
  function salary(cfg, entries, day) {
    const mk = monthOf(day);
    const byWho = { 1: 0, 2: 0 };
    let bank = 0, paid = 0, onCard = 0, before = 0;
    for (const e of entries) {
      if (monthOf(e.date) !== mk || e.date > day) continue;
      if (e.type === 'pay') paid += e.amount;
      else if (e.type === 'spend' && e.method === 'bank') { bank += e.amount; byWho[e.who] = (byWho[e.who] || 0) + e.amount; }
      else if (e.type === 'spend') onCard += e.amount;
    }
    if (cfg.start.date && monthOf(cfg.start.date) === mk) before = cfg.start.monthSpent;
    const total = cfg.salary1 + cfg.salary2;
    return { total, s1: cfg.salary1, s2: cfg.salary2, before, bank, paid, onCard, byWho, emergency: cfg.emergency, left: total - before - bank - paid - cfg.emergency };
  }

  function compute(data, day) {
    const cfg = configFrom(data.settings);
    const entries = Object.values(data.entries).filter(e => !e.deleted);
    return { cfg, daily: daily(cfg, entries, day), card: card(cfg, entries, day), salary: salary(cfg, entries, day) };
  }

  // ---------- alerts ----------
  // Warnings shown at the top of the screen. Numbers only; the app words them.
  function alerts(r, day) {
    const out = [], c = r.card, d = r.daily, s = r.salary;
    if (c.bill.overdue) out.push({ id: 'card-overdue', level: 'bad', sheet: 'card', amount: c.bill.left, date: c.bill.due, days: c.bill.lateBy });
    else if (c.next.amount > 0 && c.next.inDays <= 3) out.push({ id: 'card-due', level: 'warn', sheet: 'card', amount: c.next.amount, date: c.next.date, days: c.next.inDays });
    if (c.util.limit && c.util.room < 0) out.push({ id: 'card-util', level: 'bad', sheet: 'card', amount: -c.util.room, pct: c.util.pct, safePct: c.util.safePct });
    if (d.left < 0) out.push({ id: 'over-today', level: 'bad', sheet: 'today', amount: -d.left });
    // Enough salary left for the rest of today plus the daily limit on every remaining day of the month?
    const [y, m] = day.split('-').map(Number);
    const daysAfter = daysBetween(day, ymd(y, m, daysInMonth(y, m)));
    const needed = Math.max(0, d.left) + d.limit * daysAfter;
    if (s.left < needed) out.push({ id: 'short', level: 'warn', sheet: 'salary', amount: needed - s.left, needed, have: s.left, perDay: d.limit, daysLeft: daysAfter + 1 });
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

  const api = {
    DEFAULTS, today, addDays, daysBetween, monthOf, shiftMonth,
    configFrom, limitFor, cycleOf, dueAfter, daily, card, salary, compute, alerts, merge,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Budget = api;
})(typeof self !== 'undefined' ? self : this);
