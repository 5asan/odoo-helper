/* GL Analysis: scan journal items for likely posting mistakes.
   Reads an Odoo Journal Items export (one row per line, with an Account column) or the
   General Ledger report export (account title rows followed by their lines).
   Every check is data-driven: it learns what is "usual" from the file itself, then lists exceptions. */
const GL = (() => {
  const FIELDS = [
    { k: 'date', re: /^(date|accounting date|التاريخ|تاريخ)/i },
    { k: 'move', re: /(journal entry|^entry\b|^number|^move\b|^voucher|القيد|المستند)/i },
    { k: 'journal', re: /^(journal|اليومية|دفتر اليومية)$/i },
    { k: 'account', re: /^(account|الحساب|حساب)/i },
    { k: 'partner', re: /(partner|الشريك|الجهة)/i },
    { k: 'product', re: /^(product|المنتج|الصنف)/i },
    { k: 'label', re: /(label|communication|description|narration|البيان|الوصف)/i },
    { k: 'ref', re: /^(reference|ref\b|المرجع)/i },
    { k: 'analytic', re: /(analytic|تحليل)/i },
    { k: 'debit', re: /^(debit|مدين)/i },
    { k: 'credit', re: /^(credit|دائن)/i },
    { k: 'amount', re: /^(amount|balance|المبلغ|الرصيد)$/i },
  ];
  const SKIP_RE = /^\s*(total|grand total|initial balance|opening balance|load more|الإجمالي|إجمالي|اجمالي|المجموع|الرصيد الافتتاحي)/i;
  const ACC_ROW_RE = /^\s*[\w.\-]*\d[\w.\-]*\s+\S/;
  const MOVE_RE = /[A-Za-z]{2,}[\w-]*\/(\d{2,4}\/)?\d+/;
  const REVERSAL_RE = /revers|refund|cancel|correct|credit note|عكس|إلغاء|الغاء|استرداد|تصحيح|مرتجع|إشعار دائن/i;
  const MONTH_RE = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?|يناير|فبراير|مارس|ابريل|مايو|يونيو|يوليو|اغسطس|سبتمبر|اكتوبر|نوفمبر|ديسمبر)\b/g;
  const AUTO_RE = /^\s*(deferral of|deferred|reversal of|depreciation|accrual|إطفاء|استهلاك|إهلاك|عكس)/i;
  const PAGE = 100;

  // Account category from the Chart of Accounts type, or else from the account name.
  function categoryOf(type, name) {
    if (type) {
      if (/receivable|مدين/i.test(type)) return 'receivable';
      if (/payable|دائن/i.test(type)) return 'payable';
      if (/bank|cash|credit card|بنك|نقد/i.test(type)) return 'bank';
      if (/income|revenue|إيراد|ايراد/i.test(type)) return 'income';
      if (/expense|depreciation|cost of revenue|مصروف|مصاريف|تكلف|إهلاك|اهلاك/i.test(type)) return 'expense';
    }
    const n = name;
    if (/outstanding|suspense|liquidity transfer|معلق/i.test(n)) return 'transit';
    if (/receivable|ذمم مدينة|مدينون|المدينين/i.test(n)) return 'receivable';
    if (/payable|ذمم دائنة|دائنون|الدائنين/i.test(n)) return 'payable';
    if (/\bbank\b|\bcash\b|current account|savings|بنك|صندوق|نقدية/i.test(n) && !/fees|charges|expense|deposit|interest|رسوم|مصروف/i.test(n)) return 'bank';
    if (/unearned|deferred|accrued|advance|prepaid|accumulated|\bacc\.|provision|allowance|مقدم|مستحق|مجمع|مخصص/i.test(n)) return type ? 'other' : 'other';
    if (/income|revenue|sales|\bgain|إيراد|ايراد|مبيعات/i.test(n)) return 'income';
    if (/expense|fees|salar|depreciation of|cost of|services|charity|donation|insurance|مصروف|مصاريف|رواتب|رسوم|إهلاك/i.test(n)) return 'expense';
    return 'other';
  }
  const CONTROL = new Set(['receivable', 'payable', 'bank', 'transit']);

  // Journal from the Journal column, else from the entry number prefix (INV/2026/0001 → INV).
  function journalOf(line) {
    if (line.journal) return line.journal;
    const m = line.move.match(/^([A-Za-z]+\d*)(?=\/|$)/) || line.move.match(/^([A-Za-z]+)/);
    return m ? m[1].toUpperCase() : '';
  }
  function journalKind(j) {
    if (/^(R?INV|RFAC|FAC|SO|sale|مبيعات)/i.test(j) || /customer invoice|فواتير العملاء/i.test(j)) return 'sale';
    if (/^(R?BILL|VB|purchase|مشتريات)/i.test(j) || /vendor bill|فواتير الموردين/i.test(j)) return 'purchase';
    if (/^(P?BNK|P?CSH|BANK|CASH|بنك|نقد)/i.test(j)) return 'bank';
    return 'general';
  }

  const CHECKS = [
    { id: 'label', sev: 'high' }, { id: 'product', sev: 'high' }, { id: 'partner', sev: 'high' }, { id: 'ref', sev: 'high' },
    { id: 'dup', sev: 'high' }, { id: 'direction', sev: 'high' }, { id: 'ptype', sev: 'high' },
    { id: 'journal', sev: 'medium' }, { id: 'outlier', sev: 'medium' }, { id: 'missing', sev: 'medium' },
    { id: 'rare', sev: 'low' }, { id: 'dates', sev: 'low' },
  ];

  let settings = { check: 'label', skipControl: true, loose: false, fuzzy: true, ignore: '', weekend: 'fri-sat', from: '', to: '' };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('oh_gl_settings') || '{}')); } catch (e) { /* default */ }
  const saveSettings = () => { try { localStorage.setItem('oh_gl_settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } };

  const st = { fileName: '', status: 'idle', error: '', rows: [], headerIdx: -1, headers: [], map: {}, lines: [], result: null, query: '', limit: PAGE };

  const num = s => { const p = U.parseNum(s); return p ? p.v : 0; };
  let DEC = 2;
  const money = v => (v ? Number(v).toLocaleString('en-US', { minimumFractionDigits: DEC, maximumFractionDigits: DEC }) : '');
  const r3 = v => Math.round(v * 1000) / 1000;
  const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const moveOf = l => l.move || 'line' + l.n;

  /* ---------- Reading ---------- */
  function findHeader(rows) {
    let best = -1, bestScore = 1;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const cells = rows[i].map(c => c.trim());
      const score = FIELDS.filter(f => cells.some(c => c && f.re.test(c))).length;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    return best;
  }

  function autoMap(headers, data) {
    const map = {}, used = new Set();
    for (const f of FIELDS) {
      const idx = headers.findIndex((h, i) => !used.has(i) && h && f.re.test(h.trim()));
      map[f.k] = idx; if (idx >= 0) used.add(idx);
    }
    // Odoo's General Ledger report: under each account title row, the "Account Name" column holds the entry number.
    if (map.account >= 0 && map.move < 0 && map.date >= 0) {
      const vals = data.slice(0, 500).filter(r => U.parseDate(r[map.date] || '')).map(r => r[map.account] || '').filter(Boolean);
      if (vals.length >= 3 && vals.filter(v => MOVE_RE.test(v)).length / vals.length >= 0.6) { map.move = map.account; map.account = -1; }
    }
    // Some versions have an unnamed first column holding the entry number.
    if (map.move < 0) {
      const sample = data.slice(0, 300);
      const width = Math.max(headers.length, ...sample.map(r => r.length));
      for (let c = 0; c < width; c++) {
        if (used.has(c)) continue;
        const vals = sample.map(r => r[c] || '').filter(Boolean);
        if (vals.length >= 3 && vals.filter(v => MOVE_RE.test(v)).length / vals.length >= 0.4) { map.move = c; break; }
      }
    }
    return map;
  }

  function dateOrder(rows, col) {
    let dmy = 0, mdy = 0;
    for (const r of rows.slice(0, 2000)) {
      const m = String(r[col] || '').match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-]\d{2,4}/);
      if (!m) continue;
      if (+m[1] > 12) dmy++; else if (+m[2] > 12) mdy++;
    }
    return mdy > dmy ? 'MDY' : 'DMY';
  }

  function parseLines() {
    const { rows, headerIdx, map } = st;
    const data = rows.slice(headerIdx + 1);
    const order = map.date >= 0 ? dateOrder(data, map.date) : 'DMY';
    const header = st.headers;
    const lines = [];
    let curAcc = '', accRows = 0, dec = 2;
    const cell = (r, k) => (map[k] >= 0 ? String(r[map[k]] || '').trim() : '');
    for (const r of data) {
      if (!r.some(c => c)) continue;
      if (map.account >= 0 && cell(r, 'account') === (header[map.account] || '').trim()) continue; // repeated header
      const first = r.find(c => c) || '';
      if (SKIP_RE.test(first) || SKIP_RE.test(cell(r, 'label'))) continue;
      const date = map.date >= 0 ? U.parseDate(cell(r, 'date'), order) : null;
      if (map.account < 0 && !date) {
        // Account title row: "1010101 Bank" in one cell, or the code and name in two cells.
        const amtCols = new Set([map.debit, map.credit, map.amount]);
        const title = r.filter((c, i) => c && !amtCols.has(i)).slice(0, 2).map(c => String(c).trim());
        const one = title[0] || '', two = title.join(' ');
        if (ACC_ROW_RE.test(one)) { curAcc = one; accRows++; continue; }
        if (/^[\w.\-]*\d[\w.\-]*$/.test(one) && title.length === 2 && ACC_ROW_RE.test(two)) { curAcc = two; accRows++; continue; }
      }
      if (map.date >= 0 && !date) continue;
      let debit = 0, credit = 0;
      const dc = cell(r, 'debit') + ' ' + cell(r, 'credit');
      if (/\d[.,]\d{3}(?!\d)/.test(dc) && !/\d[.,]\d{3}[.,]/.test(dc)) dec = 3;
      if (map.debit >= 0 || map.credit >= 0) { debit = Math.abs(num(cell(r, 'debit'))); credit = Math.abs(num(cell(r, 'credit'))); }
      else if (map.amount >= 0) { const v = num(cell(r, 'amount')); if (v > 0) debit = v; else credit = -v; }
      if (!debit && !credit) continue;
      const account = map.account >= 0 ? cell(r, 'account') : curAcc;
      if (!account) continue;
      const an = cell(r, 'analytic');
      lines.push({
        n: lines.length, date, move: cell(r, 'move'), journal: cell(r, 'journal'), account,
        partner: cell(r, 'partner').replace(/[‎‏]/g, '').trim(), product: cell(r, 'product'), label: cell(r, 'label'),
        ref: cell(r, 'ref'), analytic: an && an !== '{}' && an !== 'False' ? an : '', debit, credit,
      });
    }
    st.lines = lines;
    st.grouped = map.account < 0 && accRows > 0;
    DEC = dec;
  }

  /* ---------- Preparation ---------- */
  function prepare() {
    const byCode = new Map(App.data.accounts.map(a => [String(a.code).trim(), a]));
    const cache = new Map();
    const info = text => {
      let r = cache.get(text);
      if (r) return r;
      const m = text.match(/^\s*([\w.\-]*\d[\w.\-]*)(\s+|$)/);
      const code = m ? m[1] : '';
      const coa = code ? byCode.get(code) : null;
      const name = coa && !text.slice(code.length).trim() ? `${code} ${coa.name}` : text;
      const cat = categoryOf(coa && coa.type, name);
      r = { code, key: U.norm(name), name, cat };
      cache.set(text, r);
      return r;
    };
    const ignore = settings.ignore.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const l of st.lines) {
      const a = info(l.account);
      if (ignore.some(p => a.code.startsWith(p))) continue;
      l.acc = a.key; l.accName = a.name; l.cat = a.cat; l.code = a.code; l.control = CONTROL.has(a.cat);
      l.jr = journalOf(l); l.kind = journalKind(l.jr);
      l.amt = r3(l.debit - l.credit);
      out.push(l);
    }
    // Learn income/expense from the code's first digit (e.g. 4… = income) using the accounts whose names say so.
    if (!App.data.accounts.some(a => a.type)) {
      const votes = {};
      for (const l of out) if ((l.cat === 'income' || l.cat === 'expense') && /^\d/.test(l.code)) {
        const d = l.code[0]; votes[d] = votes[d] || { income: 0, expense: 0 }; votes[d][l.cat]++;
      }
      const learned = {};
      for (const [d, v] of Object.entries(votes)) {
        const tot = v.income + v.expense;
        if (tot >= 3 && Math.max(v.income, v.expense) / tot >= 0.8) learned[d] = v.income > v.expense ? 'income' : 'expense';
      }
      // The code wins over the name ("Construction Management Fees" under 4… is income, not an expense).
      for (const l of out) if ((l.cat === 'other' || l.cat === 'income' || l.cat === 'expense') && l.code && learned[l.code[0]]) l.cat = learned[l.code[0]];
    }
    // Entries Odoo creates by itself (deferrals, depreciation, reversals) follow their own rules.
    const autoMoves = new Set();
    for (const l of out) if (AUTO_RE.test(l.label) || (l.kind === 'general' && /depreciation|إهلاك|اهلاك|استهلاك/i.test(l.accName))) autoMoves.add(moveOf(l));
    for (const l of out) l.auto = autoMoves.has(moveOf(l));
    return out;
  }

  function textKey(text) {
    let k = U.norm(text);
    if (settings.loose) k = k.replace(MONTH_RE, ' ').replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
    if (k.length < 2 || /^[\d\s]+$/.test(k)) return '';
    return k;
  }

  /* Similar spellings ("Ofice rent" / "Office rent"): keys that share a one-letter deletion are joined. */
  function fuzzyCanon(keys) {
    const parent = new Map(keys.map(k => [k, k]));
    const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    const seen = new Map();
    for (const k of keys) {
      if (k.length < 8 || k.length > 80) continue;
      const dg = k.replace(/\D/g, '');
      for (let i = -1; i < k.length; i++) {
        const v = (i < 0 ? k : k.slice(0, i) + k.slice(i + 1)) + '#' + dg;
        const o = seen.get(v);
        if (o == null) seen.set(v, k);
        else if (o !== k) parent.set(find(k), find(o));
      }
    }
    return k => find(k);
  }

  /* ---------- Checks ---------- */
  const chipsFor = (lines, usual) => {
    const m = new Map();
    for (const l of lines) {
      let c = m.get(l.acc);
      if (!c) m.set(l.acc, c = { name: l.accName, n: 0, odd: usual ? !usual.has(l.acc) : true });
      c.n++;
    }
    return [...m.values()].sort((a, b) => a.odd - b.odd || b.n - a.n);
  };

  // Same text (label / product / partner / reference) usually goes to one set of accounts; list the exceptions.
  function consistency(lines, getText, { fuzzy = false, perMove = true, maxOdd = 0.4, minMoves = 2 } = {}) {
    const groups = new Map();
    const keyed = [];
    for (const l of lines) { const k = textKey(getText(l)); if (k) keyed.push([k, l]); }
    const canon = fuzzy ? fuzzyCanon([...new Set(keyed.map(x => x[0]))]) : k => k;
    for (const [k0, l] of keyed) {
      const k = canon(k0);
      let g = groups.get(k);
      if (!g) groups.set(k, g = { key: k, texts: new Map(), lines: [] });
      g.lines.push(l);
      const tx = getText(l); g.texts.set(tx, (g.texts.get(tx) || 0) + 1);
    }
    const found = [];
    for (const g of groups.values()) {
      if (new Set(g.lines.map(l => l.acc)).size < 2) continue;
      const moveSets = new Map();
      for (const l of g.lines) {
        const m = perMove ? moveOf(l) : 'line' + l.n;
        if (!moveSets.has(m)) moveSets.set(m, new Set());
        moveSets.get(m).add(l.acc);
      }
      const sigs = new Map();
      for (const set of moveSets.values()) { const s = [...set].sort().join('|'); sigs.set(s, (sigs.get(s) || 0) + 1); }
      const [top, topN] = [...sigs.entries()].sort((a, b) => b[1] - a[1] || b[0].split('|').length - a[0].split('|').length)[0];
      const usual = new Set(top.split('|'));
      const odd = g.lines.filter(l => !usual.has(l.acc));
      const oddMoves = new Set(odd.map(l => perMove ? moveOf(l) : l.n)).size;
      // Only a minority is suspicious: a 50/50 split is a habit, not a slip.
      if (!odd.length || topN < 2 || moveSets.size < minMoves || oddMoves > Math.max(1, moveSets.size * maxOdd)) continue;
      const texts = [...g.texts.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
      found.push({
        title: texts[0], variants: texts.slice(1, 4), key: g.key,
        meta: t('gl_group_meta', { l: g.lines.length, a: new Set(g.lines.map(l => l.acc)).size }),
        chips: chipsFor(g.lines, usual), lines: g.lines, odd: new Set(odd.map(l => l.n)), weight: odd.length,
      });
    }
    return found.sort((a, b) => b.lines.length - a.lines.length);
  }

  function checkDuplicates(lines) {
    const moves = new Map();
    for (const l of lines) {
      if (!l.move) continue;
      let m = moves.get(l.move);
      if (!m) moves.set(l.move, m = { move: l.move, date: l.date, jr: l.jr, partner: '', ref: '', lines: [], acc: new Map() });
      m.lines.push(l);
      if (!m.partner && l.partner) m.partner = l.partner;
      if (!m.ref && l.ref) m.ref = l.ref;
      m.acc.set(l.acc, r3((m.acc.get(l.acc) || 0) + l.amt));
    }
    const byKey = new Map();
    for (const m of moves.values()) {
      m.total = r3(m.lines.reduce((s, l) => s + l.debit, 0));
      m.sig = [...m.acc.entries()].sort().map(e => e.join(':')).join('|');   // same accounts, same amounts, same direction
      const k = m.jr + '§' + U.norm(m.partner) + '§' + m.sig;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(m);
      if (m.ref) {
        const rk = 'ref§' + m.jr + '§' + U.norm(m.partner) + '§' + U.norm(m.ref);
        if (!byKey.has(rk)) byKey.set(rk, []);
        byKey.get(rk).push(m);
      }
    }
    const DAY = 864e5, found = [], done = new Set();
    for (const [k, list] of byKey) {
      if (list.length < 2) continue;
      const isRef = k.startsWith('ref§');
      list.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.move.localeCompare(b.move));
      // Split into runs of entries no more than 7 days apart (a reference repeats at any distance).
      const runs = [[list[0]]];
      for (let i = 1; i < list.length; i++) {
        const prev = runs[runs.length - 1];
        if (isRef || new Date(list[i].date) - new Date(prev[prev.length - 1].date) <= 7 * DAY) prev.push(list[i]);
        else runs.push([list[i]]);
      }
      // A partner with two shops pays twice every month: that is a habit. Only runs bigger than usual count.
      const sizes = {};
      for (const r of runs) sizes[r.length] = (sizes[r.length] || 0) + 1;
      const usual = runs.length >= 3 ? +Object.entries(sizes).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0] : 1;
      for (const run of runs) {
        if (run.length <= usual) continue;
        const id = run.map(m => m.move).sort().join(',');
        if (done.has(id)) continue;
        done.add(id);
        const labels = run.map(m => m.lines.map(l => U.norm(l.label)).sort().join('|'));
        const sameLabels = new Set(labels).size < labels.length;
        // Installments ("Payment (22 / 60)", "(23 / 60)") are separate on purpose.
        if (!sameLabels && labels.some(x => /\b\d+ \d+\b/.test(x)) && run.some(m => m.lines.some(l => /\(\s*\d+\s*\/\s*\d+\s*\)/.test(l.label)))) continue;
        found.push({
          title: `${run[0].partner || t('gl_no_partner_name')} · ${money(run[0].total)}`,
          meta: isRef ? t('gl_dup_ref', { r: run[0].ref, n: run.length }) : t('gl_dup_meta', { n: run.length, e: run.map(m => m.move).join(', ') }),
          lines: run.flatMap(m => m.lines), odd: new Set(run.slice(usual).flatMap(m => m.lines.map(l => l.n))), keepOrder: true,
          weight: (sameLabels ? 1e6 : 0) + run[0].total, sure: sameLabels,
        });
      }
    }
    return found.sort((a, b) => b.weight - a.weight);
  }

  function isReversal(l, byAccAmt) {
    if (REVERSAL_RE.test(l.label + ' ' + l.ref + ' ' + l.product) || /^R(INV|BILL)/.test(l.jr)) return true;
    const opp = byAccAmt.get(l.acc + '§' + r3(-l.amt));
    return !!(opp && opp.some(o => o.move !== l.move));
  }

  function checkDirection(lines) {
    const byAcc = new Map(), byAccAmt = new Map();
    for (const l of lines) {
      if (!byAcc.has(l.acc)) byAcc.set(l.acc, []);
      byAcc.get(l.acc).push(l);
      const k = l.acc + '§' + l.amt;
      if (!byAccAmt.has(k)) byAccAmt.set(k, []);
      byAccAmt.get(k).push(l);
    }
    const found = [];
    for (const ls of byAcc.values()) {
      if (ls.length < 10) continue;
      const deb = ls.filter(l => l.amt > 0).length;
      const share = deb / ls.length;
      if (share < 0.9 && share > 0.1) continue;
      const normalDebit = share >= 0.9;
      const odd = ls.filter(l => (normalDebit ? l.amt < 0 : l.amt > 0) && !isReversal(l, byAccAmt));
      if (!odd.length || odd.length > ls.length * 0.1) continue;
      found.push({
        title: ls[0].accName, meta: t(normalDebit ? 'gl_dir_debit' : 'gl_dir_credit', { n: ls.length - odd.length, m: ls.length }),
        lines: odd, odd: new Set(odd.map(l => l.n)), weight: odd.length,
      });
    }
    return found.sort((a, b) => b.weight - a.weight);
  }

  function checkPartnerType(lines) {
    const byP = new Map();
    for (const l of lines) {
      if (!l.partner || (l.cat !== 'receivable' && l.cat !== 'payable')) continue;
      const k = U.norm(l.partner);
      if (!byP.has(k)) byP.set(k, []);
      byP.get(k).push(l);
    }
    const found = [];
    for (const ls of byP.values()) {
      const rec = ls.filter(l => l.cat === 'receivable'), pay = ls.filter(l => l.cat === 'payable');
      if (!rec.length || !pay.length) continue;
      const [main, odd, kind] = rec.length >= pay.length ? [rec, pay, 'gl_pt_customer'] : [pay, rec, 'gl_pt_vendor'];
      if (main.length < 3 || odd.length > main.length * 0.2) continue;
      found.push({
        title: ls[0].partner, meta: t(kind, { n: main.length, m: odd.length }),
        chips: chipsFor(ls, new Set(main.map(l => l.acc))), lines: ls, odd: new Set(odd.map(l => l.n)), weight: odd.length,
      });
    }
    return found.sort((a, b) => b.lines.length - a.lines.length);
  }

  function checkJournal(lines) {
    const jCount = new Map(), aCount = new Map(), pair = new Map();
    for (const l of lines) {
      jCount.set(l.jr, (jCount.get(l.jr) || 0) + 1);
      aCount.set(l.acc, (aCount.get(l.acc) || 0) + 1);
      const k = l.jr + '§' + l.acc;
      if (!pair.has(k)) pair.set(k, []);
      pair.get(k).push(l);
    }
    const found = [];
    for (const ls of pair.values()) {
      const l0 = ls[0];
      const wrongType = (l0.kind === 'sale' && l0.cat === 'expense') || (l0.kind === 'purchase' && l0.cat === 'income');
      const rare = ls.length <= 2 && jCount.get(l0.jr) >= 30 && aCount.get(l0.acc) >= 10;
      if (!wrongType && !rare) continue;
      found.push({
        title: `${l0.jr} → ${l0.accName}`,
        meta: wrongType ? t(l0.kind === 'sale' ? 'gl_jr_sale_exp' : 'gl_jr_pur_inc') : t('gl_jr_rare', { n: ls.length, j: l0.jr, m: aCount.get(l0.acc) }),
        lines: ls, odd: new Set(ls.map(l => l.n)), weight: (wrongType ? 1000 : 0) + aCount.get(l0.acc),
      });
    }
    return found.sort((a, b) => b.weight - a.weight);
  }

  function checkOutliers(lines) {
    const found = [];
    const groupBy = (f) => { const m = new Map(); for (const l of lines) { if (l.control || l.auto) continue; const k = f(l); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(l); } return m; };
    const flagged = new Map();   // account → [{line, med}]
    const add = (l, med) => {
      if (!flagged.has(l.acc)) flagged.set(l.acc, new Map());
      if (!flagged.get(l.acc).has(l.n)) flagged.get(l.acc).set(l.n, { l, med });
    };
    // A spike: far above the usual amount AND far above every other amount (an extra zero, a misplaced decimal).
    const spikes = (ls, minN) => {
      if (ls.length < minN) return;
      const amts = ls.map(l => Math.abs(l.amt));
      const med = median(amts);
      if (!med) return;
      const sorted = [...amts].sort((a, b) => b - a);
      ls.forEach(l => {
        const a = Math.abs(l.amt);
        const nextBiggest = a === sorted[0] ? sorted[1] : sorted[0];
        if (a >= med * 10 && a >= nextBiggest * 3) add(l, med);
      });
    };
    for (const ls of groupBy(l => l.partner ? l.acc + '§' + U.norm(l.partner) : '').values()) spikes(ls, 6);
    for (const ls of groupBy(l => l.acc).values()) spikes(ls, 12);
    for (const m of flagged.values()) {
      const items = [...m.values()];
      found.push({
        title: items[0].l.accName, meta: t('gl_out_meta', { n: items.length }),
        lines: items.map(x => x.l), odd: new Set(items.map(x => x.l.n)), weight: items.length,
        note: l => t('gl_out_usual', { v: money(m.get(l.n).med) }),
      });
    }
    return found.sort((a, b) => b.weight - a.weight);
  }

  function checkMissing(lines) {
    const byAcc = new Map();
    for (const l of lines) { if (!byAcc.has(l.acc)) byAcc.set(l.acc, []); byAcc.get(l.acc).push(l); }
    const hasAnalytic = st.map.analytic >= 0 && lines.some(l => l.analytic);
    const found = [];
    const push = (ls, what, extra) => ls.length && found.push({
      title: `${ls[0].accName}`, meta: t(what, extra), lines: ls, odd: new Set(ls.map(l => l.n)), weight: ls.length,
    });
    for (const ls of byAcc.values()) {
      const cat = ls[0].cat;
      const withP = ls.filter(l => l.partner).length / ls.length;
      if (cat === 'receivable' || cat === 'payable' || (ls.length >= 10 && withP >= 0.9)) {
        push(ls.filter(l => !l.partner), 'gl_miss_partner', { p: Math.round(withP * 100) });
      }
      if (hasAnalytic && ls.length >= 10) {
        const withA = ls.filter(l => l.analytic).length / ls.length;
        if (withA >= 0.8) push(ls.filter(l => !l.analytic), 'gl_miss_analytic', { p: Math.round(withA * 100) });
      }
      if (!CONTROL.has(cat) && ls.length >= 10 && ls.filter(l => l.label).length / ls.length >= 0.95) {
        push(ls.filter(l => !l.label), 'gl_miss_label', {});
      }
    }
    return found.sort((a, b) => b.weight - a.weight);
  }

  function checkRare(lines) {
    const byAcc = new Map();
    for (const l of lines) { if (!byAcc.has(l.acc)) byAcc.set(l.acc, []); byAcc.get(l.acc).push(l); }
    if (byAcc.size < 10) return [];
    return [...byAcc.values()].filter(ls => ls.length <= 2).map(ls => ({
      title: ls[0].accName, meta: t('gl_rare_meta', { n: ls.length }), lines: ls, odd: new Set(ls.map(l => l.n)), weight: ls.length,
    }));
  }

  function checkDates(lines) {
    const today = new Date().toISOString().slice(0, 10);
    const years = new Map();
    for (const l of lines) if (l.date) years.set(l.date.slice(0, 4), (years.get(l.date.slice(0, 4)) || 0) + 1);
    const wk = settings.weekend === 'sat-sun' ? [6, 0] : settings.weekend === 'fri-sat' ? [5, 6] : [];
    const reasons = { future: [], period: [], year: [], weekend: [] };
    // Month-end and month-start dates are normal for closing entries, whatever the weekday.
    const edge = d => { const day = +d.slice(8); const last = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate(); return day <= 2 || day >= last - 2; };
    for (const l of lines) {
      if (!l.date) continue;
      if (l.date > today) reasons.future.push(l);
      else if ((settings.from && l.date < settings.from) || (settings.to && l.date > settings.to)) reasons.period.push(l);
      else if (years.get(l.date.slice(0, 4)) < Math.max(3, lines.length * 0.01)) reasons.year.push(l);
      else if (wk.length && l.kind === 'general' && !l.auto && !edge(l.date) && wk.includes(new Date(l.date + 'T00:00:00Z').getUTCDay())) reasons.weekend.push(l);
    }
    return Object.entries(reasons).filter(([, ls]) => ls.length).map(([k, ls]) => ({
      title: t('gl_date_' + k), meta: t('gl_lines_n', { n: ls.length }), lines: ls, odd: new Set(ls.map(l => l.n)), weight: ls.length,
    }));
  }

  function analyse() {
    const lines = prepare();
    const manual = lines.filter(l => !l.auto);
    const scoped = settings.skipControl ? manual.filter(l => !l.control) : manual;
    const pl = manual.filter(l => l.cat === 'income' || l.cat === 'expense');
    const hasMove = lines.some(l => l.move);
    const has = k => st.map[k] >= 0 && lines.some(l => l[k]);
    const R = {};
    R.label = consistency(scoped, l => l.label, { fuzzy: settings.fuzzy, perMove: hasMove });
    R.product = has('product') ? consistency(manual.filter(l => !l.control), l => l.product, { perMove: hasMove, maxOdd: 0.2 }) : null;
    // Partners often buy or sell several things, so only a rare income/expense account counts.
    R.partner = has('partner') ? consistency(pl, l => l.partner, { perMove: hasMove, maxOdd: 0.1, minMoves: 5 }) : null;
    R.ref = has('ref') ? consistency(scoped, l => l.ref, { perMove: hasMove }) : null;
    R.dup = hasMove ? checkDuplicates(manual) : null;
    R.direction = checkDirection(lines).map(g => {
      const odd = g.lines.filter(l => !l.auto);
      return odd.length ? Object.assign(g, { lines: odd, odd: new Set(odd.map(l => l.n)), weight: odd.length }) : null;
    }).filter(Boolean);
    R.ptype = has('partner') ? checkPartnerType(lines) : null;
    R.journal = hasMove || has('journal') ? checkJournal(lines) : null;
    R.outlier = checkOutliers(lines);
    R.missing = checkMissing(lines);
    R.rare = checkRare(lines);
    R.dates = checkDates(lines);
    const dates = lines.map(l => l.date).filter(Boolean).sort();
    st.result = {
      checks: R, hasMove, used: lines.length, dropped: st.lines.length - lines.length,
      moves: hasMove ? new Set(lines.map(l => l.move)).size : null,
      accounts: new Set(lines.map(l => l.acc)).size, from: dates[0], to: dates[dates.length - 1],
    };
    if (!R[settings.check]) settings.check = 'label';
    st.limit = PAGE;
  }

  /* ---------- File handling ---------- */
  async function onFiles(files) {
    const file = files[0];
    Object.assign(st, { fileName: file.name, status: 'busy', error: '', result: null, lines: [], query: '' });
    App.rerender();
    await new Promise(r => setTimeout(r, 30));
    try {
      if (/\.pdf$/i.test(file.name)) throw new Error(t('gl_need_excel'));
      const rows = (await U.readSheet(file)).filter(r => r.some(c => c));
      const hi = findHeader(rows);
      if (hi < 0) throw new Error(t('gl_no_header'));
      st.rows = rows; st.headerIdx = hi; st.headers = rows[hi];
      st.map = autoMap(st.headers, rows.slice(hi + 1));
      run();
    } catch (e) {
      st.error = e.message || String(e);
    }
    st.status = 'idle';
    App.rerender();
  }

  function run() {
    st.error = '';
    parseLines();
    if (!st.lines.length) { st.result = null; st.error = t(st.map.account < 0 && !st.grouped ? 'gl_no_account' : 'gl_no_lines'); return; }
    analyse();
  }

  /* ---------- Rendering ---------- */
  function render() {
    const busy = st.status === 'busy';
    const has = !!st.rows.length && !busy;
    return `
      <div class="page-head"><h1>${t('gl_title')}</h1><p class="muted">${t('gl_sub')}</p></div>
      <div class="card">
        ${has ? `
          <div class="row">
            <b>${U.esc(st.fileName)}</b><span class="spacer"></span>
            ${st.result ? `<button class="btn" id="glXlsx" type="button">${t('gl_download_all')}</button>
            <button class="btn ghost" id="glCopy" type="button">${t('copy_table')}</button>` : ''}
            <button class="btn ghost" id="glNew" type="button">${t('gl_new')}</button>
          </div>` : `
          <div class="drop" id="glDrop" tabindex="0" role="button">
            <b>${t('gl_drop')}</b><span class="muted">${t('gl_drop_sub')}</span>
          </div>
          <p class="muted small" style="margin:10px 0 0">${t('gl_how')}</p>`}
        <input type="file" id="glFile" accept=".xlsx,.xls,.csv" hidden>
        ${renderSettings()}
      </div>
      ${busy ? `<div class="card"><span class="spinner"></span> ${U.esc(t('reading', { f: st.fileName }))}</div>` : ''}
      ${st.error ? `<div class="notice bad">${U.esc(st.error)}</div>` : ''}
      ${st.result ? renderResult() : ''}
      ${has ? renderColumns() : ''}`;
  }

  function renderSettings() {
    return `
      <details class="gl-opts" style="margin-top:12px">
        <summary>${t('gl_options')}</summary>
        <div class="row" style="margin-top:10px;align-items:flex-end">
          <label class="field">${t('gl_ignore')}
            <input id="glIgnore" value="${U.esc(settings.ignore)}" placeholder="${t('gl_ignore_ph')}" style="min-width:180px" dir="ltr"></label>
          <label class="field">${t('gl_weekend')}
            <select id="glWeekend">
              ${['fri-sat', 'sat-sun', 'none'].map(w => `<option value="${w}" ${settings.weekend === w ? 'selected' : ''}>${t('gl_wk_' + w)}</option>`).join('')}
            </select></label>
          <label class="field">${t('gl_from')}<input type="date" id="glFrom" value="${settings.from}"></label>
          <label class="field">${t('gl_to')}<input type="date" id="glTo" value="${settings.to}"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <label class="row" style="gap:6px"><input type="checkbox" id="glControl" ${settings.skipControl ? 'checked' : ''}> ${t('gl_skip_control')}</label>
          <label class="row" style="gap:6px"><input type="checkbox" id="glFuzzy" ${settings.fuzzy ? 'checked' : ''}> ${t('gl_fuzzy')}</label>
          <label class="row" style="gap:6px"><input type="checkbox" id="glLoose" ${settings.loose ? 'checked' : ''}> ${t('gl_loose')}</label>
        </div>
      </details>`;
  }

  function filtered() {
    const list = st.result.checks[settings.check] || [];
    const q = U.norm(st.query);
    if (!q) return list;
    return list.filter(g => U.norm(g.title + ' ' + (g.meta || '')).includes(q) ||
      g.lines.some(l => U.norm(`${l.partner} ${l.move} ${l.accName} ${l.label}`).includes(q)));
  }

  function renderResult() {
    const R = st.result;
    const tiles = CHECKS.map(c => {
      const list = R.checks[c.id];
      const n = list ? list.length : null;
      const lines = list ? list.reduce((s, g) => s + g.odd.size, 0) : 0;
      return `
        <button type="button" class="gl-check sev-${c.sev} ${settings.check === c.id ? 'active' : ''} ${n === 0 ? 'clean' : ''}" data-check="${c.id}" ${n == null ? 'disabled' : ''}>
          <span class="gl-check-n">${n == null ? '—' : n === 0 ? '✓' : n}</span>
          <span class="gl-check-t">${t('gl_c_' + c.id)}</span>
          <span class="muted small">${n == null ? t('gl_not_in_file') : n ? t('gl_lines_n', { n: lines }) : t('gl_none_found')}</span>
        </button>`;
    }).join('');
    const cur = CHECKS.find(c => c.id === settings.check);
    const list = filtered();
    const shown = list.slice(0, st.limit);
    const all = R.checks[cur.id] || [];
    return `
      <div class="card">
        <div class="stats">
          <div class="stat"><b>${R.used}</b><span>${t('gl_lines')}</span></div>
          ${R.moves != null ? `<div class="stat"><b>${R.moves}</b><span>${t('gl_entries')}</span></div>` : ''}
          <div class="stat"><b>${R.accounts}</b><span>${t('gl_accounts')}</span></div>
          ${R.from ? `<div class="stat"><b style="font-size:14px">${R.from} → ${R.to}</b><span>${t('gl_period')}</span></div>` : ''}
        </div>
        ${R.dropped ? `<div class="notice info">${t('gl_dropped', { n: R.dropped })}</div>` : ''}
        ${!R.hasMove ? `<div class="notice warn">${t('gl_no_move')}</div>` : ''}
        <h2 style="margin:6px 0 10px">${t('gl_findings')}</h2>
        <div class="gl-checks">${tiles}</div>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:6px"><h2 style="margin:0">${t('gl_c_' + cur.id)}</h2>
          <span class="badge ${cur.sev === 'high' ? 'bad' : cur.sev === 'medium' ? 'warn' : 'soon'}">${t('gl_sev_' + cur.sev)}</span></div>
        <p class="muted small">${t('gl_d_' + cur.id)}</p>
        ${all.length ? `
          <input type="search" id="glSearch" placeholder="${t('search')}" value="${U.esc(st.query)}" style="min-width:240px;margin-bottom:12px">
          <div id="glList">${shown.map((g, i) => renderGroup(g, i)).join('')}</div>
          ${list.length > shown.length ? `<button class="btn ghost sm" id="glMore" type="button">${t('gl_more', { n: list.length - shown.length })}</button>` : ''}
          ${!list.length ? `<p class="muted">${t('gl_no_search')}</p>` : ''}`
        : `<div class="notice ok">✓ ${t('gl_none_found')}</div>`}
      </div>`;
  }

  function renderGroup(g, i) {
    return `
      <details class="gl-group" data-g="${i}">
        <summary>
          <span class="gl-text">${U.esc(g.title)}</span>
          ${g.sure ? `<span class="badge bad">${t('gl_dup_sure')}</span>` : ''}
          <span class="badge warn">${t('gl_odd_n', { n: g.odd.size })}</span>
          <span class="muted small">${U.esc(g.meta || '')}</span>
          ${g.variants && g.variants.length ? `<span class="muted small">${t('gl_variants')}: ${g.variants.map(v => '“' + U.esc(v) + '”').join(', ')}</span>` : ''}
          ${g.chips ? `<div class="gl-accs">${g.chips.map(a => `
            <span class="gl-acc ${a.odd ? 'odd' : ''}" title="${U.esc(t(a.odd ? 'gl_different' : 'gl_usual'))}">
              ${U.esc(a.name)} <b>×${a.n}</b></span>`).join('')}</div>` : ''}
        </summary>
        <div class="gl-body"></div>
      </details>`;
  }

  function sortedLines(g) {
    if (g.keepOrder) return g.lines;
    return [...g.lines].sort((a, b) => g.odd.has(b.n) - g.odd.has(a.n) || String(a.date).localeCompare(String(b.date)));
  }

  function renderLines(g) {
    const rows = sortedLines(g).slice(0, 500);
    return `
      <div class="table-wrap"><table>
        <thead><tr><th>${t('h_date')}</th><th>${t('gl_h_move')}</th><th>${t('gl_h_account')}</th><th>${t('h_partner')}</th>
          <th>${t('h_label')}</th>${st.map.product >= 0 ? `<th>${t('gl_f_product')}</th>` : ''}
          <th class="num">${t('role_debit')}</th><th class="num">${t('role_credit')}</th>${g.note ? `<th>${t('gl_note')}</th>` : ''}</tr></thead>
        <tbody>${rows.map(l => `
          <tr class="${g.odd.has(l.n) ? 'mismatch' : ''}">
            <td style="white-space:nowrap">${U.esc(l.date || '')}</td><td dir="ltr" style="white-space:nowrap">${U.esc(l.move)}</td>
            <td>${U.esc(l.accName)}</td><td>${U.esc(l.partner)}</td><td>${U.esc(l.label)}${l.ref && l.ref !== l.label ? ` <span class="muted small">${U.esc(l.ref)}</span>` : ''}</td>
            ${st.map.product >= 0 ? `<td>${U.esc(l.product)}</td>` : ''}
            <td class="num">${money(l.debit)}</td><td class="num">${money(l.credit)}</td>
            ${g.note ? `<td class="muted small">${g.odd.has(l.n) ? U.esc(g.note(l)) : ''}</td>` : ''}</tr>`).join('')}
        </tbody></table></div>
      ${g.lines.length > rows.length ? `<p class="muted small">${t('showing', { a: rows.length, b: g.lines.length })}</p>` : ''}`;
  }

  function renderColumns() {
    const opts = sel => `<option value="-1">${t('not_used')}</option>` +
      st.headers.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${U.esc(h || '#' + (i + 1))}</option>`).join('');
    return `
      <details class="card" ${st.error ? 'open' : ''}>
        <summary>${t('detected_cols')}</summary>
        <p class="muted small">${t('gl_cols_hint')}</p>
        <div class="row">
          ${FIELDS.map(f => `<label class="field">${t('gl_f_' + f.k)}<select data-map="${f.k}">${opts(st.map[f.k])}</select></label>`).join('')}
        </div>
        ${st.grouped ? `<p class="muted small" style="margin-top:10px">${t('gl_grouped_note')}</p>` : ''}
      </details>`;
  }

  /* ---------- Export ---------- */
  function exportRows() {
    const head = [t('gl_x_check'), t('gl_x_sev'), t('gl_x_finding'), t('gl_x_status'), t('h_date'), t('gl_h_move'), t('gl_h_account'),
      t('h_partner'), t('h_label'), t('fld_ref'), t('gl_f_product'), t('role_debit'), t('role_credit'), t('gl_note')];
    const aoa = [head];
    for (const c of CHECKS) {
      const list = st.result.checks[c.id];
      if (!list) continue;
      for (const g of list) {
        let context = 0;
        for (const l of sortedLines(g)) {
          const odd = g.odd.has(l.n);
          if (!odd && !g.keepOrder && ++context > 3) continue;   // a few usual lines are enough for context
          aoa.push([t('gl_c_' + c.id), t('gl_sev_' + c.sev), g.title + (g.meta ? ' — ' + g.meta : ''), t(odd ? 'gl_x_check_line' : 'gl_x_context'),
            l.date || '', l.move, l.accName, l.partner, l.label, l.ref, l.product, l.debit || '', l.credit || '', odd && g.note ? g.note(l) : '']);
        }
      }
    }
    return aoa;
  }

  function afterSave(res, aoa) {
    if (String(res).startsWith('unavailable')) {
      U.copyDialog({ message: t('save_failed_msg'), text: U.toTSV(aoa), reason: String(res).split(':')[1] });
    }
  }

  /* ---------- Events ---------- */
  function mount(root) {
    const file = root.querySelector('#glFile');
    const drop = root.querySelector('#glDrop');
    if (drop) U.dropZone(drop, file, onFiles);
    const q = sel => root.querySelector(sel);
    const rerun = () => {
      saveSettings();
      const open = !!(q('.gl-opts') && q('.gl-opts').open);
      if (st.lines.length) analyse();
      App.rerender();
      const o = document.querySelector('.gl-opts'); if (o && open) o.open = true;
    };

    q('#glControl').addEventListener('change', e => { settings.skipControl = e.target.checked; rerun(); });
    q('#glLoose').addEventListener('change', e => { settings.loose = e.target.checked; rerun(); });
    q('#glFuzzy').addEventListener('change', e => { settings.fuzzy = e.target.checked; rerun(); });
    q('#glIgnore').addEventListener('change', e => { settings.ignore = e.target.value; rerun(); });
    q('#glWeekend').addEventListener('change', e => { settings.weekend = e.target.value; rerun(); });
    q('#glFrom').addEventListener('change', e => { settings.from = e.target.value; rerun(); });
    q('#glTo').addEventListener('change', e => { settings.to = e.target.value; rerun(); });

    root.querySelectorAll('[data-check]').forEach(b => b.addEventListener('click', () => {
      settings.check = b.dataset.check; st.query = ''; st.limit = PAGE; saveSettings(); App.rerender();
    }));

    const nw = q('#glNew');
    if (nw) nw.addEventListener('click', () => {
      Object.assign(st, { fileName: '', rows: [], headers: [], lines: [], result: null, error: '', query: '' });
      App.rerender();
    });
    const xl = q('#glXlsx');
    if (xl) xl.addEventListener('click', async () => {
      const aoa = exportRows();
      const name = `GL-findings-${U.safeName(st.fileName.replace(/\.[^.]+$/, ''))}.xlsx`;
      afterSave(await U.downloadXLSX(name, aoa, 'Findings', [26, 9, 40, 12, 11, 18, 34, 26, 34, 14, 24, 12, 12, 22]), aoa);
    });
    const cp = q('#glCopy');
    if (cp) cp.addEventListener('click', () => {
      const text = U.toTSV(exportRows());
      const fallback = () => U.copyDialog({ message: t('copy_manual'), text, reason: 'clipboard' });
      try { navigator.clipboard.writeText(text).then(() => U.toast(t('copied_table')), fallback); } catch (e) { fallback(); }
    });

    root.querySelectorAll('[data-map]').forEach(s => s.addEventListener('change', () => {
      st.map[s.dataset.map] = +s.value; run(); App.rerender();
    }));

    const search = q('#glSearch');
    if (search) search.addEventListener('input', () => {
      st.query = search.value; st.limit = PAGE;
      const pos = search.selectionStart;
      App.rerender();
      const s2 = document.getElementById('glSearch');
      if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); }
    });
    const more = q('#glMore');
    if (more) more.addEventListener('click', () => { st.limit += PAGE; App.rerender(); });

    const list = st.result ? filtered() : [];
    root.querySelectorAll('details.gl-group').forEach(d => d.addEventListener('toggle', () => {
      const body = d.querySelector('.gl-body');
      if (d.open && !body.innerHTML) body.innerHTML = renderLines(list[+d.dataset.g]);
    }));
  }

  return { render, mount, _onFiles: onFiles, _state: st, _settings: settings };
})();
