/* LavishTracker Ask: answers money questions typed in plain words, typos and all. No AI and nothing
   leaves the phone: a small parser picks out the amount, the time and what's being asked, and budget.js
   does the maths with the same rules as the rest of the app. Pure functions, no DOM; loaded by the app
   (as window.Ask) and by the node tests (via require). */
(function (root) {
  'use strict';

  // ---------- words ----------
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  // Shorthand people type, mapped to the word it stands for.
  const SHORT = {
    nxt: 'next', nex: 'next', tmrw: 'tomorrow', tmr: 'tomorrow', tmrow: 'tomorrow', tomo: 'tomorrow', tdy: 'today', tday: 'today',
    mnth: 'month', mth: 'month', mnths: 'months', mths: 'months', yr: 'year', yrs: 'years', wk: 'week', wks: 'weeks',
    shud: 'should', shld: 'should', wat: 'what', wht: 'what', whats: 'what', hw: 'how', u: 'you', r: 'are', ur: 'your',
    bil: 'bill', crd: 'card', bnk: 'bank', sav: 'save', svng: 'saving', thousands: 'thousand', lac: 'lakh', lacs: 'lakh', lakhs: 'lakh',
    rupees: 'rs', rupee: 'rs', inr: 'rs', bucks: 'rs', tues: 'tue', thur: 'thu', thurs: 'thu', sept: 'sep',
  };
  const SAVE_W = ['save', 'saving', 'savings', 'saved', 'goal', 'aside', 'collect', 'accumulate'];
  const BUY_W = ['buy', 'buying', 'afford', 'purchase', 'get'];
  const SPEND_W = ['spend', 'spending', 'spent', 'buy', 'buying', 'afford', 'purchase', 'pay', 'paying', 'trip', 'travel', 'shopping', 'shop', 'order', 'splurge', 'go', 'get', 'use'];
  const NEED_W = ['should', 'need', 'must', 'want', 'plan', 'target', 'require'];
  const TOPICS = {
    card: ['card', 'credit', 'bill', 'bills', 'due', 'owe', 'owed', 'outstanding', 'statement', 'upi', 'utilisation', 'utilization'],
    bank: ['bank', 'balance', 'account', 'accounts'],
    emergency: ['emergency', 'fund', 'funds'],
    plan: ['salary', 'salaries', 'income', 'fixed', 'emi', 'emis', 'wifi', 'hostel', 'rent'],
    limit: ['limit', 'limits', 'daily', 'left', 'remaining', 'budget', 'allowance'],
  };
  const QUESTION_W = ['how', 'what', 'when', 'can', 'could', 'should', 'much', 'help', 'hi', 'hello', 'hey'];
  const ARTICLES = ['a', 'an', 'the', 'my', 'our', 'new', 'some', 'this', 'that'];
  const MULT = { k: 1e3, thousand: 1e3, l: 1e5, lakh: 1e5, crore: 1e7, cr: 1e7 };
  const ORDINAL = ['st', 'nd', 'rd', 'th'];

  // Edit distance, counting two swapped letters as one slip ("toady" → today).
  function dist(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; for (let j = 1; j <= b.length; j++) d[i][j] = i ? 0 : j; }
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }
  // A typed word matches a word we know when it's the same, or one slip away for words of 5+ letters
  // (two for 8+): "spnd" → spend, "limt" → limit, "emergancy" → emergency. Slips almost never hit the first
  // letter, and requiring it keeps real words apart ("having" isn't "saving").
  const like = (w, k) => w === k || (k.length >= 5 && w.length >= 4 && w[0] === k[0] && !/\d/.test(w) && dist(w, k) <= (k.length >= 8 ? 2 : 1));

  // ---------- dates ----------
  const pad = n => String(n).padStart(2, '0');
  const ym = (y, m) => { while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return y + '-' + pad(m); };
  const shift = (mk, n) => ym(+mk.slice(0, 4), +mk.slice(5, 7) + n);
  const monthsFrom = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
  const daysIn = mk => new Date(Date.UTC(+mk.slice(0, 4), +mk.slice(5, 7), 0)).getUTCDate();
  const addDays = (s, n) => { const t = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + n)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); };
  const weekday = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))).getUTCDay();

  // ---------- reading a question ----------
  function tokens(text) {
    let s = ' ' + String(text == null ? '' : text).toLowerCase() + ' ';
    s = s.replace(/₹/g, ' rs ').replace(/[’'`]/g, '').replace(/(\d),(?=\d)/g, '$1')
      .replace(/\b2day\b/g, 'today').replace(/\b2morrow\b/g, 'tomorrow')
      .replace(/\brs\.?(?=\d)/g, 'rs ')
      .replace(/(\d)\s*(k|l|lakhs?|lacs?|cr|crore|rs|st|nd|rd|th)\b/g, '$1 $2');
    return (s.match(/\d+(?:\.\d+)?|[a-z]+/g) || []).map(w => ({ w: SHORT[w] || w, used: false }));
  }
  // Which month a word names, if any. "may" only counts next to a date word ("in may", "may 5").
  function monthIndex(T, i) {
    if (!T[i]) return -1;
    const w = T[i].w;
    if (w.length < 3 || /\d/.test(w)) return -1;
    for (let m = 0; m < 12; m++) {
      const name = MONTHS[m];
      if (name === 'may') {
        if (w !== 'may') continue;
        const p = T[i - 1] && T[i - 1].w, n = T[i + 1] && T[i + 1].w;
        if (['in', 'by', 'on', 'till', 'until', 'before', 'next', 'this', 'of', 'from', 'during', 'end'].includes(p) || /^\d+$/.test(p || '') || /^\d+$/.test(n || '')) return m;
        continue;
      }
      // Short names only by their start ("dec", "sept"), so "match" never reads as March.
      if (name.startsWith(w) || (name.length >= 7 && like(w, name))) return m;
    }
    return -1;
  }
  const weekdayIndex = w => WEEKDAYS.findIndex(d => w === d || (w.length >= 3 && d.startsWith(w) && w !== 'sun' && w !== 'sat' && w !== 'wed') || like(w, d));

  // Finds the first time the question mentions. Returns { type: 'day', date } or { type: 'month', month },
  // or { vague } for "next year"; `by` marks a deadline ("by June", "in 6 months"); `named` a month said by name.
  function findTime(T, today) {
    const cur = today.slice(0, 7), dayNo = +today.slice(8, 10);
    const w = i => (T[i] ? T[i].w : '');
    const use = (...ix) => ix.forEach(i => { if (T[i]) T[i].used = true; });
    const isNum = i => /^\d+$/.test(w(i));
    const count = i => (isNum(i) ? +w(i) : ['a', 'an', 'one'].includes(w(i)) ? 1 : null);
    const deadline = i => ['by', 'before', 'till', 'until', 'within'].includes(w(i));
    for (let i = 0; i < T.length; i++) {
      const x = w(i);
      if (x === 'today' || x === 'tonight' || x === 'now') { use(i); return { type: 'day', date: today, by: deadline(i - 1) }; }
      if (x === 'tomorrow') {
        const after = w(i - 1) === 'after' && w(i - 2) === 'day';
        use(i, after && i - 1, after && i - 2);
        return { type: 'day', date: addDays(today, after ? 2 : 1), by: deadline(i - (after ? 3 : 1)) };
      }
      if (x === 'weekend' || weekdayIndex(x) >= 0) {
        const target = x === 'weekend' ? 6 : weekdayIndex(x), wd = weekday(today);
        let ahead = (target - wd + 7) % 7;
        if (x === 'weekend' && wd === 0) ahead = 0; // it's Sunday: this weekend is today
        if (w(i - 1) === 'next' && ahead < 7 && x !== 'weekend') ahead += ahead === 0 ? 7 : 0;
        use(i); return { type: 'day', date: addDays(today, ahead), by: deadline(i - 1) };
      }
      if (x === 'week' || x === 'weeks') {
        const n = count(i - 1);
        if (w(i - 1) === 'next') { use(i - 1, i); return { type: 'day', date: addDays(today, 7) }; }
        if (w(i - 1) === 'this') { use(i - 1, i); return { type: 'month', month: cur }; }
        if (n != null) { use(i - 1, i); return { type: 'day', date: addDays(today, 7 * n), by: true }; }
      }
      if (x === 'month' || x === 'months') {
        const n = count(i - 1);
        const endOf = (w(i - 1) === 'the' && w(i - 2) === 'of' && w(i - 3) === 'end') || (w(i - 1) === 'of' && w(i - 2) === 'end');
        if (w(i - 1) === 'this' || endOf) { use(i - 1, i); return { type: 'month', month: cur, by: deadline(i - 2) || endOf }; }
        if (w(i + 1) === 'after' && w(i + 2) === 'next') { use(i, i + 1, i + 2); return { type: 'month', month: shift(cur, 2) }; }
        if (w(i - 1) === 'next' || w(i - 1) === 'coming') { use(i - 1, i); return { type: 'month', month: shift(cur, 1), by: deadline(i - 2) }; }
        if (n != null) { use(i - 1, i); return { type: 'month', month: shift(cur, n), by: true }; }
      }
      if (x === 'year' || x === 'years') {
        const n = count(i - 1);
        if (w(i - 2) === 'of' && w(i - 3) === 'end' && ['the', 'this'].includes(w(i - 1))) { use(i - 1, i); return { type: 'month', month: cur.slice(0, 4) + '-12', by: true }; }
        if (w(i - 1) === 'next' || w(i - 1) === 'this' || w(i - 1) === 'coming') { use(i - 1, i); return { vague: w(i - 1) === 'this' ? 'this year' : 'next year', by: true }; }
        if (n != null) { use(i - 1, i); return { type: 'month', month: shift(cur, 12 * n), by: true }; }
      }
      const m = monthIndex(T, i);
      if (m >= 0) {
        // A day of the month before or after it ("20 dec", "20th of december", "dec 20"), and a year after it.
        let day = null, year = null;
        const before = w(i - 1) === 'of' ? i - 2 : i - 1, beforeNum = ORDINAL.includes(w(before)) ? before - 1 : before;
        if (isNum(beforeNum) && +w(beforeNum) >= 1 && +w(beforeNum) <= 31) { day = +w(beforeNum); use(beforeNum, beforeNum + 1, before + 1 === i ? null : before + 1); }
        let j = i + 1;
        if (day == null && isNum(j) && +w(j) >= 1 && +w(j) <= 31) { day = +w(j); use(j); j++; if (ORDINAL.includes(w(j))) { use(j); j++; } }
        if (isNum(j) && +w(j) >= 2020 && +w(j) <= 2099) { year = +w(j); use(j); }
        use(i);
        const named = ym(year || +cur.slice(0, 4), m + 1);
        let month = named;
        if (!year && (month < cur || (w(i - 1) === 'next' && month <= cur))) month = shift(month, 12);
        if (w(i - 1) === 'next') use(i - 1);
        const by = deadline(i - 1) || deadline(i - 2);
        if (day) return { type: 'day', date: month + '-' + pad(Math.min(day, daysIn(month))), named: true, by, explicitYear: !!year };
        return { type: 'month', month, named: true, by, explicitYear: !!year || w(i - 1) === 'next' };
      }
      // "in 2027": a year, but not which month of it.
      if (isNum(i) && +x >= 2020 && +x <= 2099 && ['in', 'by', 'during', 'before', 'till', 'until'].includes(w(i - 1))) { use(i); return { vague: x, by: true }; }
      // "on the 20th": a day of this month (or next month, if it's already gone).
      const monthNext = monthIndex(T, i + 2) >= 0 || (w(i + 2) === 'of' && monthIndex(T, i + 3) >= 0);
      if (isNum(i) && ORDINAL.includes(w(i + 1)) && +x >= 1 && +x <= 31 && !monthNext) { // "20th of december" is the month's
        use(i, i + 1);
        const month = +x >= dayNo ? cur : shift(cur, 1);
        return { type: 'day', date: month + '-' + pad(Math.min(+x, daysIn(month))), by: deadline(i - 1) || deadline(i - 2) };
      }
    }
    return null;
  }

  // The amount: one marked as money ("₹2,000", "80k", "1.2 lakh", "500 rs") wins, else the biggest number.
  function findAmount(T) {
    let best = null;
    for (let i = 0; i < T.length; i++) {
      if (T[i].used || !/^\d+(\.\d+)?$/.test(T[i].w)) continue;
      const next = T[i + 1] ? T[i + 1].w : '', prev = T[i - 1] ? T[i - 1].w : '';
      const mult = MULT[next] || 1, marked = mult > 1 || next === 'rs' || prev === 'rs';
      const value = Math.round(+T[i].w * mult * 100) / 100;
      if (!value) continue;
      if (!best || (marked && !best.marked) || (marked === best.marked && value > best.value)) best = { value, marked, i };
    }
    if (best) { T[best.i].used = true; return best.value; }
    return null;
  }

  // What it's for, in the asker's words: "for a trip" → trip, "buy an iphone" → iphone.
  function findLabel(T) {
    const stop = new Set(['of', 'for', 'worth', 'costing', 'cost', 'costs', 'price', 'by', 'in', 'on', 'at', 'next', 'this', 'today', 'tomorrow',
      'rs', 'k', 'lakh', 'and', 'with', 'me', 'us', 'i', 'we', 'it', 'which', 'that', 'is', 'will', 'would', 'can', 'month', 'months', 'year', 'years', 'week', 'within', 'before', 'till', 'until', 'then', 'now', 'so', 'how', 'much', 'should', 'to']);
    for (let i = 0; i < T.length; i++) {
      if (!['for', 'on', 'buy', 'buying', 'get', 'afford', 'towards', 'toward'].includes(T[i].w)) continue;
      let j = i + 1;
      while (T[j] && ARTICLES.includes(T[j].w)) j++;
      const words = [];
      while (T[j] && words.length < 3 && !T[j].used && /^[a-z]+$/.test(T[j].w) && !stop.has(T[j].w) && monthIndex(T, j) < 0) { words.push(T[j].w); j++; }
      if (words.length && !SPEND_W.concat(SAVE_W).includes(words[0]) || (words.length && words[0] === 'trip')) return words.join(' ');
    }
    return null;
  }

  function parse(text, today) {
    const T = tokens(text), cur = today.slice(0, 7);
    const time = findTime(T, today);
    const amount = findAmount(T);
    const has = list => T.some(t => list.some(k => like(t.w, k)));
    const word = list => T.some(t => list.includes(t.w));
    const saveW = has(SAVE_W), buyW = has(BUY_W), spendW = has(SPEND_W);
    let topic = null;
    for (const k of ['card', 'bank', 'emergency', 'plan', 'limit']) if (has(TOPICS[k])) { topic = k; break; }
    const longTime = time && (time.by || time.vague);
    // A bare "december" or "2k" (no question words) can be the answer to "When?" or "How much?".
    const explicit = saveW || spendW || !!topic || has(QUESTION_W) || T.length > 5;
    let intent;
    if (saveW && (amount || longTime || has(NEED_W) || buyW)) intent = 'save';
    // An amount with a deadline is a goal ("iphone for 80k by June"), unless it's clearly a spend.
    else if (amount && longTime && (buyW || !has(['spend', 'spending', 'trip', 'travel', 'shopping', 'splurge', 'pay']))) intent = 'save';
    else if (amount) intent = 'spend';
    else if (saveW) { intent = 'status'; topic = 'emergency'; }
    else if (spendW && word(['how']) && word(['much'])) { intent = 'status'; topic = 'limit'; }
    else if (spendW && time && topic !== 'card') intent = 'spend';
    else if (topic) intent = 'status';
    else if (time) { intent = 'status'; topic = 'limit'; }
    else intent = 'help';
    const q = { text: String(text || ''), today, cur, intent, topic, amount, time, label: findLabel(T), explicit };
    return settle(q);
  }
  // Fills `when` (a spend: a day or a month) and `by` (a saving: the month to have it by) from the time said.
  function settle(q) {
    const t = q.time;
    q.when = t && !t.vague ? t : null;
    q.by = null;
    if (q.intent === 'save' && t && !t.vague) {
      let by = t.type === 'day' ? t.date.slice(0, 7) : t.month;
      // "by November", said in November: next November.
      if (t.named && !t.explicitYear && by <= q.cur) by = shift(by, 12);
      q.by = by;
    }
    return q;
  }
  // A tapped option ("December", "6 months") fills in the question that asked for it.
  const choose = (pending, set) => settle(Object.assign({}, pending, set));
  // An answer to "How much?" or "When?" fills the question that asked it; anything else is a new question.
  function follow(pending, q) {
    if (!pending || q.explicit) return q;
    if (q.amount == null && !q.time) return q;
    const out = Object.assign({}, pending, { text: q.text });
    if (q.amount != null) out.amount = q.amount;
    if (q.time) out.time = q.time;
    return settle(out);
  }

  // ---------- answering ----------
  // Whole rupees as ₹500; amounts with paise as ₹99.50.
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = n => {
    const v = Math.round(n * 100) / 100, a = Math.abs(v);
    return (v < 0 ? '−₹' : '₹') + (a % 1 ? inr2.format(a) : inr.format(a));
  };
  const NAMES = MONTHS.map(m => m[0].toUpperCase() + m.slice(1));
  const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

  function answer(q, c) {
    const out = q.intent === 'save' ? save(q, c) : q.intent === 'spend' ? spend(q, c) : q.intent === 'status' ? status(q, c) : help(c);
    // figures: the numbers behind the words (for the tests).
    return Object.assign({ verdict: null, text: [], lines: [], note: '', options: [], chips: [], pending: null, figures: {} }, out);
  }

  // Month and day names, with the year only when it isn't this year.
  function namer(today) {
    const year = today.slice(0, 4);
    const month = mk => NAMES[+mk.slice(5, 7) - 1] + (mk.slice(0, 4) !== year ? ' ' + mk.slice(0, 4) : '');
    const day = d => +d.slice(8, 10) + ' ' + NAMES[+d.slice(5, 7) - 1].slice(0, 3) + (d.slice(0, 4) !== year ? ' ' + d.slice(0, 4) : '');
    // "January to November 2027", "December to November 2027".
    const span = (a, b) => (a.slice(0, 4) === b.slice(0, 4) ? NAMES[+a.slice(5, 7) - 1] : month(a)) + ' to ' + month(b);
    return { month, day, span };
  }
  const inDays = n => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days');

  // Yes or No against the floor: No when the daily limit would drop below it (or the money runs out).
  function verdict(after, floor, what) {
    if (after < 0) return { verdict: 'no', reason: `${what} doesn't have that much to spare: its money would run out.` };
    if (after < floor) return { verdict: 'no', reason: `That takes ${what}'s daily limit below ${money(floor)}.` };
    return { verdict: 'yes', reason: '' };
  }

  function whenOptions(c) {
    const N = namer(c.today), d = c.r.daily, cur = d.month, opts = [{ label: 'Today', set: { time: { type: 'day', date: c.today } } }];
    if (d.daysLeft > 1) opts.push({ label: 'Later in ' + N.month(cur), set: { time: { type: 'month', month: cur } } });
    for (let k = 1; k <= 3; k++) opts.push({ label: N.month(shift(cur, k)), set: { time: { type: 'month', month: shift(cur, k) } } });
    return opts;
  }
  function byOptions(c) {
    const N = namer(c.today), first = shift(c.r.daily.month, 1);
    return [3, 6, 12, 18].map(k => ({ label: `${N.month(shift(first, k - 1))} (${k} months)`, set: { time: { type: 'month', month: shift(first, k - 1) } } }));
  }

  function spend(q, c) {
    const B = c.B, r = c.r, d = r.daily, X = q.amount, F = c.floor, N = namer(c.today);
    if (!X) return { text: ['How much is it? Type the amount, like 2000 or 2k.'], pending: q };
    if (!q.when) return { text: ['When would you spend it?'], options: whenOptions(c), pending: q };
    const mk = q.when.type === 'day' ? q.when.date.slice(0, 7) : q.when.month;
    if (q.when.type === 'day' && q.when.date < c.today) return { text: ['That day has already gone. Ask about today or a day ahead.'] };
    const M = N.month(d.month);
    if (mk === d.month) {
      const n = d.daysLeft - 1, onToday = q.when.type === 'day' && q.when.date === c.today, left = Math.max(0, d.left);
      if ((onToday || n === 0) && X <= left) {
        return { verdict: 'yes', text: [`**${money(X)}** fits in what's left today (${money(d.left)}). The rest of ${M} doesn't change.`], lines: [['Left today after it', money(d.left - X)]], figures: { leftAfter: d.left - X } };
      }
      if (n === 0) { // the last day of the month: whatever goes over comes out of next month
        const over = X - left, nk = d.nextMonth.month, before = d.nextMonth.fullUse;
        const after = B.project(r.cfg, r.entries, nk, d.nextMonth.toSpend + over), v = verdict(after.limit, F, N.month(nk));
        return { verdict: v.verdict, text: [v.reason, `Today is the last day of ${M}, so ${money(over)} comes out of ${N.month(nk)}: **${money(after.limit)} a day** instead of ${money(before.limit)}.`].filter(Boolean), figures: { month: nk, before: before.limit, after: after.limit } };
      }
      const rest = d.endOfToday - left; // planned money for the days after today
      const take = onToday ? X - left : X, before = Math.floor(rest / n), after = Math.floor((rest - take) / n);
      const v = verdict(after, F, 'the rest of ' + M);
      if (after < 0) return { verdict: 'no', text: [`The rest of ${M} only has ${money(rest + left)} (${money(before)} a day), so ${money(X)} would leave nothing for the other days.`], figures: { days: n, before, after } };
      const said = onToday
        ? `${left ? `Today has ${money(left)} left, so the other` : 'Nothing is left today, so all'} **${money(take)}** comes off the coming days (it shows as carry from tomorrow).`
        : `${money(X)}${q.when.type === 'day' ? ' on ' + N.day(q.when.date) : ''} comes off the rest of ${M}.`;
      return {
        verdict: v.verdict, text: [v.reason, said, `The next ${plural(n, 'day')} average **${money(after)} a day** instead of ${money(before)}.`].filter(Boolean),
        figures: { days: n, before, after },
      };
    }
    const months = B.ahead(r.cfg, r.entries, d, mk), m = months[months.length - 1];
    const room = m.set ? m.set * m.days : m.pool, after = Math.floor((room - X) / m.days), v = verdict(after, F, N.month(mk));
    const note = `If ${months.length === 1 ? M : 'every month until then'} sticks to its daily limit.`;
    if (after < 0) return { verdict: 'no', text: [`${N.month(mk)} only has ${money(room)} for the whole month (${money(m.limit)} a day), so ${money(X)} would leave nothing for its other days.`], note, figures: { month: mk, before: m.limit, after } };
    return {
      verdict: v.verdict,
      text: [v.reason, `${N.month(mk)} would have **${money(after)} a day** instead of ${money(m.limit)}: the ${money(X)}${q.when.type === 'day' ? ' on ' + N.day(q.when.date) : ''} comes off its other days.`].filter(Boolean),
      note, figures: { month: mk, before: m.limit, after },
    };
  }

  function save(q, c) {
    const B = c.B, r = c.r, d = r.daily, X = q.amount, F = c.floor, N = namer(c.today);
    if (!X) return { text: ['How much does it cost? Type the amount, like 80000 or 80k.'], pending: q };
    if (!q.by) return { text: ['By when do you want to have it?'], options: byOptions(c), pending: q };
    // This month: nothing to save up over, it's a spend.
    if (q.by <= d.month) return spend(Object.assign({}, q, { intent: 'spend', when: { type: 'month', month: d.month } }), c);
    const first = shift(d.month, 1);
    const tryBy = by => {
      const n = monthsFrom(first, by) + 1, per = Math.ceil(X / n / 100) * 100, extra = {};
      for (let k = 0; k < n; k++) extra[shift(first, k)] = per;
      const was = B.ahead(r.cfg, r.entries, d, by), now = B.ahead(r.cfg, r.entries, d, by, extra);
      return { by, n, per, was, now, low: Math.min(...now.map(m => m.limit)) };
    };
    const p = tryBy(q.by), v = verdict(p.low, F, N.month(p.now.find(m => m.limit === p.low).month));
    const range = list => { const lo = Math.min(...list), hi = Math.max(...list); return lo === hi ? money(lo) : money(lo) + '–' + money(hi); };
    // [month(s), daily limit while saving, what it is now]
    const lines = [[N.month(first), `${money(p.now[0].limit)} a day`, `now ${money(p.was[0].limit)}`]];
    if (p.n > 1) {
      const label = p.n === 2 ? N.month(q.by) : N.span(shift(first, 1), q.by);
      lines.push([label, `${range(p.now.slice(1).map(m => m.limit))} a day`, `now ${range(p.was.slice(1).map(m => m.limit))}`]);
    }
    const text = [v.reason, `Save **${money(p.per)} a month** from ${N.span(first, q.by)} (${plural(p.n, 'month')}) and you'll have ${money(p.per * p.n)}${q.label ? ' for the ' + q.label : ''} by the end of ${N.month(q.by)}.`].filter(Boolean);
    if (v.verdict === 'no') {
      let alt = null;
      for (let k = p.n + 1; k <= 36 && !alt; k++) { const t = tryBy(shift(first, k - 1)); if (t.low >= F) alt = t; }
      text.push(alt
        ? `To keep every month above ${money(F)} a day, aim for ${N.month(alt.by)} instead: ${money(alt.per)} a month.`
        : `Even spread over 3 years it would take a month below ${money(F)} a day.`);
    }
    return {
      verdict: v.verdict, text, lines, note: `The saving comes out of each month's money before its daily limit is worked out, like a fixed cost. ${N.month(d.month)} isn't touched.`,
      figures: { per: p.per, months: p.n, low: p.low, limits: p.now.map(m => [m.month, m.limit]) },
    };
  }

  function status(q, c) {
    const B = c.B, r = c.r, d = r.daily, s = r.salary, k = r.card, N = namer(c.today), M = N.month(d.month);
    if (q.topic === 'card') {
      const u = k.util, pct = u.room >= 0 ? Math.floor(u.pct) : Math.ceil(u.pct * 10) / 10, text = [`**${money(k.owed)}** on the card.`];
      if (k.bill.overdue) text.push(`${money(k.bill.overdueAmount)} is overdue since ${N.day(k.bill.overdueSince)}.`);
      else if (k.next.amount > 0) text.push(`${money(k.next.amount)} is due on ${N.day(k.next.date)} (${inDays(k.next.inDays)}).`);
      if (u.limit) text.push(u.room >= 0 ? `That's ${pct}% of the card limit, under ${u.safePct}%.` : `That's ${pct}% of the card limit: pay ${money(-u.room)} to get under ${u.safePct}%.`);
      return { text };
    }
    if (q.topic === 'bank') {
      return { text: [`Bank balance: **${money(s.left)}**, after keeping aside the ${money(s.emergency)} emergency fund${s.inStart && s.fixed ? ` and the ${money(s.fixed)} of fixed costs still to pay` : ''}.`] };
    }
    if (q.topic === 'emergency') {
      const g = r.cfg.emergencyGrowth, nk = d.nextMonth.month, extra = s.savedBefore + s.saved;
      return { text: [`Emergency fund: **${money(s.emergency)}**${extra > 0 ? ` (with ${money(extra)} saved beyond the daily cap)` : ''}.${g.amount ? ` It grows by ${money(g.amount)} a month: ${money(B.emergencyFor(r.cfg, nk))} in ${N.month(nk)}.` : ''}`] };
    }
    if (q.topic === 'plan') {
      // Next month line by line, as the calculator shows it; the lines add up to its money.
      const p = r.plan.next, list = B.fixedFor(r.cfg, p.month), NM = N.month(p.month);
      const lines = [[`Left from ${M}`, money(p.carried)], ['+ Salaries', money(p.salary)], ...list.map(f => ['− ' + f.name, money(-f.amount)]), ['− Emergency fund', money(-p.emergency)]];
      if (p.savedBefore) lines.push(['− Saved earlier', money(-p.savedBefore)]);
      if (p.borrowed) lines.push([`− Borrowed by ${M}`, money(-p.borrowed)]);
      lines.push([`${NM}'s money`, money(p.money)]);
      return { text: [`${NM}: **${money(p.limit)} a day**, if ${M} sticks to its limit.`], lines };
    }
    // The daily limit: today, tomorrow, this month or a month ahead.
    const t = q.when;
    if (t && t.type === 'day' && t.date === c.today || (!t && /\b(today|left)\b/.test(q.text.toLowerCase()))) {
      const carry = d.carry ? `${money(d.limit)} ${d.carry > 0 ? '+' : '−'} ${money(Math.abs(d.carry))} ${d.carry > 0 ? 'carried over' : 'overspent earlier'}` : `daily limit ${money(d.limit)}`;
      if (d.left < 0) return { text: [`You're **${money(-d.left)} over** today (${carry}, ${money(d.spent)} spent). It comes off the coming days.`] };
      return { text: [`You have **${money(d.left)} left today** (${carry}${d.spent ? `, ${money(d.spent)} spent` : ''}).`] };
    }
    if (t && t.type === 'day' && t.date === addDays(c.today, 1)) {
      const tm = d.tomorrow;
      return { text: [`Tomorrow you'll have **${money(tm.available)}**${tm.fresh ? ` (${N.month(tm.date.slice(0, 7))} starts)` : ''}, if nothing more is spent today.`] };
    }
    const mk = t ? (t.type === 'day' ? t.date.slice(0, 7) : t.month) : (t === null && q.time && q.time.vague ? null : d.month);
    if (!mk) return { text: ['Which month?'], options: whenOptions(c).slice(1), pending: Object.assign({}, q, { intent: 'status', topic: 'limit' }) };
    if (mk <= d.month) {
      return { text: [`${M}'s daily limit is **${money(d.limit)} a day** (${r.cfg.dailyLimits[d.month] ? 'you set it' : `worked out from ${M}'s money`}). Today you have ${money(d.left)} left.`] };
    }
    const months = B.ahead(r.cfg, r.entries, d, mk), m = months[months.length - 1];
    const text = [`${N.month(mk)}: **${money(m.limit)} a day**${m.set ? ' (you set it)' : ''}.`];
    if (m.saved > 0) text.push(`That's the most per day; the other ${money(m.saved)} goes into the emergency fund.`);
    if (m.borrow > 0) text.push(`It borrows ${money(m.borrow)} from ${N.month(shift(mk, 1))}.`);
    return { text, note: `If ${months.length === 1 ? M : 'every month until then'} sticks to its daily limit.` };
  }

  function help(c) {
    const N = namer(c.today), nk = N.month(shift(c.r.daily.month, 1));
    return { text: ['I can answer things like these. Type your own, or tap one:'], chips: examples(nk) };
  }
  const examples = nk => [
    'How much is left today?', `What's my limit in ${nk}?`, `Can I spend ₹2,000 on a trip in ${nk}?`,
    'How much to save for ₹80,000 in 12 months?', 'When is the card due?', "What's in the emergency fund?",
  ];

  const api = { parse, follow, choose, answer, examples, like, tokens };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Ask = api;
})(typeof self !== 'undefined' ? self : this);
