/* LavishTracker screen: keypad, tiles, sheets, local storage and Google Sheet sync.
   All budget maths lives in budget.js. */
(function () {
  'use strict';

  const B = window.Budget;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => document.querySelectorAll(sel);
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const money = n => (Math.round(n) < 0 ? '−₹' : '₹') + inr.format(Math.abs(Math.round(n)));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function fmtDate(s, weekday) {
    const [y, m, d] = s.split('-').map(Number);
    return (weekday ? WEEKDAYS[new Date(y, m - 1, d).getDay()] + ', ' : '') + d + ' ' + MONTHS[m - 1].slice(0, 3);
  }
  const monthName = mk => MONTHS[Number(mk.slice(5, 7)) - 1];
  const timeOf = ts => new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  // Whole percent while under the safe line; one decimal once over, so 30.1% never reads as "30%".
  const pctText = u => (u.room >= 0 ? Math.floor(u.pct) : Math.ceil(u.pct * 10) / 10) + '%';
  const METHOD = { card: 'Card', upi: 'UPI', bank: 'Bank' };
  const inDays = n => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days');
  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
  }

  // ---------- storage ----------
  // data is shared with the other phone through sync; device stays on this phone.
  const DATA_KEY = 'spendpad.data';
  const DEVICE_KEY = 'spendpad.device';
  function read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked: keep working in memory */ } }

  const data = Object.assign({ entries: {}, settings: {}, dirty: { entries: {}, settings: {} } }, read(DATA_KEY));
  // The shared Google Sheet's script link. Useless without the sync key, which only the two phones know.
  const SYNC_URL = 'https://script.google.com/macros/s/AKfycbxncOaIJ4tajl9lpX_0k7XlqT2HOZEF6opALqG0VKam7CxDiDK75SEqpOyMn6Cv0cZx/exec';
  const device = Object.assign({ owner: '1', syncUrl: '', syncKey: '', lastSync: 0, syncError: '' }, read(DEVICE_KEY));
  if (!device.syncUrl) device.syncUrl = SYNC_URL;

  // Starting numbers as of Fri 16 Oct 2026, given by Aldrin. Every phone starts from these,
  // so there is no setup screen. Changing SEED_VERSION resets every phone to the seed the next
  // time the app opens: the seed is stamped at SEED_AT, so it outranks older edits in the Google
  // Sheet, and entries logged before SEED_AT are ignored (they're inside the starting numbers).
  const SEED_VERSION = 2;
  const SEED_AT = 1792163965000; // 16 Oct 2026, when these numbers were given
  const SEED = {
    settings: {
      name1: 'Aldrin', salary1: 47400, name2: 'Navs', salary2: 26300,
      emergency: 2000, statementDay: 19, dueDay: 8,
      startDate: '2026-10-16', startAt: SEED_AT,
      startBank: 9328,                            // in the bank on 16 Oct: Aldrin 6,672 + Navs 2,656.42
      startMonthSpent: 64372,                     // same thing for older app versions: 73,700 salary - 9,328
      startCycleCard: 12138, startCycleUpi: 9884, // card spends that cycle; with the 17-18 Oct spends the 19 Oct statement is 27,275, due 8 Nov
      startBill: 0,
      cardLimit: 80000, safePct: 30,              // keep usage under 30% for the credit score
      'emergency:2026-11': 5000,                  // emergency fund from November...
      emergencyGrowth: { from: '2026-12', amount: 5000 }, // ...then ₹5,000 more every month (10,000 in Dec, 15,000 in Jan)
      dailyCap: { from: '2026-11', amount: 1500 },  // ₹1,500/day from November; whatever is left over is saved into the emergency fund
      'dailyLimit:2026-11': 1000,                 // November set to ₹1,000/day; what it can't cover comes out of December
      fixed: [{ name: 'Hostel fees', amount: 14000 }, { name: 'Bike EMI', amount: 7280 }, { name: 'Wifi', amount: 489 }],
      // Quick notes offered after each spend; editable under ⚙. "subs" open a second row.
      notes: [
        { name: 'Petrol' },
        { name: 'Zomato/Swiggy', subs: ['Breakfast', 'Lunch', 'Dinner'] },
        { name: 'Zepto' }, { name: 'Eggs' }, { name: 'Milk' }, { name: 'Vegetables' }, { name: 'Fruits' },
        { name: 'Groceries (rice, flour etc.)' },
      ],
    },
  };
  if (data.seed !== SEED_VERSION) {
    data.settings = {};
    data.entries = {};
    data.dirty = { entries: {}, settings: {} };
    for (const k in SEED.settings) {
      data.settings[k] = { v: SEED.settings[k], t: SEED_AT };
      data.dirty.settings[k] = true; // pushed to the Google Sheet so it resets too
    }
    data.seed = SEED_VERSION;
    write(DATA_KEY, data);
  }
  // Corrections to starting numbers already on phones: applied once, only if the old value is untouched.
  // 20 Oct: the real 19 Oct statement is 27,275, ₹350 more than the app had, from before the 16 Oct start.
  const s0 = data.settings.startCycleCard;
  if (s0 && s0.v === 11788 && s0.t === SEED_AT) { data.settings.startCycleCard = { v: 12138, t: Date.now() }; data.dirty.settings.startCycleCard = true; write(DATA_KEY, data); }
  // Settings added to the seed later reach phones that were already set up, without a reset.
  for (const k in SEED.settings) if (!data.settings[k]) data.settings[k] = { v: SEED.settings[k], t: 1 };
  const saveData = () => write(DATA_KEY, data);
  const saveDevice = () => write(DEVICE_KEY, device);

  // ---------- changes ----------
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function addEntry(fields) {
    const now = Date.now();
    const e = Object.assign({ id: newId(), date: B.today(), ts: now, who: device.owner, method: null, deleted: false, t: now }, fields);
    data.entries[e.id] = e;
    data.dirty.entries[e.id] = true;
    changed();
    return e;
  }
  // Deletes are kept as a flag (not removed) so the other phone learns about them.
  function setDeleted(id, deleted) {
    const e = data.entries[id];
    if (!e) return;
    e.deleted = deleted;
    e.t = Date.now();
    data.dirty.entries[id] = true;
    changed();
  }
  function setNote(id, note) {
    const e = data.entries[id];
    if (!e) return;
    e.note = note || '';
    e.t = Date.now();
    data.dirty.entries[id] = true;
    changed();
  }
  function setSettings(pairs) {
    const t = Date.now();
    for (const k in pairs) {
      data.settings[k] = { v: pairs[k], t };
      data.dirty.settings[k] = true;
    }
    changed();
  }
  function changed() {
    rev++;
    saveData();
    render(true);
    scheduleSync(800);
  }

  // ---------- main screen ----------
  let view = null;      // last computed numbers
  let countDelay = 0;   // lets the big number wait for the flying amount to land

  function render(animate) {
    const day = B.today();
    view = B.compute(data, day);
    view.day = day;
    const { daily: d, card: c, salary: s, cfg } = view;

    $('#dateLabel').textContent = fmtDate(day, true);

    const over = d.left < 0;
    const frac = d.available > 0 ? Math.min(1, d.spent / d.available) : 1;
    $('#todayLabel').textContent = over ? 'Over today’s limit by' : 'Left today';
    countTo($('#todayLeft'), d.left, animate, n => money(Math.abs(n)));
    $('#todayBreak').innerHTML = breakdownHTML(d);
    $('#todaySpent').textContent = d.spent ? money(d.spent) + ' spent' : '';
    $('#todayBar').style.width = frac * 100 + '%';
    // What's left of this month carries over, so every spend now shows up here too.
    $('#nextLabel').textContent = monthName(d.nextMonth.month) + ' so far' + (d.nextMonth.parts.saved > 0 ? ` · +${money(d.nextMonth.parts.saved)} saved` : d.nextMonth.borrow > 0 ? ` · ${money(d.nextMonth.borrow)} from ${monthName(B.shiftMonth(d.nextMonth.month, 1)).slice(0, 3)}` : '');
    countTo($('#nextLimit'), d.nextMonth.limit, animate, n => money(n) + '/day');
    $('#nextLimit').classList.toggle('neg', d.nextMonth.limit < 0);
    $('#todayCard').classList.toggle('over', over);
    $('#todayCard').classList.toggle('warn', !over && frac >= 0.8);

    countTo($('#salaryLeft'), s.left, animate);
    $('#salaryLeft').classList.toggle('neg', s.left < 0);
    $('#salaryTotal').innerHTML = s.inStart
      ? `started with <b>${money(s.opening)}</b> on ${fmtDate(s.startDate)}<br>salaries from 1 ${monthName(d.nextMonth.month).slice(0, 3)}`
      : `salary <b>${money(s.total)}</b><br>${esc(cfg.name1)} <b>${money(s.s1)}</b> + ${esc(cfg.name2)} <b>${money(s.s2)}</b>`;

    countTo($('#cardOwed'), c.owed, animate);
    $('#cardDue').textContent = c.bill.overdue ? 'Overdue since ' + fmtDate(c.bill.overdueSince) : 'Due ' + fmtDate(c.next.date) + ' · ' + inDays(c.next.inDays);
    $('#cardTile').classList.toggle('alert', c.bill.overdue);
    const u = c.util, uFrac = u.safe ? u.used / u.safe : 0;
    $('#utilBar').parentNode.hidden = $('#cardUtil').hidden = !u.limit;
    $('#utilBar').style.width = Math.min(1, uFrac) * 100 + '%';
    $('#utilBar').className = uFrac > 1 ? 'bad' : uFrac >= 0.8 ? 'warn' : '';
    $('#cardUtil').textContent = `${pctText(u)} of limit · ` + (u.room >= 0 ? `${money(u.room)} to ${u.safePct}%` : `${money(-u.room)} over ${u.safePct}%`);
    countTo($('#emerg'), s.emergency, animate);
    $('#emergSub').textContent = cfg.emergencyGrowth.amount ? `set aside · +${money(cfg.emergencyGrowth.amount)}/month` : 'set aside';

    countTo($('#cycleCard'), c.cycle.card, animate);
    countTo($('#cycleUpi'), c.cycle.upi, animate);
    countTo($('#monthBank'), s.bank, animate);
    $('#whoChip').textContent = cfg['name' + device.owner];
    paintAlerts(B.alerts(view, day), day);

    if (sheetName) keepSheetFresh();
  }

  // "₹631 + ₹100 carried over" / "₹631 − ₹200 overspent": the month's fixed daily limit plus what earlier days left.
  const withCarry = (limit, carry) => carry
    ? `${money(limit)} ${carry > 0 ? '+' : '−'} ${money(Math.abs(carry))}`
    : money(limit);
  function breakdownHTML(d) {
    if (!d.carry) return `Daily limit <b>${money(d.limit)}</b>`;
    const plus = d.carry > 0;
    return `<b>${money(d.limit)}</b> ${plus ? '+' : '−'} <b class="${plus ? 'pos' : 'neg'}">${money(Math.abs(d.carry))}</b> ${plus ? 'carried over' : 'overspent'}`;
  }

  // Warnings at the top. ✕ hides one until tomorrow; tapping it opens the matching sheet.
  function alertText(a) {
    if (a.id === 'card-overdue') return `Card bill ${money(a.amount)} overdue by ${a.days} day${a.days === 1 ? '' : 's'}`;
    if (a.id === 'card-due') return `Card bill ${money(a.amount)} due ${inDays(a.days)} (${fmtDate(a.date)})`;
    if (a.id === 'card-util') return `Card at ${pctText({ pct: a.pct, room: -1 })} of limit: pay ${money(a.amount)} to get back under ${a.safePct}%`;
    if (a.id === 'over-today') return `Over today’s limit by ${money(a.amount)}`;
    return a.amount > 0 ? `This month’s money is used up: ${money(a.amount)} over` : 'This month’s money is used up';
  }
  function paintAlerts(list, day) {
    const hidden = device.dismissed || {};
    $('#alerts').innerHTML = list.filter(a => hidden[a.id] !== day).map(a =>
      `<div class="alert ${a.level}"><button type="button" class="alert-msg" data-sheet="${a.sheet}">${esc(alertText(a))}</button><button type="button" class="alert-x" data-dismiss="${a.id}" aria-label="Hide until tomorrow">✕</button></div>`
    ).join('');
  }

  // Rolls a number from what is on screen to its new value.
  function countTo(el, to, animate, fmt) {
    fmt = fmt || money;
    const from = el._shown;
    cancelAnimationFrame(el._raf);
    if (!animate || reduceMotion || from == null || from === to) { el._shown = to; el.textContent = fmt(to); return; }
    const start = performance.now() + countDelay, dur = 600;
    const step = now => {
      const p = Math.max(0, Math.min(1, (now - start) / dur));
      el._shown = from + (to - from) * (1 - Math.pow(1 - p, 3));
      el.textContent = fmt(el._shown);
      if (p < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  function restartAnim(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

  // ---------- haptics ----------
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function buzz(ms) {
    if (navigator.vibrate) navigator.vibrate(ms);
    else if (isIOS) $('#hapLabel').click();
  }

  // ---------- keypad ----------
  const MAX_DIGITS = 7; // up to ₹99,99,999
  let amount = '';

  function press(k) {
    hideStrip();
    if (k === 'del') amount = amount.slice(0, -1);
    else if (!amount && (k === '0' || k === '00')) return nudge();
    else if (amount.length + k.length > MAX_DIGITS) return nudge();
    else amount += k;
    buzz(5);
    paintAmount(true);
  }
  function nudge() { restartAnim($('#amount'), 'shake'); buzz(25); }
  function paintAmount(bump) {
    const el = $('#amount');
    el.textContent = money(Number(amount) || 0);
    el.classList.toggle('empty', !amount);
    $('#pad').classList.toggle('ready', !!amount);
    if (bump && amount) restartAnim(el, 'bump');
  }

  // Card / UPI: one tap saves the amount; there is no separate "done" step.
  function log(method) {
    const n = Number(amount);
    if (!n) return nudge();
    const wasOver = view.daily.left < 0;
    fly();
    amount = '';
    paintAmount();
    countDelay = 320;
    const e = addEntry({ type: 'spend', amount: n, method });
    countDelay = 0;
    buzz(15);
    floatDelta(n);
    let msg = money(n) + ' · ' + METHOD[method];
    if (!wasOver && view.daily.left < 0) msg += ' · over limit';
    showStrip(e, msg);
  }

  // ---------- quick notes ----------
  // rawNotes keeps unfinished rows for the editor; quickNotes is what the strip offers.
  const rawNotes = () => {
    const s = data.settings.notes;
    const list = s && Array.isArray(s.v) ? s.v : SEED.settings.notes;
    return list.filter(n => n && typeof n === 'object').map(n => ({ name: String(n.name || ''), subs: (Array.isArray(n.subs) ? n.subs : []).map(x => String(x).trim()).filter(Boolean) }));
  };
  const quickNotes = () => rawNotes().filter(n => n.name.trim()).map(n => ({ name: n.name.trim(), subs: n.subs }));
  // The meal that fits the time of day goes first and is highlighted: breakfast before 11, lunch until 4, then dinner.
  function orderSubs(subs) {
    const h = new Date().getHours();
    const want = h < 11 ? 'breakfast' : h < 16 ? 'lunch' : 'dinner';
    const i = subs.findIndex(x => x.toLowerCase() === want);
    if (i < 0) return subs.map(name => ({ name, hi: false }));
    return [{ name: subs[i], hi: true }].concat(subs.filter((x, j) => j !== i).map(name => ({ name, hi: false })));
  }

  // The strip after a spend: what was saved, Undo, and optional quick notes. It goes away when
  // the next amount is typed; picking a note attaches it and closes the strip.
  let strip = null; // { id, msg, mode: 'list' | 'subs' | 'type', parent }
  function showStrip(e, msg) {
    strip = { id: e.id, msg, mode: 'list', parent: null };
    paintStrip();
  }
  function hideStrip() {
    if (!strip) return;
    strip = null;
    const el = $('#strip');
    el.hidden = true;
    el.classList.remove('typing');
    el.innerHTML = '';
  }
  function paintStrip() {
    const el = $('#strip');
    if (!strip) { hideStrip(); return; }
    const e = data.entries[strip.id];
    const saved = esc(strip.msg) + (e && e.note ? ' · ' + esc(e.note) : '');
    let body;
    if (strip.mode === 'subs') {
      body = `<div class="chips"><button type="button" class="nchip back" data-strip="back">‹ Back</button>` +
        orderSubs(strip.parent.subs).map(x => `<button type="button" class="nchip${x.hi ? ' hi' : ''}" data-sub="${esc(x.name)}">${esc(x.name)}</button>`).join('') + '</div>';
    } else if (strip.mode === 'type') {
      body = `<div class="strip-type"><input id="stripInput" type="text" placeholder="Type a note" maxlength="60" autocomplete="off" enterkeyhint="done"><button type="button" class="nchip hi" data-strip="save">Save</button></div>`;
    } else {
      body = '<div class="chips">' + quickNotes().map((n, i) => `<button type="button" class="nchip${n.subs.length ? ' more' : ''}" data-note="${i}">${esc(n.name)}</button>`).join('') +
        '<button type="button" class="nchip type" data-strip="type">✎ Type</button></div>';
    }
    el.innerHTML = `<div class="strip-head"><span class="saved"><span class="ok">✓</span>${saved}</span><button type="button" data-strip="undo">Undo</button><button type="button" class="strip-x" data-strip="close" aria-label="Close">✕</button></div>` + body;
    el.hidden = false;
    el.classList.toggle('typing', strip.mode === 'type');
    if (strip.mode === 'type') { const inp = $('#stripInput'); inp.focus(); }
  }
  function noteDone(text) {
    if (!strip) return;
    const id = strip.id;
    setNote(id, text);
    buzz(10);
    strip.mode = 'list';
    $('#strip').classList.remove('typing');
    paintStrip();
    const keep = strip;
    setTimeout(() => { if (strip === keep) hideStrip(); }, 1100);
  }

  // The typed amount flies up into "left today".
  function fly() {
    if (reduceMotion) return;
    const src = $('#amount'), dst = $('#todayLeft');
    const a = src.getBoundingClientRect(), b = dst.getBoundingClientRect();
    const ghost = src.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.className = 'amount fly';
    Object.assign(ghost.style, { left: a.left + 'px', top: a.top + 'px', height: a.height + 'px', lineHeight: a.height + 'px' });
    document.body.appendChild(ghost);
    const dx = b.left - a.left, dy = b.top + b.height / 2 - (a.top + a.height / 2);
    ghost.animate(
      [{ transform: 'translate(0, 0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.5)`, opacity: 0 }],
      { duration: 460, easing: 'cubic-bezier(.3, .7, .2, 1)' }
    ).onfinish = () => ghost.remove();
    setTimeout(() => restartAnim($('#todayCard'), 'pop'), 330);
  }

  function floatDelta(n) {
    if (reduceMotion) return;
    const r = $('#todayCard').getBoundingClientRect();
    const el = document.createElement('span');
    el.className = 'delta';
    el.textContent = money(-n);
    el.style.right = innerWidth - r.right + 16 + 'px';
    el.style.top = r.top + 40 + 'px';
    el.addEventListener('animationend', () => el.remove());
    document.body.appendChild(el);
  }

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(msg, undo) {
    const el = $('#toast');
    el.style.setProperty('--toast-bottom', innerHeight - $('#pad').getBoundingClientRect().top + 72 + 'px');
    el.innerHTML = `<span>${esc(msg)}</span>` + (undo ? '<button type="button">Undo</button>' : '');
    if (undo) el.querySelector('button').onclick = () => { el.classList.remove('show'); undo(); };
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 5000 : 1800);
  }

  // ---------- sheets ----------
  let sheetName = null;

  const head = title => `<div class="sheet-head"><h2>${title}</h2><button class="x" type="button" data-act="close" aria-label="Close">✕</button></div>`;
  const calc = (key, cls) => `<span class="${cls || ''}" data-calc="${key}"></span>`;

  function moneyField(label, key, value, opts) {
    opts = opts || {};
    const hint = opts.hint ? `<small>${opts.hint}</small>` : '';
    const type = opts.signed ? 'type="number" data-signed="1"' : 'type="text" inputmode="numeric" pattern="[0-9]*"';
    return `<label class="field"><span>${label}${hint}</span><span class="money-in"><input ${type} data-key="${key}" value="${value == null ? '' : esc(value)}" placeholder="${esc(opts.placeholder || '0')}" autocomplete="off"></span></label>`;
  }
  const dayField = (label, key, value, hint) =>
    `<label class="field"><span>${label}<small>${hint}</small></span><input type="text" inputmode="numeric" pattern="[0-9]*" data-key="${key}" value="${esc(value)}" autocomplete="off"></label>`;
  const textField = (label, key, value, placeholder) =>
    `<label class="field"><span>${label}</span><input class="text" type="text" data-type="text" data-key="${key}" value="${esc(value)}" placeholder="${esc(placeholder || '')}" autocomplete="off"></label>`;

  function entryRow(e) {
    const name = view.cfg['name' + e.who] || '';
    if (e.type === 'adj') {
      const fee = e.amount >= 0;
      return `<li><i class="pill ${fee ? 'fee' : 'pay'}">${fee ? 'Fee' : 'Refund'}</i><span class="meta">${fmtDate(e.date)}, ${timeOf(e.ts)} · ${esc(name)}${e.note ? `<span class="note-text">${esc(e.note)}</span>` : ''}</span><b>${fee ? '+' : '−'}${money(Math.abs(e.amount))}</b><button class="del" type="button" data-act="del" data-id="${esc(e.id)}" aria-label="Delete">✕</button></li>`;
    }
    const pill = e.type === 'pay' ? '<i class="pill pay">Paid</i>' : `<i class="pill ${METHOD[e.method] ? e.method : 'card'}">${METHOD[e.method] || 'Card'}</i>`;
    const when = (e.type === 'pay' ? fmtDate(e.date) + ', ' : '') + timeOf(e.ts);
    const note = e.type === 'spend'
      ? (e.note ? `<span class="note-text">${esc(e.note)}</span>` : '<span class="note-add">+ note</span>')
      : '';
    const main = `${pill}<span class="meta">${when} · ${esc(name)}${note}</span>`;
    const left = e.type === 'spend'
      ? `<button class="note-btn" type="button" data-act="noteEdit" data-id="${esc(e.id)}">${main}</button>`
      : main;
    return `<li>${left}<b>${money(e.amount)}</b><button class="del" type="button" data-act="del" data-id="${esc(e.id)}" aria-label="Delete">✕</button></li>`;
  }

  function dayBlock(h, list, isToday) {
    const tag = `<span class="tag ${h.left < 0 ? 'neg' : 'pos'}">${h.left < 0 ? money(h.left) : '+' + money(h.left)}</span>`;
    const items = list.length ? list.map(entryRow).join('') : '<li class="empty-note">No spends</li>';
    return `<details${isToday ? ' open' : ''}><summary><span class="d">${isToday ? 'Today' : fmtDate(h.date, true)}</span><span class="num">${money(h.spent)} of ${money(h.available)}</span>${tag}</summary><ul class="list">${items}</ul></details>`;
  }

  const live = type => view.entries.filter(e => e.type === type);

  let noteTarget = null, noteReturn = null; // entry being given a note, and the sheet to go back to

  // The card bill that existed when the app was started (paid from the next month's money).
  const oldBill = () => { const st = view.cfg.start; return st.bill + st.cycleCard + st.cycleUpi; };
  // Salaries and fixed costs are edited for this month or from next month on (next by default).
  // In the start month only "from next month" exists: October runs on the bank balance it started with.
  let editWhen = 'next';
  const editTarget = () => {
    const mk = view.daily.month;
    return view.salary.inStart || editWhen === 'next' ? B.shiftMonth(mk, 1) : mk;
  };
  // The statement day now in force (changes are dated, so bills already made keep theirs).
  const statementDayNow = () => {
    const ch = view.cfg.statementChanges || [];
    return ch.length ? ch[ch.length - 1].day : view.cfg.statementDay;
  };
  // Editing only this month must not change next month: if next month has no amount of its own yet,
  // pin it to what it inherits now. The pin carries the source's timestamp, so it never beats an edit
  // the other phone made to next month.
  function pinNextMonth(prefix, inherited) {
    const nmk = B.shiftMonth(view.daily.month, 1), key = prefix + ':' + nmk;
    const cur = data.settings[key];
    if (cur && cur.v != null && cur.v !== '') return;
    const earlier = Object.keys(data.settings).filter(k => k.startsWith(prefix + ':') && /^\d{4}-\d{2}$/.test(k.slice(prefix.length + 1)) && k.slice(prefix.length + 1) < nmk).sort();
    const src = earlier.length ? data.settings[earlier[earlier.length - 1]] : data.settings[prefix];
    data.settings[key] = { v: JSON.parse(JSON.stringify(inherited)), t: Math.max(src ? src.t : 1, cur ? cur.t : 0) };
    data.dirty.settings[key] = true;
    // Show the kept amount in next month's box, if it's on screen (and not being typed in).
    const box = $(`#sheetBody [data-key="${key}"]`);
    if (box && box !== document.activeElement && typeof inherited !== 'object') box.value = inherited;
  }
  function setFixed(list) {
    const target = editTarget();
    if (target === view.daily.month) pinNextMonth('fixed', B.fixedFor(view.cfg, B.shiftMonth(target, 1)));
    setSettings({ ['fixed:' + target]: list });
  }

  const SHEETS = {
    note() {
      const e = data.entries[noteTarget];
      if (!e) return head('Note') + '<p class="note">That spend is gone.</p>';
      const picks = quickNotes().flatMap(n => (n.subs.length ? n.subs.map(x => n.name + ' · ' + x) : [n.name]));
      return head('Note') + `
        <p class="note">${money(e.amount)} · ${METHOD[e.method] || 'Card'} · ${fmtDate(e.date, true)}, ${timeOf(e.ts)}</p>
        <div class="group"><div class="note-pick">${picks.map(p => `<button type="button" class="nchip${p === e.note ? ' hi' : ''}" data-act="notePick" data-note="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>
        <div class="group"><div class="strip-type"><input id="noteInput" type="text" value="${esc(e.note || '')}" placeholder="Or type a note" maxlength="60" autocomplete="off" enterkeyhint="done"><button type="button" class="nchip hi" data-act="noteSave">Save</button></div></div>
        ${e.note ? '<button class="btn ghost wide" type="button" data-act="noteClear">Remove the note</button>' : ''}`;
    },

    today() {
      const d = view.daily, mk = d.month;
      const byDay = {};
      for (const e of live('spend')) if (B.monthOf(e.date) === mk) (byDay[e.date] = byDay[e.date] || []).push(e);
      const days = d.history.map(h => dayBlock(h, (byDay[h.date] || []).sort((a, b) => b.ts - a.ts), h.date === view.day)).join('');
      return head('Daily limit') + `
        <div class="group">
          <div class="row"><span>Left today</span><b class="big">${calc('todayLeft')}</b></div>
          <div class="row"><span>${monthName(mk)}’s daily limit</span>${calc('monthLimit', 'num')}</div>
          <div class="row"><span>Today</span>${calc('todayAvail', 'num')}</div>
          <div class="row"><span>Tomorrow (if nothing more today)</span>${calc('tomorrow', 'num')}</div>
        </div>
        <p class="note">The daily limit is set on the 1st (the month’s money ÷ its days) and stays the same all month. Whatever you don’t spend is added to tomorrow; whatever you overspend comes off tomorrow, and it keeps adding up until the month ends. The month’s money is the bank balance minus Card and UPI spends not paid off yet, after keeping the emergency fund aside.${view.salary.inStart && oldBill() ? ` The card bill from before you started (${money(oldBill())}) is paid from ${monthName(d.nextMonth.month)}’s money, so it isn’t taken off here.` : ''}</p>
        <h3>${monthName(d.nextMonth.month)}, as it stands</h3>
        <div class="group">
          <div class="row"><span>Left in the bank (emergency included)</span>${calc('npCarried', 'num')}</div>
          <div class="row"><span>+ Salaries</span>${calc('npSalary', 'num pos')}</div>
          <div class="row"><span>− Fixed costs</span>${calc('npFixed', 'num neg')}</div>
          ${d.nextMonth.parts.fixedCard ? `<div class="row"><span>− Fixed costs on the card</span>${calc('npFixedCard', 'num neg')}</div>` : ''}
          <div class="row"><span>− Emergency fund${d.nextMonth.parts.saved > 0 ? ' (incl. extra saved)' : ''}</span>${calc('npEmerg', 'num neg')}</div>
          ${d.nextMonth.parts.cardDebt < 0
            ? `<div class="row"><span>+ Card credit (paid ahead)</span>${calc('npCardCredit', 'num pos')}</div>`
            : `<div class="row"><span>− Card bill still to pay</span>${calc('npCard', 'num neg')}</div>`}
          <div class="row total"><span>Money for ${monthName(d.nextMonth.month)}</span><b class="num">${calc('npPool')}</b></div>
        </div>
        <div class="group">
          <div class="row"><span>If nothing more is spent in ${monthName(mk)}</span>${calc('nextStop', 'num')}</div>
          <div class="row"><span>If every day’s limit gets used</span>${calc('nextFull', 'num')}</div>
        </div>
        <h3>Daily limits</h3>
        <div class="group">
          ${view.salary.inStart ? '' : moneyField(monthName(mk), 'dailyLimit:' + mk, view.cfg.dailyLimits[mk], { placeholder: 'auto', hint: 'leave empty to work it out' })}
          ${moneyField(monthName(d.nextMonth.month), 'dailyLimit:' + d.nextMonth.month, view.cfg.dailyLimits[d.nextMonth.month], { placeholder: 'auto', hint: 'leave empty to work it out' })}
          ${moneyField('Other months, at most', 'dailyCap', view.cfg.dailyCap ? view.cfg.dailyCap.amount : '', { placeholder: 'none', hint: 'anything beyond goes to the emergency fund' })}
        </div>
        <p class="note">A limit set for a month is used as it is. If that month’s money can’t cover it, the rest comes out of the next month; if it has more, the rest goes to the emergency fund.${d.borrow > 0 ? ` This month ${money(d.borrow)} is coming out of ${monthName(d.nextMonth.month)}.` : ''}${d.nextMonth.borrow > 0 ? ` ${monthName(d.nextMonth.month)} at ${money(d.nextMonth.limit)}/day takes ${money(d.nextMonth.borrow)} from ${monthName(B.shiftMonth(d.nextMonth.month, 1))}.` : ''}</p>
        <p class="note">Whatever’s left at the end of ${monthName(mk)} carries into ${monthName(d.nextMonth.month)}, so every ₹1,000 spent now costs ${monthName(d.nextMonth.month)} about ${calc('nextPer1000')} a day. Paying the card bill doesn’t change it: that money is already kept aside.</p>
        <h3>${monthName(mk)} so far</h3>
        <div class="group days">${days}</div>`;
    },

    salary() {
      const cfg = view.cfg, s = view.salary, mk = view.daily.month, nmk = B.shiftMonth(mk, 1);
      const target = editTarget();
      const fixed = B.fixedFor(cfg, target);
      const fixedRows = fixed.map((f, i) => `<div class="field fixed-row">
          <input class="text" type="text" data-fixed="${i}" data-field="name" value="${esc(f.name)}" placeholder="Name" autocomplete="off">
          <span class="money-in"><input type="text" inputmode="decimal" data-fixed="${i}" data-field="amount" value="${esc(f.amount)}" placeholder="0" autocomplete="off"></span>
          <button class="via ${f.via}" type="button" data-act="fixedVia" data-i="${i}" aria-label="Paid by">${f.via === 'card' ? 'Card' : 'Bank'}</button>
          <button class="del" type="button" data-act="fixedDel" data-i="${i}" aria-label="Remove">✕</button></div>`).join('');
      const seg = s.inStart ? '' : `<div class="seg">${[['this', monthName(mk)], ['next', monthName(nmk) + ' onwards']].map(([k, label]) =>
        `<button type="button" data-act="editWhen" data-when="${k}" class="${editWhen === k ? 'on' : ''}">${label}</button>`).join('')}</div>`;
      return head('Bank balance') + `
        <div class="group">
          ${s.inStart
            ? `<div class="row"><span>In the bank on ${fmtDate(s.startDate)}</span>${calc('salOpening', 'num')}</div>`
            : `<div class="row"><span>Left over from ${monthName(B.shiftMonth(mk, -1))}</span>${calc('salCarried', 'num')}</div>
               <div class="row"><span>Combined salary</span>${calc('salTotal', 'num')}</div>
               <div class="row"><span>Fixed costs from the bank</span>${calc('salFixed', 'num neg')}</div>`}
          <div class="row"><span>Bank spends this month</span>${calc('salBank', 'num neg')}</div>
          <div class="row small">${calc('salWho')}</div>
          <div class="row"><span>Card bills paid this month</span>${calc('salPaid', 'num neg')}</div>
          <div class="row"><span>Emergency set aside</span>${calc('salEmerg', 'num neg')}</div>
          <div class="row total"><span>Bank balance</span><b class="big">${calc('salLeft')}</b></div>
        </div>
        <p class="note">Card and UPI spends (${calc('salOnCard')} this month) leave the bank when you pay the card bill, so they come off here only then.</p>
        <h3>Salaries and fixed costs</h3>
        ${seg}
        <p class="note">${s.inStart ? `These start on 1 ${monthName(nmk)}. ${monthName(mk)} runs on the bank balance you started with.` : editWhen === 'this'
          ? `Changing ${monthName(mk)} only: ${monthName(nmk)} keeps its own amounts.`
          : `From ${monthName(nmk)} on. ${monthName(mk)} and earlier months stay as they were.`}</p>
        <div class="group">${textField('Name', 'name1', cfg.name1)}${moneyField('Salary', 'salary1:' + target, B.salaryFor(cfg, target, 1))}</div>
        <div class="group">${textField('Name', 'name2', cfg.name2)}${moneyField('Salary', 'salary2:' + target, B.salaryFor(cfg, target, 2))}</div>
        <div class="group">
          ${fixedRows || '<p class="empty-note">No fixed costs</p>'}
          <div class="row total"><span>Fixed costs, taken off on the 1st</span>${calc('fxTotal', 'num')}</div>
        </div>
        <button class="btn ghost wide" type="button" data-act="fixedAdd">Add a fixed cost</button>
        <p class="note">${s.inStart ? `From ${monthName(nmk)}, each month` : 'Each month'} starts from what’s left in the bank plus both salaries, minus the fixed costs, so don’t log them as spends too. Tap Bank / Card to say how each one is paid: card ones are added to the card bill on the 1st instead of leaving the bank.</p>`;
    },

    card() {
      const cfg = view.cfg;
      const pays = live('pay').sort((a, b) => b.ts - a.ts);
      const adjs = live('adj').sort((a, b) => b.ts - a.ts);
      return head('Credit card') + `
        <div class="group"><div class="row"><span>Total owed</span><b class="big">${calc('cardOwed')}</b></div></div>
        <div class="group">
          <h4>Last bill · due ${calc('billDue')}</h4>
          <div class="row"><span>${calc('billState')}</span><b class="num">${calc('billLeft')}</b></div>
        </div>
        ${view.salary.inStart && view.card.bill.left > 0 ? `<p class="note">Pay this bill from ${monthName(view.daily.nextMonth.month)}’s salary: it’s due ${fmtDate(view.card.bill.due)}, and its money is already set aside out of ${monthName(view.daily.nextMonth.month)}. Paying it before the 1st comes out of ${monthName(view.daily.month)}’s money instead.</p>` : ''}
        <div class="group">
          <h4>This cycle · ${calc('cycleRange')}</h4>
          <div class="row"><span><i class="pill card">Card</i></span>${calc('cycCard', 'num')}</div>
          <div class="row"><span><i class="pill upi">UPI on card</i></span>${calc('cycUpi', 'num')}</div>
          ${view.card.cycle.other ? `<div class="row"><span><i class="pill fee">Fees, refunds &amp; fixed costs</i></span>${calc('cycOther', 'num')}</div>` : ''}
          ${view.card.cycle.paidAhead ? `<div class="row"><span>Paid ahead</span>${calc('cycAhead', 'num pos')}</div>` : ''}
          <div class="row total"><span>Bill due ${calc('cycDue')}</span><b class="num">${calc('cycTotal')}</b></div>
        </div>
        <h3>Credit limit</h3>
        <div class="group">
          ${moneyField('Card limit', 'cardLimit', cfg.cardLimit)}
          ${dayField('Keep usage under', 'safePct', cfg.safePct, '% of the limit')}
          <div class="row"><span>Used</span>${calc('utilUsed', 'num')}</div>
          <div class="row total"><span>Room before ${cfg.safePct}%</span><b class="num">${calc('utilRoom')}</b></div>
        </div>
        <h3>Billing cycle</h3>
        <div class="group">
          ${dayField('Statement day', 'statementDay', statementDayNow(), 'from the next statement')}
          ${dayField('Due day', 'dueDay', cfg.dueDay, 'pay the bill by')}
        </div>
        <h3>Record a bill payment</h3>
        <div class="group">
          <div class="pay-row"><input id="payAmount" type="text" inputmode="decimal" placeholder="₹ amount paid" autocomplete="off"><button class="btn small" type="button" data-act="pay">Paid</button></div>
          ${pays.length ? `<ul class="list" style="margin-top:8px">${pays.map(entryRow).join('')}</ul>` : ''}
        </div>
        <h3>Card adjustment</h3>
        <p class="note">Interest or a fee on the statement: add it. A refund or cashback on the card: take it off. It changes Card owed and this month’s money, but isn’t counted as a day’s spending.</p>
        <div class="group">
          <div class="pay-row"><input id="adjAmount" type="text" inputmode="decimal" placeholder="₹ amount" autocomplete="off"></div>
          <div class="pay-row" style="margin-top:8px"><button class="btn small grow" type="button" data-act="adj" data-sign="1">+ Fee / interest</button><button class="btn small ghost grow" type="button" data-act="adj" data-sign="-1">− Refund / cashback</button></div>
          ${adjs.length ? `<ul class="list" style="margin-top:8px">${adjs.map(entryRow).join('')}</ul>` : ''}
        </div>`;
    },

    emergency() {
      const cfg = view.cfg, mk = view.daily.month, nmk = B.shiftMonth(mk, 1), n2 = B.shiftMonth(mk, 2);
      const g = cfg.emergencyGrowth;
      return head('Emergency fund') + `
        <div class="group">
          ${moneyField(monthName(mk), 'emergency:' + mk, B.emergencyFor(cfg, mk))}
          ${moneyField(monthName(nmk), 'emergency:' + nmk, B.emergencyFor(cfg, nmk))}
          ${moneyField('Grows every month by', 'emergencyGrowth', g.amount, { hint: 'set 0 to keep it the same' })}
        </div>
        ${view.salary.savedBefore || view.salary.saved ? `<div class="group"><div class="row"><span>Extra saved (money beyond ${money(cfg.dailyCap ? cfg.dailyCap.amount : 0)}/day)</span><b class="num pos">${money(view.salary.savedBefore + view.salary.saved)}</b></div><div class="row total"><span>Emergency fund this month</span><b class="num">${money(view.salary.emergency)}</b></div></div>` : ''}
        <p class="note">${g.amount ? `${monthName(nmk)} ${money(B.emergencyFor(cfg, nmk))}, then ${monthName(n2)} ${money(B.emergencyFor(cfg, n2))}, and ${money(g.amount)} more every month after. ` : ''}Kept aside in the bank: taken out of the bank balance and the money the daily limit is worked out from. The amount it grows by comes out of that month’s salary.</p>`;
    },

    settings() {
      const cfg = view.cfg, st = cfg.start;
      return head('Settings') + `
        <h3>This phone belongs to</h3>
        <div class="seg">${['1', '2'].map(k => `<button type="button" data-act="owner" data-owner="${k}" class="${device.owner === k ? 'on' : ''}">${esc(cfg['name' + k])}</button>`).join('')}</div>
        <h3>Sync with the other phone</h3>
        <div class="group">
          <label class="field col"><span>Sync link</span><input data-dev="syncUrl" type="url" value="${esc(device.syncUrl)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <label class="field col"><span>Sync key</span><input data-dev="syncKey" type="text" value="${esc(device.syncKey)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
          <div class="sync-row">${calc('syncStatus', 'note')}<button class="btn small" type="button" data-act="sync">Sync now</button></div>
        </div>
        <h3>Quick notes</h3>
        <p class="note">Offered after every spend, in this order. Options (comma-separated) open a second row, like Breakfast, Lunch, Dinner.</p>
        <div class="group">${rawNotes().map((n, i) => `<div class="qn-row">
            <div class="qn-line">
              <input type="text" data-qn="${i}" data-qn-field="name" value="${esc(n.name)}" placeholder="Note" autocomplete="off">
              <button class="move" type="button" data-act="qnUp" data-i="${i}" aria-label="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
              <button class="del" type="button" data-act="qnDel" data-i="${i}" aria-label="Remove">✕</button>
            </div>
            <input type="text" data-qn="${i}" data-qn-field="subs" value="${esc(n.subs.join(', '))}" placeholder="Options (optional)" autocomplete="off">
          </div>`).join('') || '<p class="empty-note">None yet</p>'}</div>
        <button class="btn ghost wide" type="button" data-act="qnAdd">Add a quick note</button>
        <h3>Starting numbers</h3>
        <p class="note">What happened before you started using the app.</p>
        <div class="group">
          <label class="field"><span>Started on</span><input type="date" data-type="text" data-key="startDate" value="${esc(st.date || '')}"></label>
          ${moneyField('In the bank that day', 'startBank', st.bank)}
          ${moneyField('Card spends that cycle', 'startCycleCard', st.cycleCard)}
          ${moneyField('UPI spends that cycle', 'startCycleUpi', st.cycleUpi)}
          ${moneyField('Unpaid card bill', 'startBill', st.bill)}
        </div>
        <button class="btn ghost wide" type="button" data-act="backup">Download backup</button>`;
    },
  };

  // Numbers inside an open sheet, refreshed in place so typing in a field is never interrupted.
  const CALC = {
    todayLeft: v => money(v.daily.left),
    nextStop: v => `${money(v.daily.nextMonth.pool)} ÷ ${v.daily.nextMonth.daysLeft} = ${money(v.daily.nextMonth.limit)}`,
    nextFull: v => `${money(v.daily.nextMonth.fullUse.pool)} ÷ ${v.daily.nextMonth.daysLeft} = ${money(v.daily.nextMonth.fullUse.limit)}`,
    nextPer1000: v => money(1000 / v.daily.nextMonth.daysLeft),
    todayAvail: v => (v.daily.carry ? withCarry(v.daily.limit, v.daily.carry) + ' = ' : '') + money(v.daily.available),
    tomorrow: v => {
      const t = v.daily.tomorrow;
      return (t.fresh ? 'new month: ' : '') + (t.carry ? withCarry(t.limit, t.carry) + ' = ' : '') + money(t.available);
    },
    monthLimit: v => `${money(v.daily.limit)} a day`,
    salTotal: v => money(v.salary.total),
    salOpening: v => money(v.salary.opening),
    salCarried: v => money(v.salary.carried),
    salFixed: v => money(-v.salary.fixed),
    salBank: v => money(-v.salary.bank),
    salWho: v => `${v.cfg.name1} ${money(v.salary.byWho[1] || 0)} · ${v.cfg.name2} ${money(v.salary.byWho[2] || 0)}`,
    salPaid: v => money(-v.salary.paid),
    salOnCard: v => money(v.salary.onCard),
    salEmerg: v => money(-v.salary.emergency),
    salLeft: v => money(v.salary.left),
    cardOwed: v => money(v.card.owed),
    billDue: v => fmtDate(v.card.bill.due),
    billState: v => {
      const c = v.card;
      if (c.bill.overdue) return `${money(c.bill.overdueAmount)} overdue by ${c.bill.lateBy} day${c.bill.lateBy === 1 ? '' : 's'}`;
      if (c.bill.left > 0) return 'Left to pay · due ' + inDays(c.next.inDays);
      return c.credit ? `Paid · ${money(c.credit)} extra` : 'Paid ✓';
    },
    billLeft: v => money(v.card.bill.left),
    cycleRange: v => fmtDate(v.card.cycle.start) + ' – ' + fmtDate(v.card.cycle.end),
    cycCard: v => money(v.card.cycle.card),
    cycUpi: v => money(v.card.cycle.upi),
    cycDue: v => fmtDate(v.card.cycle.due),
    cycTotal: v => money(v.card.cycle.net),
    cycOther: v => money(v.card.cycle.other),
    cycAhead: v => money(-v.card.cycle.paidAhead),
    npCarried: v => money(v.daily.nextMonth.parts.carried),
    npSalary: v => money(v.daily.nextMonth.parts.salary),
    npFixed: v => money(-v.daily.nextMonth.parts.fixed),
    npFixedCard: v => money(-v.daily.nextMonth.parts.fixedCard),
    npEmerg: v => money(-v.daily.nextMonth.parts.emergency),
    npCard: v => money(-v.daily.nextMonth.parts.cardDebt),
    npCardCredit: v => money(-v.daily.nextMonth.parts.cardDebt),
    fxTotal: () => money(B.fixedFor(view.cfg, editTarget()).reduce((n, f) => n + f.amount, 0)),
    npPool: v => money(v.daily.nextMonth.pool),
    utilUsed: v => `${money(v.card.util.used)} · ${pctText(v.card.util)}`,
    utilRoom: v => money(v.card.util.room),
    syncStatus: () => syncText(),
  };
  function updateCalcs() {
    for (const el of $$('#sheetBody [data-calc]')) el.textContent = CALC[el.dataset.calc](view);
  }

  const DONE = '<button class="btn wide done" type="button" data-act="close">Done</button>';
  let rev = 0, sheetStamp = '', selfEdit = false;
  const stampNow = () => view.day + '|' + rev;
  const inSheetInput = el => el && el.tagName === 'INPUT' && $('#sheetBody').contains(el);
  // Rebuild only once focus has left the sheet's fields, never under a finger moving to the next field.
  function rebuildWhenLeft(el) {
    el.addEventListener('focusout', ev => {
      if (inSheetInput(ev.relatedTarget)) { updateCalcs(); rebuildWhenLeft(ev.relatedTarget); return; }
      setTimeout(() => {
        if (!sheetName || sheetStamp === stampNow()) return;
        if (inSheetInput(document.activeElement)) { updateCalcs(); rebuildWhenLeft(document.activeElement); return; }
        refreshSheet();
      }, 250); // after the tap that moved focus has landed
    }, { once: true });
  }
  function keepSheetFresh() {
    if (!sheetName) return;
    // An edit made in this sheet only updates its numbers; the sheet is already showing the new value.
    if (selfEdit) { sheetStamp = stampNow(); updateCalcs(); return; }
    if (sheetStamp === stampNow()) { updateCalcs(); return; }
    const active = document.activeElement;
    if (inSheetInput(active)) {
      updateCalcs();
      if (!active._rebuildArmed) { active._rebuildArmed = true; rebuildWhenLeft(active); }
    } else refreshSheet();
  }
  function openSheet(name) {
    hideStrip();
    sheetName = name;
    $('#sheetBody').innerHTML = SHEETS[name]() + DONE;
    sheetStamp = stampNow();
    updateCalcs();
    const wrap = $('#sheetWrap');
    wrap.hidden = false;
    $('.sheet').scrollTop = 0;
    requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  }
  function closeSheet() {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // commits a pending edit
    sheetName = null;
    const wrap = $('#sheetWrap');
    wrap.classList.remove('open');
    setTimeout(() => { if (!sheetName) wrap.hidden = true; }, 300);
  }
  // Full rebuild, used only right after a button inside the sheet was tapped.
  function refreshSheet() {
    if (!sheetName) return;
    const sheet = $('.sheet'), top = sheet.scrollTop;
    const sameDay = sheetStamp.split('|')[0] === view.day;
    const open = Array.from($$('#sheetBody details'), el => el.open);
    const typed = { pay: ($('#payAmount') || {}).value, adj: ($('#adjAmount') || {}).value };
    $('#sheetBody').innerHTML = SHEETS[sheetName]() + DONE;
    sheetStamp = stampNow();
    if (sameDay) $$('#sheetBody details').forEach((el, i) => { if (open[i] != null) el.open = open[i]; });
    if (typed.pay && $('#payAmount')) $('#payAmount').value = typed.pay;
    if (typed.adj && $('#adjAmount')) $('#adjAmount').value = typed.adj;
    updateCalcs();
    sheet.scrollTop = top;
  }

  // Swipe a sheet down to close it (when it's scrolled to the top).
  (function swipeToClose() {
    const sheet = $('.sheet');
    let y0 = null, dy = 0;
    sheet.addEventListener('touchstart', ev => {
      if (sheet.scrollTop > 0 || ev.touches.length > 1 || ev.target.closest('input')) { y0 = null; return; }
      y0 = ev.touches[0].clientY; dy = 0;
    }, { passive: true });
    sheet.addEventListener('touchmove', ev => {
      if (y0 == null) return;
      dy = ev.touches[0].clientY - y0;
      if (dy <= 0) { sheet.style.transform = ''; return; }
      ev.preventDefault();
      sheet.style.transition = 'none';
      sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: false });
    sheet.addEventListener('touchend', () => {
      if (y0 == null) return;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy > 90) closeSheet();
      y0 = null;
    });
  })();

  function readInput(inp) {
    const raw = inp.value.trim();
    if (inp.dataset.type === 'text') return raw || null;
    if (raw === '') return null;
    if (!inp.dataset.signed) return B.parseMoney(raw);
    const n = Math.round(Number(raw.replace(/[^\d.-]/g, '')));
    return Number.isFinite(n) ? n : null;
  }

  function saveNotesFromEditor() {
    const list = Array.from($$('#sheetBody [data-qn-field="name"]'), el => {
      const subs = $(`#sheetBody [data-qn="${el.dataset.qn}"][data-qn-field="subs"]`).value;
      return { name: el.value.trim(), subs: subs.split(',').map(x => x.trim()).filter(Boolean) };
    });
    setSettings({ notes: list });
  }
  const finishNote = text => {
    setNote(noteTarget, text);
    buzz(10);
    if (noteReturn) openSheet(noteReturn); else closeSheet();
  };

  const ACTIONS = {
    close: () => closeSheet(),
    noteEdit(btn) {
      noteTarget = btn.dataset.id;
      noteReturn = sheetName;
      openSheet('note');
    },
    notePick: btn => finishNote(btn.dataset.note),
    noteSave: () => finishNote($('#noteInput').value.trim()),
    noteClear: () => finishNote(''),
    qnAdd() {
      setSettings({ notes: rawNotes().concat({ name: '', subs: [] }) });
      refreshSheet();
      const rows = $$('#sheetBody [data-qn-field="name"]');
      if (rows.length) rows[rows.length - 1].focus();
    },
    qnDel(btn) {
      setSettings({ notes: rawNotes().filter((n, i) => i !== +btn.dataset.i) });
      refreshSheet();
    },
    qnUp(btn) {
      const list = rawNotes(), i = +btn.dataset.i;
      if (i < 1) return;
      [list[i - 1], list[i]] = [list[i], list[i - 1]];
      setSettings({ notes: list });
      refreshSheet();
    },
    editWhen(btn) { editWhen = btn.dataset.when; refreshSheet(); },
    fixedVia(btn) {
      const list = B.fixedFor(view.cfg, editTarget()).map((f, i) => (i === +btn.dataset.i ? Object.assign({}, f, { via: f.via === 'card' ? 'bank' : 'card' }) : f));
      setFixed(list);
      refreshSheet();
    },
    adj(btn) {
      const input = $('#adjAmount'), n = B.parseMoney(input.value);
      if (!(n > 0) || n > 9999999) { restartAnim(input, 'shake'); return; }
      const fee = btn.dataset.sign === '1';
      input.value = ''; // before addEntry rebuilds the sheet, so a second tap can't record it twice
      addEntry({ type: 'adj', amount: fee ? n : -n });
      buzz(15);
      toast((fee ? 'Fee added ' : 'Refund recorded ') + money(n));
      refreshSheet();
    },
    fixedAdd() {
      setFixed(B.fixedFor(view.cfg, editTarget()).concat({ name: '', amount: 0, via: 'bank' }));
      refreshSheet();
      const rows = $$('#sheetBody [data-field="name"]');
      if (rows.length) rows[rows.length - 1].focus();
    },
    fixedDel(btn) {
      setFixed(B.fixedFor(view.cfg, editTarget()).filter((f, i) => i !== +btn.dataset.i));
      refreshSheet();
    },
    del(btn) {
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.textContent = 'Delete';
        setTimeout(() => { if (btn.isConnected) { btn.classList.remove('confirm'); btn.textContent = '✕'; } }, 3000);
        return;
      }
      const id = btn.dataset.id;
      setDeleted(id, true);
      refreshSheet();
      toast('Deleted', () => { setDeleted(id, false); refreshSheet(); });
    },
    pay() {
      const input = $('#payAmount');
      const n = B.parseMoney(input.value);
      if (!(n > 0) || n > 9999999) { restartAnim(input, 'shake'); return; }
      input.value = ''; // before addEntry rebuilds the sheet, so a second tap can't record it twice
      addEntry({ type: 'pay', amount: n });
      buzz(15);
      toast(money(n) + ' payment recorded');
      refreshSheet();
    },
    owner(btn) {
      device.owner = btn.dataset.owner;
      saveDevice();
      render(false);
      refreshSheet();
    },
    sync() { syncNow().then(refreshSheet); },
    backup() {
      const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), entries: data.entries, settings: data.settings }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'lavishtracker-backup-' + B.today() + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
  };

  // ---------- sync with the Google Sheet ----------
  // Send what changed here, get everything back, keep the newer edit of each item.
  let syncTimer = 0, syncBusy = false;
  const hasDirty = () => Object.keys(data.dirty.entries).length + Object.keys(data.dirty.settings).length > 0;

  function scheduleSync(ms) {
    clearTimeout(syncTimer);
    if (device.syncUrl && device.syncKey) syncTimer = setTimeout(syncNow, ms);
    paintSync();
  }

  async function syncNow() {
    if (!device.syncUrl || !device.syncKey || syncBusy) return;
    syncBusy = true;
    paintSync();
    // Copies, so edits made while the request is out are still seen as unsent.
    const sentE = Object.keys(data.dirty.entries).filter(id => data.entries[id]).map(id => Object.assign({}, data.entries[id]));
    const sentS = {};
    for (const k of Object.keys(data.dirty.settings)) if (data.settings[k]) sentS[k] = Object.assign({}, data.settings[k]);
    try {
      const res = await fetch(device.syncUrl, {
        method: 'POST',
        // text/plain keeps this a "simple" request: Apps Script can't answer a CORS preflight.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: device.syncKey, entries: sentE, settings: sentS }),
      });
      const out = await res.json().catch(() => ({ ok: false, error: 'Unexpected reply. Check the sync link.' }));
      if (!out.ok) throw new Error(out.error || 'Sync failed');
      for (const e of sentE) if (data.entries[e.id] && data.entries[e.id].t === e.t) delete data.dirty.entries[e.id];
      for (const k in sentS) if (data.settings[k] && data.settings[k].t === sentS[k].t) delete data.dirty.settings[k];
      const gotNews = B.merge(data, out);
      if (gotNews) rev++;
      saveData();
      device.lastSync = Date.now();
      device.syncError = '';
      if (gotNews) render(true);
    } catch (err) {
      device.syncError = err instanceof TypeError ? 'Couldn’t reach the sync link (offline?)' : err.message;
    } finally {
      syncBusy = false;
      saveDevice();
      paintSync();
      if (sheetName) keepSheetFresh();
      if (hasDirty()) scheduleSync(device.syncError ? 30000 : 1000);
    }
  }

  function paintSync() {
    const state = !device.syncUrl || !device.syncKey ? '' : syncBusy ? 'busy' : device.syncError ? 'error' : hasDirty() ? 'pending' : 'ok';
    $('#syncDot').className = 'dot ' + state;
  }
  function syncText() {
    if (!device.syncUrl) return 'Not connected. Only this phone has the data.';
    if (!device.syncKey) return 'Type the sync key to connect the two phones.';
    if (syncBusy) return 'Syncing…';
    if (device.syncError) return device.syncError;
    if (hasDirty()) return 'Waiting to sync';
    return device.lastSync ? 'Synced ' + ago(device.lastSync) : 'Not synced yet';
  }

  // ---------- events ----------
  document.addEventListener('touchstart', () => {}, { passive: true }); // lets :active styles show on iPhone

  let holdTimer = 0;
  $('#pad').addEventListener('pointerdown', ev => {
    const key = ev.target.closest('[data-k]');
    if (!key) return;
    ev.preventDefault();
    key.classList.add('down');
    setTimeout(() => key.classList.remove('down'), 110);
    press(key.dataset.k);
    // Hold ⌫ to clear the whole amount.
    if (key.dataset.k === 'del') holdTimer = setTimeout(() => { if (amount) { amount = ''; paintAmount(); buzz(20); } }, 500);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) $('#pad').addEventListener(type, () => clearTimeout(holdTimer));
  for (const btn of $$('.act')) btn.addEventListener('click', () => log(btn.dataset.method));

  $('#strip').addEventListener('click', ev => {
    if (!strip) return;
    const b = ev.target.closest('button');
    if (!b) return;
    const act = b.dataset.strip;
    if (act === 'undo') {
      const id = strip.id;
      hideStrip();
      setDeleted(id, true);
      toast('Undone');
    } else if (act === 'close') hideStrip();
    else if (act === 'back') { strip.mode = 'list'; paintStrip(); }
    else if (act === 'type') { strip.mode = 'type'; paintStrip(); }
    else if (act === 'save') noteDone($('#stripInput').value.trim());
    else if (b.dataset.sub) noteDone(strip.parent.name + ' · ' + b.dataset.sub);
    else if (b.dataset.note != null) {
      const n = quickNotes()[+b.dataset.note];
      if (!n) return;
      if (n.subs.length) { strip.mode = 'subs'; strip.parent = n; paintStrip(); }
      else noteDone(n.name);
    }
  });
  $('#strip').addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.target.id === 'stripInput') { ev.preventDefault(); noteDone(ev.target.value.trim()); }
    if (ev.key === 'Escape') hideStrip();
  });
  // While typing a note, keep the strip just above the on-screen keyboard.
  if (window.visualViewport) {
    const fit = () => document.documentElement.style.setProperty('--kb', Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop) + 'px');
    visualViewport.addEventListener('resize', fit);
    visualViewport.addEventListener('scroll', fit);
  }

  for (const btn of $$('main [data-sheet]')) btn.addEventListener('click', () => openSheet(btn.dataset.sheet));
  $('#settingsBtn').addEventListener('click', () => openSheet('settings'));
  $('#alerts').addEventListener('click', ev => {
    const x = ev.target.closest('[data-dismiss]'), open = ev.target.closest('[data-sheet]');
    if (x) {
      device.dismissed = Object.assign({}, device.dismissed, { [x.dataset.dismiss]: view.day });
      saveDevice();
      render(false);
    } else if (open) openSheet(open.dataset.sheet);
  });
  $('#whoChip').addEventListener('click', () => {
    device.owner = device.owner === '1' ? '2' : '1';
    saveDevice();
    render(false);
    buzz(10);
    toast('Logging as ' + view.cfg['name' + device.owner]);
  });

  $('.scrim').addEventListener('click', () => closeSheet());
  $('#sheetBody').addEventListener('click', ev => {
    const btn = ev.target.closest('[data-act]');
    if (btn) ACTIONS[btn.dataset.act](btn);
  });
  $('#sheetBody').addEventListener('change', ev => {
    selfEdit = true;
    try { onSheetChange(ev); } finally { selfEdit = false; }
  });
  function onSheetChange(ev) {
    const inp = ev.target;
    if (inp.dataset.key) {
      let key = inp.dataset.key, v = readInput(inp);
      // An open sheet built for another month (e.g. left open past midnight on the 31st) is rebuilt instead.
      const m = /:(\d{4}-\d{2})$/.exec(key);
      if (m && sheetStamp.split('|')[0].slice(0, 7) !== view.day.slice(0, 7)) { refreshSheet(); return; }
      // Starting numbers can be corrected but not emptied: an empty one would quietly rebuild the start month.
      const START = { startDate: 'date', startBank: 'bank', startCycleCard: 'cycleCard', startCycleUpi: 'cycleUpi', startBill: 'bill' };
      if (START[key] && v == null) { const cur = view.cfg.start[START[key]]; inp.value = cur == null ? '' : cur; return; }
      if ((key === 'statementDay' || key === 'dueDay') && v == null) { inp.value = key === 'statementDay' ? statementDayNow() : view.cfg.dueDay; return; }
      if (key === 'statementDay' || key === 'dueDay') { v = Math.min(31, Math.max(1, v)); inp.value = v; }
      if (key === 'statementDay') key = 'statementDay:' + view.day; // bills already made keep their dates
      if (key === 'safePct') { v = Math.min(100, Math.max(1, v || 30)); inp.value = v; }
      if (key === 'dailyCap') {
        const c = view.cfg.dailyCap;
        setSettings({ dailyCap: v ? { from: c ? c.from : B.shiftMonth(view.daily.month, 1), amount: v } : null });
        return;
      }
      if (key === 'emergencyGrowth') {
        const g = view.cfg.emergencyGrowth;
        const from = /^\d{4}-\d{2}$/.test(g.from) && g.from !== '9999-12' ? g.from : B.shiftMonth(view.daily.month, 1);
        setSettings({ emergencyGrowth: { from, amount: v == null ? 0 : v } });
        return;
      }
      // Editing this month only: keep next month's amount as it was.
      const pm = /^(emergency|salary1|salary2):(\d{4}-\d{2})$/.exec(key);
      if (pm && pm[2] === view.daily.month) {
        const nmk = B.shiftMonth(pm[2], 1);
        pinNextMonth(pm[1], pm[1] === 'emergency' ? B.emergencyFor(view.cfg, nmk) : B.salaryFor(view.cfg, nmk, pm[1] === 'salary1' ? 1 : 2));
      }
      setSettings({ [key]: v });
    } else if (inp.dataset.qn != null) {
      saveNotesFromEditor();
    } else if (inp.dataset.fixed) {
      // Rebuild the list from every row, so an unfinished new row (no amount yet) isn't lost.
      const now = B.fixedFor(view.cfg, editTarget());
      const list = Array.from($$('#sheetBody [data-field="name"]'), el => {
        const i = el.dataset.fixed, amt = $(`#sheetBody [data-fixed="${i}"][data-field="amount"]`);
        const n = B.parseMoney(amt.value);
        return { name: el.value.trim(), amount: n == null ? 0 : n, via: (now[i] && now[i].via) || 'bank' };
      });
      setFixed(list);
    } else if (inp.dataset.dev) {
      device[inp.dataset.dev] = inp.value.trim();
      device.syncError = '';
      saveDevice();
      scheduleSync(200);
    }
  }
  $('#sheetBody').addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || ev.target.tagName !== 'INPUT') return;
    if (ev.target.id === 'payAmount') ACTIONS.pay();
    else if (ev.target.id === 'noteInput') ACTIONS.noteSave();
    else ev.target.blur();
  });

  // A hardware keyboard works too: digits, Backspace, Enter/C for Card, U for UPI, B for Bank.
  document.addEventListener('keydown', ev => {
    if (sheetName) { if (ev.key === 'Escape') closeSheet(); return; }
    if (ev.target.tagName === 'INPUT') return;
    if (ev.key === 'Escape') { hideStrip(); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (/^\d$/.test(ev.key)) press(ev.key);
    else if (ev.key === 'Backspace') press('del');
    else if (ev.key === 'Enter' || ev.key === 'c') log('card');
    else if (ev.key === 'u') log('upi');
    else if (ev.key === 'b') log('bank');
    else return;
    ev.preventDefault();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    render(false);
    syncNow();
  });
  addEventListener('online', () => syncNow());
  setInterval(() => { if (view && B.today() !== view.day) render(false); }, 30000); // past midnight
  setInterval(() => { if (!document.hidden) syncNow(); }, 60000);

  // ---------- start ----------
  render(false);
  paintAmount();
  paintSync();
  syncNow();

  // Updates install themselves: each time the app is opened or brought back, it checks for a new
  // version; once that's downloaded it takes over and the page reloads onto it, but never while
  // an amount is being typed or a sheet is open (then it waits until the app is next put away).
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    let reloadPending = false;
    const reloadNow = () => { reloadPending = false; location.reload(); };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return; // first install: nothing old to replace
      if (!amount && !sheetName && !strip) reloadNow();
      else reloadPending = true;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && reloadPending) reloadNow();
      else if (!document.hidden) navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {});
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
})();
