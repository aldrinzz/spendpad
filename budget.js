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
    const fixed = (Array.isArray(v('fixed')) ? v('fixed') : []).filter(f => f && typeof f === 'object').map(f => ({ name: String(f.name || ''), amount: Math.max(0, +f.amount || 0) }));
    return {
      emergencies, fixed,
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
  function emergencyFor(cfg, mk) {
    if (cfg.emergencies[mk] != null) return cfg.emergencies[mk];
    const earlier = Object.keys(cfg.emergencies).filter(k => k < mk).sort().pop();
    return earlier ? cfg.emergencies[earlier] : cfg.emergency;
  }

  // How a month opens. The start month opens on the bank balance Aldrin gave. Every later month opens on
  // whatever was left in the bank at the end of the month before (emergency fund included, since it never
  // left), plus both salaries, minus the fixed costs; it then keeps aside its own emergency fund and the
  // card debt that's still unpaid.
  function monthOpen(cfg, entries, mk) {
    const st = cfg.start;
    const inStart = !!st.date && monthOf(st.date) === mk;
    const salary = cfg.salary1 + cfg.salary2;
    const fixed = inStart ? 0 : cfg.fixed.reduce((n, f) => n + f.amount, 0);
    const from = inStart ? st.date : mk + '-01';
    let carried = 0;
    if (!inStart && st.date && monthOf(st.date) < mk) {
      const prev = monthOpen(cfg, entries, shiftMonth(mk, -1));
      const t = monthTotals(entries, prev.from, from);
      carried = prev.opening - t.bankOut - t.paid;
    }
    return {
      inStart, from, salary, fixed, carried,
      opening: inStart ? (st.bank != null ? st.bank : salary - st.monthSpent) : carried + salary - fixed,
      emergency: emergencyFor(cfg, mk),
      debtBefore: inStart ? st.bill + st.cycleCard + st.cycleUpi : Math.max(0, card(cfg, entries, addDays(from, -1)).owed),
    };
  }

  // Totals for the month from its first tracked day up to (but not including) `until`.
  function monthTotals(entries, from, until) {
    const t = { bankOut: 0, paid: 0, onCard: 0, byWho: { 1: 0, 2: 0 } };
    for (const e of entries) {
      if (e.date < from || e.date >= until) continue;
      if (e.type === 'pay') t.paid += e.amount;
      else if (e.type === 'spend' && e.method === 'bank') { t.bankOut += e.amount; t.byWho[e.who] = (t.byWho[e.who] || 0) + e.amount; }
      else if (e.type === 'spend') t.onCard += e.amount;
    }
    return t;
  }

  // Money left at the start of day d = bank balance − card debt that's being kept aside.
  // In the start month only new card spends are kept aside (payments go to the old bill first),
  // which matches how Aldrin worked out the first ₹458. From the next month all unpaid card debt is.
  function moneyLeft(cfg, entries, d) {
    const o = monthOpen(cfg, entries, monthOf(d));
    const t = monthTotals(entries, o.from, d);
    const bank = o.opening - o.emergency - t.bankOut - t.paid;
    const unpaid = o.inStart
      ? Math.max(0, t.onCard - Math.max(0, t.paid - o.debtBefore))
      : Math.max(0, o.debtBefore + t.onCard - t.paid);
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

  function daily(cfg, entries, day) {
    const mk = monthOf(day), st = cfg.start;
    let from = st.date && monthOf(st.date) === mk ? st.date : mk + '-01';
    if (from > day) from = day;
    const spentOn = {};
    for (const e of entries) {
      if (e.type === 'spend' && e.date >= from && e.date <= day) spentOn[e.date] = (spentOn[e.date] || 0) + e.amount;
    }
    const history = [];
    for (let d = from; d <= day; d = addDays(d, 1)) {
      const l = limitOn(cfg, entries, d), spent = spentOn[d] || 0;
      history.push({ date: d, pool: l.pool, daysLeft: l.daysLeft, limit: l.limit, available: l.limit, spent, left: l.limit - spent });
    }
    const now = history[history.length - 1];
    const next = addDays(day, 1);
    const t = limitOn(cfg, entries, next);
    const tomorrow = { date: next, pool: t.pool, daysLeft: t.daysLeft, limit: t.limit, fresh: monthOf(next) !== mk };
    // Next month's daily limit as things stand: if nothing more is spent this month, everything left
    // carries over. Every spend lowers it right away; card bill payments don't (that debt is already kept aside).
    const nm = shiftMonth(mk, 1), n = limitOn(cfg, entries, nm + '-01');
    // And if every remaining day's limit gets used, what's still unspent this month won't carry over.
    const unspent = Math.max(0, tomorrow.fresh ? now.left : t.pool);
    const nextMonth = {
      month: nm, pool: n.pool, daysLeft: n.daysLeft, limit: n.limit,
      fullUse: { pool: n.pool - unspent, limit: Math.floor((n.pool - unspent) / n.daysLeft) },
    };
    return Object.assign({ month: mk, history: history.reverse(), tomorrow, nextMonth }, now);
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
    const o = monthOpen(cfg, entries, monthOf(day));
    const t = monthTotals(entries, o.from, addDays(day, 1));
    return {
      total: o.salary, s1: cfg.salary1, s2: cfg.salary2, inStart: o.inStart, opening: o.opening, carried: o.carried, startDate: o.from,
      fixed: o.fixed, fixedList: o.inStart ? [] : cfg.fixed, emergency: o.emergency,
      bank: t.bankOut, paid: t.paid, onCard: t.onCard, byWho: t.byWho,
      left: o.opening - o.emergency - t.bankOut - t.paid,
    };
  }

  function compute(data, day) {
    const cfg = configFrom(data.settings);
    // Anything logged before the starting numbers were taken is already inside them.
    const entries = Object.values(data.entries).filter(e => !e.deleted && !(cfg.start.at && e.ts < cfg.start.at));
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
    // The formula always stretches what's left over the remaining days, so the only shortfall is none left at all.
    if (d.pool <= 0) out.push({ id: 'short', level: 'bad', sheet: 'today', amount: -d.pool });
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
    configFrom, cycleOf, moneyLeft, emergencyFor, dueAfter, daily, card, salary, compute, alerts, merge,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Budget = api;
})(typeof self !== 'undefined' ? self : this);
