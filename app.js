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
      startCycleCard: 11788, startCycleUpi: 9884, // card bill so far: 21,672.33, generated 19 Oct, due 8 Nov
      startBill: 0,
      cardLimit: 80000, safePct: 30,              // keep usage under 30% for the credit score
      'emergency:2026-11': 5000,                  // emergency fund from November
      fixed: [{ name: 'Hostel fees', amount: 14000 }, { name: 'Bike EMI', amount: 7280 }, { name: 'Wifi', amount: 489 }],
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
  function setSettings(pairs) {
    const t = Date.now();
    for (const k in pairs) {
      data.settings[k] = { v: pairs[k], t };
      data.dirty.settings[k] = true;
    }
    changed();
  }
  function changed() {
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
    $('#todayCard').classList.toggle('over', over);
    $('#todayCard').classList.toggle('warn', !over && frac >= 0.8);

    countTo($('#salaryLeft'), s.left, animate);
    $('#salaryLeft').classList.toggle('neg', s.left < 0);
    $('#salaryTotal').innerHTML = `salary <b>${money(s.total)}</b><br>${esc(cfg.name1)} <b>${money(s.s1)}</b> + ${esc(cfg.name2)} <b>${money(s.s2)}</b>`;

    countTo($('#cardOwed'), c.owed, animate);
    $('#cardDue').textContent = c.bill.overdue ? 'Overdue since ' + fmtDate(c.bill.due) : 'Due ' + fmtDate(c.next.date) + ' · ' + inDays(c.next.inDays);
    $('#cardTile').classList.toggle('alert', c.bill.overdue);
    const u = c.util, uFrac = u.safe ? u.used / u.safe : 0;
    $('#utilBar').parentNode.hidden = $('#cardUtil').hidden = !u.limit;
    $('#utilBar').style.width = Math.min(1, uFrac) * 100 + '%';
    $('#utilBar').className = uFrac > 1 ? 'bad' : uFrac >= 0.8 ? 'warn' : '';
    $('#cardUtil').textContent = `${pctText(u)} of limit · ` + (u.room >= 0 ? `${money(u.room)} to ${u.safePct}%` : `${money(-u.room)} over ${u.safePct}%`);
    countTo($('#emerg'), s.emergency, animate);

    countTo($('#cycleCard'), c.cycle.card, animate);
    countTo($('#cycleUpi'), c.cycle.upi, animate);
    countTo($('#monthBank'), s.bank, animate);
    $('#whoChip').textContent = cfg['name' + device.owner];
    paintAlerts(B.alerts(view, day), day);

    if (sheetName) updateCalcs();
  }

  // "₹7,328 ÷ 16 days = ₹458 a day": the money left this month spread over the days left.
  function breakdownHTML(d) {
    return `<b>${money(d.pool)}</b> ÷ ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'} = <b>${money(d.limit)}</b> a day`;
  }

  // Warnings at the top. ✕ hides one until tomorrow; tapping it opens the matching sheet.
  function alertText(a) {
    if (a.id === 'card-overdue') return `Card bill ${money(a.amount)} overdue by ${a.days} day${a.days === 1 ? '' : 's'}`;
    if (a.id === 'card-due') return `Card bill ${money(a.amount)} due ${inDays(a.days)} (${fmtDate(a.date)})`;
    if (a.id === 'card-util') return `Card at ${pctText({ pct: a.pct, room: -1 })} of limit: pay ${money(a.amount)} to get back under ${a.safePct}%`;
    if (a.id === 'over-today') return `Over today’s limit by ${money(a.amount)}`;
    return `This month’s money is used up: ${money(a.amount)} over`;
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
    toast(msg, () => { setDeleted(e.id, true); toast('Undone'); });
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
    const pill = e.type === 'pay' ? '<i class="pill pay">Paid</i>' : `<i class="pill ${METHOD[e.method] ? e.method : 'card'}">${METHOD[e.method] || 'Card'}</i>`;
    const when = (e.type === 'pay' ? fmtDate(e.date) + ', ' : '') + timeOf(e.ts);
    return `<li>${pill}<span class="meta">${when} · ${esc(name)}</span><b>${money(e.amount)}</b><button class="del" type="button" data-act="del" data-id="${esc(e.id)}" aria-label="Delete">✕</button></li>`;
  }

  function dayBlock(h, list, isToday) {
    const tag = `<span class="tag ${h.left < 0 ? 'neg' : 'pos'}">${h.left < 0 ? money(h.left) : '+' + money(h.left)}</span>`;
    const items = list.length ? list.map(entryRow).join('') : '<li class="empty-note">No spends</li>';
    return `<details${isToday ? ' open' : ''}><summary><span class="d">${isToday ? 'Today' : fmtDate(h.date, true)}</span><span class="num">${money(h.spent)} of ${money(h.available)}</span>${tag}</summary><ul class="list">${items}</ul></details>`;
  }

  const live = type => Object.values(data.entries).filter(e => !e.deleted && e.type === type);

  const SHEETS = {
    today() {
      const d = view.daily, mk = d.month;
      const byDay = {};
      for (const e of live('spend')) if (B.monthOf(e.date) === mk) (byDay[e.date] = byDay[e.date] || []).push(e);
      const days = d.history.map(h => dayBlock(h, (byDay[h.date] || []).sort((a, b) => b.ts - a.ts), h.date === view.day)).join('');
      return head('Daily limit') + `
        <div class="group">
          <div class="row"><span>Left today</span><b class="big">${calc('todayLeft')}</b></div>
          <div class="row"><span>Today’s limit</span>${calc('todayAvail', 'num')}</div>
          <div class="row"><span>Tomorrow (if nothing more today)</span>${calc('tomorrow', 'num')}</div>
        </div>
        <p class="note">Each morning: money left this month ÷ days left. Money left is the bank balance minus Card and UPI spends not paid off yet, after keeping the emergency fund aside. Spend less and the coming days get a little more; spend more and they get a little less.</p>
        <h3>${monthName(mk)} so far</h3>
        <div class="group days">${days}</div>`;
    },

    salary() {
      const cfg = view.cfg, s = view.salary, nmk = B.shiftMonth(view.daily.month, 1);
      const fixedRows = cfg.fixed.map((f, i) => `<div class="field fixed-row">
          <input class="text" type="text" data-fixed="${i}" data-field="name" value="${esc(f.name)}" placeholder="Name" autocomplete="off">
          <span class="money-in"><input type="text" inputmode="numeric" pattern="[0-9]*" data-fixed="${i}" data-field="amount" value="${esc(f.amount)}" placeholder="0" autocomplete="off"></span>
          <button class="del" type="button" data-act="fixedDel" data-i="${i}" aria-label="Remove">✕</button></div>`).join('');
      return head('Bank balance') + `
        <div class="group">
          ${s.inStart
            ? `<div class="row"><span>In the bank on ${fmtDate(s.startDate)}</span>${calc('salOpening', 'num')}</div>`
            : `<div class="row"><span>Left over from ${monthName(B.shiftMonth(view.daily.month, -1))}</span>${calc('salCarried', 'num')}</div>
               <div class="row"><span>Combined salary</span>${calc('salTotal', 'num')}</div>
               <div class="row"><span>Fixed costs</span>${calc('salFixed', 'num neg')}</div>`}
          <div class="row"><span>Bank spends this month</span>${calc('salBank', 'num neg')}</div>
          <div class="row small">${calc('salWho')}</div>
          <div class="row"><span>Card bills paid this month</span>${calc('salPaid', 'num neg')}</div>
          <div class="row"><span>Emergency set aside</span>${calc('salEmerg', 'num neg')}</div>
          <div class="row total"><span>Bank balance</span><b class="big">${calc('salLeft')}</b></div>
        </div>
        <p class="note">Card and UPI spends (${calc('salOnCard')} this month) leave the bank when you pay the card bill, so they come off here only then.</p>
        <h3>Salaries</h3>
        <div class="group">${textField('Name', 'name1', cfg.name1)}${moneyField('Salary', 'salary1', cfg.salary1)}</div>
        <div class="group">${textField('Name', 'name2', cfg.name2)}${moneyField('Salary', 'salary2', cfg.salary2)}</div>
        <h3>Fixed monthly costs</h3>
        <div class="group">
          ${fixedRows || '<p class="empty-note">None yet</p>'}
          <div class="row total"><span>Total, taken off on the 1st</span><b class="num">${calc('fixedTotal')}</b></div>
        </div>
        <button class="btn ghost wide" type="button" data-act="fixedAdd">Add a fixed cost</button>
        <p class="note">From ${monthName(nmk)}, each month starts from what’s left in the bank plus both salaries, minus these, so don’t log them as Bank spends too.${s.inStart ? ' This month runs on the bank balance you started with.' : ''}</p>`;
    },

    card() {
      const cfg = view.cfg;
      const pays = live('pay').sort((a, b) => b.ts - a.ts);
      return head('Credit card') + `
        <div class="group"><div class="row"><span>Total owed</span><b class="big">${calc('cardOwed')}</b></div></div>
        <div class="group">
          <h4>Last bill · due ${calc('billDue')}</h4>
          <div class="row"><span>${calc('billState')}</span><b class="num">${calc('billLeft')}</b></div>
        </div>
        <div class="group">
          <h4>This cycle · ${calc('cycleRange')}</h4>
          <div class="row"><span><i class="pill card">Card</i></span>${calc('cycCard', 'num')}</div>
          <div class="row"><span><i class="pill upi">UPI on card</i></span>${calc('cycUpi', 'num')}</div>
          <div class="row total"><span>Bill due ${calc('cycDue')}</span><b class="num">${calc('cycTotal')}</b></div>
        </div>
        <h3>Record a bill payment</h3>
        <div class="group">
          <div class="pay-row"><input id="payAmount" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="₹ amount paid" autocomplete="off"><button class="btn small" type="button" data-act="pay">Paid</button></div>
          ${pays.length ? `<ul class="list" style="margin-top:8px">${pays.map(entryRow).join('')}</ul>` : ''}
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
          ${dayField('Statement day', 'statementDay', cfg.statementDay, 'new cycle starts')}
          ${dayField('Due day', 'dueDay', cfg.dueDay, 'pay the bill by')}
        </div>`;
    },

    emergency() {
      const cfg = view.cfg, mk = view.daily.month, nmk = B.shiftMonth(mk, 1);
      return head('Emergency fund') + `
        <div class="group">
          ${moneyField(monthName(mk), 'emergency:' + mk, B.emergencyFor(cfg, mk))}
          ${moneyField(monthName(nmk) + ' onwards', 'emergency:' + nmk, B.emergencyFor(cfg, nmk))}
        </div>
        <p class="note">Kept aside: taken out of the bank balance and the money the daily limit is worked out from.</p>`;
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
    todayAvail: v => `${money(v.daily.pool)} ÷ ${v.daily.daysLeft} = ${money(v.daily.limit)}`,
    tomorrow: v => {
      const t = v.daily.tomorrow;
      return (t.fresh ? 'new month: ' : '') + `${money(t.pool)} ÷ ${t.daysLeft} = ${money(t.limit)}`;
    },
    salTotal: v => money(v.salary.total),
    salOpening: v => money(v.salary.opening),
    salCarried: v => money(v.salary.carried),
    salFixed: v => money(-v.salary.fixed),
    fixedTotal: v => money(v.cfg.fixed.reduce((n, f) => n + f.amount, 0)),
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
      if (c.bill.overdue) return `Overdue by ${c.bill.lateBy} day${c.bill.lateBy === 1 ? '' : 's'}`;
      if (c.bill.left > 0) return 'Left to pay · due ' + inDays(c.next.inDays);
      return c.credit ? `Paid · ${money(c.credit)} extra` : 'Paid ✓';
    },
    billLeft: v => money(v.card.bill.left),
    cycleRange: v => fmtDate(v.card.cycle.start) + ' – ' + fmtDate(v.card.cycle.end),
    cycCard: v => money(v.card.cycle.card),
    cycUpi: v => money(v.card.cycle.upi),
    cycDue: v => fmtDate(v.card.cycle.due),
    cycTotal: v => money(v.card.cycle.total),
    utilUsed: v => `${money(v.card.util.used)} · ${pctText(v.card.util)}`,
    utilRoom: v => money(v.card.util.room),
    syncStatus: () => syncText(),
  };
  function updateCalcs() {
    for (const el of $$('#sheetBody [data-calc]')) el.textContent = CALC[el.dataset.calc](view);
  }

  function openSheet(name) {
    sheetName = name;
    $('#sheetBody').innerHTML = SHEETS[name]();
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
    const open = Array.from($$('#sheetBody details'), el => el.open);
    $('#sheetBody').innerHTML = SHEETS[sheetName]();
    $$('#sheetBody details').forEach((el, i) => { if (open[i] != null) el.open = open[i]; });
    updateCalcs();
    sheet.scrollTop = top;
  }

  function readInput(inp) {
    const raw = inp.value.trim();
    if (inp.dataset.type === 'text') return raw || null;
    if (raw === '') return null;
    const n = Math.round(Number(raw.replace(/[^\d.-]/g, '')));
    if (!Number.isFinite(n)) return null;
    return inp.dataset.signed ? n : Math.abs(n);
  }

  const ACTIONS = {
    close: () => closeSheet(),
    fixedAdd() {
      setSettings({ fixed: view.cfg.fixed.concat({ name: '', amount: 0 }) });
      refreshSheet();
      const rows = $$('#sheetBody [data-field="name"]');
      if (rows.length) rows[rows.length - 1].focus();
    },
    fixedDel(btn) {
      setSettings({ fixed: view.cfg.fixed.filter((f, i) => i !== +btn.dataset.i) });
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
      const n = Number(input.value.replace(/\D/g, ''));
      if (!n) { restartAnim(input, 'shake'); return; }
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
      if (sheetName) updateCalcs();
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
    const inp = ev.target;
    if (inp.dataset.key) {
      let v = readInput(inp);
      if (inp.dataset.key === 'statementDay' || inp.dataset.key === 'dueDay') { v = Math.min(31, Math.max(1, v || 1)); inp.value = v; }
      if (inp.dataset.key === 'safePct') { v = Math.min(100, Math.max(1, v || 30)); inp.value = v; }
      setSettings({ [inp.dataset.key]: v });
    } else if (inp.dataset.fixed) {
      // Rebuild the list from every row, so an unfinished new row (no amount yet) isn't lost.
      const list = Array.from($$('#sheetBody [data-field="name"]'), el => {
        const amt = $(`#sheetBody [data-fixed="${el.dataset.fixed}"][data-field="amount"]`);
        return { name: el.value.trim(), amount: Math.abs(Math.round(Number(amt.value.replace(/[^\d]/g, '')) || 0)) };
      });
      setSettings({ fixed: list });
    } else if (inp.dataset.dev) {
      device[inp.dataset.dev] = inp.value.trim();
      device.syncError = '';
      saveDevice();
      scheduleSync(200);
    }
  });
  $('#sheetBody').addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || ev.target.tagName !== 'INPUT') return;
    if (ev.target.id === 'payAmount') ACTIONS.pay();
    else ev.target.blur();
  });

  // A hardware keyboard works too: digits, Backspace, Enter/C for Card, U for UPI, B for Bank.
  document.addEventListener('keydown', ev => {
    if (sheetName) { if (ev.key === 'Escape') closeSheet(); return; }
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

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
})();
