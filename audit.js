/* Audit Reports: year-end reports for the auditor, built from Odoo Excel exports.
   Trial Balance by Partner: one sheet per year, each account followed by its partner rows,
   grouped like Odoo's Trial Balance, and checked against Odoo's own Trial Balance.
   Inputs (any order, several at once):
   - General Ledger report or Journal Items export (the lines),
   - Odoo Trial Balance export(s) (to compare; also teaches the account groups and decimals),
   - last year's "TB by Partner" file made here (opening balances, so only the new year's GL is needed). */
const Audit = (() => {
  const RE = {
    date: /^(date|accounting date|التاريخ|تاريخ)$/i,
    code: /^(code|account code|الكود|الرمز|رمز|كود)$/i,
    name: /^(account( name)?|اسم الحساب|الحساب|حساب)$/i,
    partner: /^(partner|الشريك|الجهة|الشريك التجاري)$/i,
    debit: /^(debit|مدين)$/i,
    credit: /^(credit|دائن)$/i,
  };
  const INIT_RE = /^\s*(initial balance|opening balance|الرصيد الافتتاحي|رصيد افتتاحي)/i;
  const TB_RE = /initial balance|end balance|الرصيد الافتتاحي|الرصيد الختامي/i;
  const TOTAL_RE = /^\s*(total|grand total|الإجمالي|إجمالي|اجمالي|المجموع)\s*$/i;
  const CODE_RE = /^[\w.\-]*\d[\w.\-]*$/;
  const ACC_RE = /^\s*([\w.\-]*\d[\w.\-]*)\s+(.+)$/;
  const GROUP_RE = /^([\w.]*\d[\w.]*)\s*-\s*([\w.]*\d[\w.]*)\s+(.+)$/;
  const UND_RE = /undistributed|unallocated|unaffected|current year (earnings|profit)|غير موزع|غير الموزع/i;
  const NOP_RE = /^\((no partner|بدون شريك)\)$/i;
  const PL_RE = /expense|cost|fees|salar|wage|depreciation of|amortization of|income|revenue|sales|profit|loss|gain|charges|services|utilities|مصروف|مصاريف|تكلفة|رواتب|إيراد|ايراد|مبيعات|أرباح|خسائر|رسوم/i;
  const BS_RE = /receivable|payable|bank|cash|deposit|capital|equity|retained|land|building|asset|provision|vat|advance|prepaid|accrued|unearned|cheque|investment|acc\. depreciation|accumulated|loan|current account|suspense|transfer|ذمم|بنك|نقد|رأس المال|أصول|مخصص|مجمع/i;
  const NOP = '\u0000';          // partner key for lines without a partner
  const UND_FALLBACK = '~und';    // account key for Undistributed Profits/Losses when its code is unknown

  const st = { coId: null, files: [], busy: '', error: '', tab: null, showPartners: true, query: '', model: null, storedGroups: null };

  /* ---------- Settings (per company) ---------- */
  const SKEY = 'oh_audit_settings';
  const loadAll = () => { try { return JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch (e) { return {}; } };
  const cfg = () => Object.assign({ dec: 'auto', pl: '', undCode: '', undName: '' }, loadAll()[App.companyId] || {});
  function saveCfg(c) {
    const all = loadAll(); all[App.companyId] = c;
    try { localStorage.setItem(SKEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
  }

  /* ---------- Reading ---------- */
  async function readBook(file) {
    const buf = await U.readFile(file);
    const wb = /\.csv$/i.test(file.name)
      ? XLSX.read(new TextDecoder('utf-8').decode(buf).replace(/^﻿/, ''), { type: 'string', raw: true })
      : XLSX.read(buf, { type: 'array', cellDates: true });
    // Text as shown (for dates and decimals) plus the exact stored value of each cell (row.v) for amounts.
    return wb.SheetNames.map(n => {
      const opt = { header: 1, defval: '', blankrows: true, dateNF: 'yyyy-mm-dd' };
      const raw = XLSX.utils.sheet_to_json(wb.Sheets[n], Object.assign({ raw: true }, opt));
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], Object.assign({ raw: false }, opt))
        .map((r, i) => { const out = r.map(c => (c == null ? '' : String(c).trim())); out.v = raw[i] || []; return out; });
      return { name: n, rows };
    });
  }

  function headerInfo(rows) {
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const h = rows[i].map(c => c.replace(/\s+/g, ' ').trim());
      const all = re => h.reduce((a, c, j) => (re.test(c) ? a.concat(j) : a), []);
      const first = re => { const x = all(re); return x.length ? x[0] : -1; };
      const debit = all(RE.debit), credit = all(RE.credit);
      if (!debit.length || !credit.length) continue;
      return { i, debit, credit, date: first(RE.date), code: first(RE.code), name: first(RE.name), partner: first(RE.partner) };
    }
    return null;
  }

  const parse = s => { const p = U.parseNum(s); return p ? p.v : 0; };
  // Amount in column i of a row: the stored number when there is one, else the text.
  const at = (r, i) => (r.v && typeof r.v[i] === 'number' ? r.v[i] : parse(r[i]));
  // Decimals shown in a formatted amount ("1,234.500" → 3). -1 when it can't tell.
  const decOf = s => { const m = String(s).match(/^-?\(?[\d,]*\.(\d+)\)?$/); return m && m[1].length <= 3 ? m[1].length : -1; };
  const cleanP = s => String(s || '').replace(/[‎‏]/g, '').replace(/\s+/g, ' ').trim();
  const dayBefore = iso => new Date(Date.parse(iso + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);

  function dateOrder(rows, col) {
    let dmy = 0, mdy = 0;
    for (const r of rows.slice(0, 3000)) {
      const m = String(r[col] || '').match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-]\d{2,4}/);
      if (!m) continue;
      if (+m[1] > 12) dmy++; else if (+m[2] > 12) mdy++;
    }
    return mdy > dmy ? 'MDY' : 'DMY';
  }

  function datesIn(text) {
    return (String(text).match(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}/g) || []).map(s => U.parseDate(s, 'DMY')).filter(Boolean);
  }

  function classify(sheets) {
    for (const s of sheets) {
      const hi = headerInfo(s.rows);
      if (!hi) continue;
      if (hi.partner >= 0 && hi.debit.length >= 3 && hi.date < 0) return parseOurs(sheets);
      if (hi.date >= 0) return parseGL(s.rows, hi);
      if (hi.debit.length >= 2 && s.rows.slice(0, hi.i + 1).some(r => r.some(c => TB_RE.test(c)))) return parseTB(s.rows, hi);
      if (hi.debit.length >= 2) return parseTB(s.rows, hi);
    }
    throw new Error(t('au_unknown_file'));
  }

  function parseGL(rows, hi) {
    const data = rows.slice(hi.i + 1);
    const order = dateOrder(data, hi.date);
    const lines = [], init = [], names = {};
    let cur = '', dec = -1;
    const nameCol = hi.name >= 0 ? hi.name : (hi.code >= 0 ? hi.code + 1 : 0);
    for (const r of data) {
      if (!r.some(c => c)) continue;
      const date = U.parseDate(r[hi.date] || '', order);
      if (!date) {
        // Account title row ("1010201 | NBK Current Account", or "1010201 NBK Current Account" in one cell).
        const code = hi.code >= 0 ? r[hi.code] : '';
        if (code && CODE_RE.test(code) && r[nameCol] && !INIT_RE.test(r[nameCol])) { cur = code; if (!names[cur]) names[cur] = r[nameCol]; continue; }
        if (hi.code < 0) {
          const m = (r.find(c => c) || '').match(ACC_RE);
          if (m && !INIT_RE.test(m[0]) && !TOTAL_RE.test(m[0])) { cur = m[1]; if (!names[cur]) names[cur] = m[2]; continue; }
        }
        if (cur && r.some(c => INIT_RE.test(c))) init.push({ code: cur, d: Math.abs(at(r, hi.debit[0])), c: Math.abs(at(r, hi.credit[0])) });
        continue;
      }
      let code = cur;
      if (hi.code < 0 && hi.name >= 0) {           // Journal Items export: the account is on every line
        const m = (r[hi.name] || '').match(ACC_RE);
        if (m) { code = m[1]; if (!names[code]) names[code] = m[2]; }
      }
      if (!code) continue;
      const ds = r[hi.debit[0]], cs = r[hi.credit[0]];
      dec = Math.max(dec, decOf(ds), decOf(cs));
      lines.push({ date, code, p: cleanP(hi.partner >= 0 ? r[hi.partner] : '') || NOP, d: Math.abs(at(r, hi.debit[0])), c: Math.abs(at(r, hi.credit[0])) });
    }
    if (!lines.length) throw new Error(t('au_gl_empty'));
    const dates = lines.map(l => l.date).sort();
    return { kind: 'gl', lines, init, names, dec, from: dates[0], to: dates[dates.length - 1] };
  }

  function pairsOf(hi) {
    const n = Math.min(hi.debit.length, hi.credit.length);
    return Array.from({ length: n }, (_, k) => [hi.debit[k], hi.credit[k]]);
  }

  function parseTB(rows, hi) {
    const pairs = pairsOf(hi);
    if (pairs.length < 2) throw new Error(t('au_unknown_file'));
    const top = rows.slice(0, hi.i).map(r => r.join(' ')).join(' ');
    const ds = datesIn(top);
    const to = ds.length ? ds[ds.length - 1] : '';
    const from = ds.length >= 2 ? ds[0] : to ? to.slice(0, 4) + '-01-01' : '';
    const codeCol = hi.code, nameCol = hi.name >= 0 ? hi.name : (hi.code >= 0 ? hi.code + 1 : 0);
    const accounts = [], groups = [], names = {};
    let dec = -1, und = null;
    for (const r of rows.slice(hi.i + 1)) {
      if (!r.some(c => c)) continue;
      let code = codeCol >= 0 ? r[codeCol] : '', name = r[nameCol] || '';
      if (codeCol < 0) { const m = name.match(ACC_RE); if (m && !GROUP_RE.test(name)) { code = m[1]; name = m[2]; } }
      const v = pairs.map(([d, c]) => { dec = Math.max(dec, decOf(r[d]), decOf(r[c])); return at(r, d) - at(r, c); });
      const dsum = pairs.slice(1, -1).reduce((s, [d]) => s + at(r, d), 0);
      const csum = pairs.slice(1, -1).reduce((s, [, c]) => s + at(r, c), 0);
      if (code && CODE_RE.test(code)) {
        accounts.push({ code, name, ob: v[0], pd: dsum, pc: csum, cb: v[v.length - 1] });
        names[code] = name;
        if (!und && UND_RE.test(name)) und = { code, name };
        continue;
      }
      const g = name.match(GROUP_RE);
      if (g) groups.push({ from: g[1], to: g[2], name: g[3] });
    }
    if (!accounts.length) throw new Error(t('au_unknown_file'));
    return { kind: 'tb', from, to, accounts, groups, names, dec, und };
  }

  function parseOurs(sheets) {
    let best = null;
    for (const s of sheets) {
      const hi = headerInfo(s.rows);
      if (!hi || hi.partner < 0 || hi.debit.length < 3) continue;
      const ds = datesIn(s.rows.slice(0, hi.i).map(r => r.join(' ')).join(' '));
      const ym = s.name.match(/\b(19|20)\d{2}\b/);
      const end = ds.length ? ds[ds.length - 1] : ym ? ym[0] + '-12-31' : '';
      if (end && (!best || end > best.end)) best = { s, hi, end };
    }
    if (!best) throw new Error(t('au_unknown_file'));
    const { s, hi, end } = best;
    const [dC, cC] = pairsOf(hi).slice(-1)[0];
    const nameCol = hi.name >= 0 ? hi.name : hi.code + 1;
    const rows = [], groups = [], names = {};
    let cur = null, dec = -1, und = null;
    for (const r of s.rows.slice(hi.i + 1)) {
      if (!r.some(c => c)) continue;
      const code = hi.code >= 0 ? r[hi.code] : '', name = r[nameCol] || '', partner = cleanP(r[hi.partner]);
      if (code && CODE_RE.test(code)) {
        cur = { code, und: UND_RE.test(name) };
        names[code] = name;
        if (cur.und && !und) und = { code, name };
        continue;
      }
      if (!partner) {
        if (TOTAL_RE.test(name)) { cur = null; continue; }
        const g = name.match(GROUP_RE);
        if (g) { groups.push({ from: g[1], to: g[2], name: g[3] }); cur = null; continue; }
        if (UND_RE.test(name)) { cur = { code: '', und: true }; if (!und) und = { code: '', name }; continue; }
        cur = null;
        continue;
      }
      if (!cur) continue;
      dec = Math.max(dec, decOf(r[dC]), decOf(r[cC]));
      const net = at(r, dC) - at(r, cC);
      rows.push({ code: cur.code, und: cur.und, p: NOP_RE.test(partner) ? NOP : partner, net });
    }
    return { kind: 'ours', end, year: end.slice(0, 4), rows, groups, names, dec, und };
  }

  /* ---------- Model ---------- */
  function guessPL(names, groups) {
    const votes = {};
    const vote = (code, text) => {
      const d = String(code)[0];
      if (!/\d/.test(d)) return;
      const v = votes[d] || (votes[d] = { pl: 0, bs: 0 });
      if (BS_RE.test(text)) v.bs++; else if (PL_RE.test(text)) v.pl++;
    };
    for (const [code, name] of Object.entries(names)) vote(code, name);
    for (const g of groups) vote(g.from, g.name);
    const out = Object.keys(votes).sort().filter(d => votes[d].pl >= 3 && votes[d].pl / (votes[d].pl + votes[d].bs) >= 0.7);
    return out.length ? out.join(',') : '4,5,6';
  }

  function build() {
    const c = cfg();
    const gls = st.files.filter(f => f.kind === 'gl');
    const tbs = st.files.filter(f => f.kind === 'tb');
    const ours = st.files.filter(f => f.kind === 'ours').sort((a, b) => b.end.localeCompare(a.end))[0] || null;
    const tbDec = [...tbs, ...(ours ? [ours] : [])].map(f => f.dec).find(d => d >= 0);
    const glDec = Math.max(-1, ...gls.map(f => f.dec));
    const autoDec = tbDec != null ? tbDec : glDec >= 0 ? glDec : 2;
    const dec = c.dec === 'auto' ? autoDec : +c.dec;
    const UNIT = Math.pow(10, dec);
    const toInt = v => Math.round(v * UNIT);

    const names = {};
    for (const f of [...gls, ...(ours ? [ours] : []), ...tbs]) Object.assign(names, f.names);
    const fileGroups = (tbs.find(f => f.groups.length) || {}).groups || (ours && ours.groups.length ? ours.groups : null);
    const groups = fileGroups || st.storedGroups || [];
    const found = (tbs.find(f => f.und) || {}).und || (ours && ours.und) || null;
    const und = { code: c.undCode || (found && found.code) || '', name: c.undName || (found && found.name) || t('au_und_default') };
    const UNDK = und.code || UND_FALLBACK;
    names[UNDK] = und.name;
    const plGuess = guessPL(names, groups);
    const plText = c.pl || plGuess;
    const plList = plText.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const isPL = code => code !== UNDK && plList.some(p => code.startsWith(p));

    const lines = [];
    let dropped = 0;
    if (ours) {
      for (const r of ours.rows) {
        const code = r.und ? UNDK : r.code;
        const v = toInt(r.net);
        lines.push({ date: ours.end, code, p: r.p, D: Math.max(v, 0), C: Math.max(-v, 0) });
      }
    }
    for (const f of gls) {
      if (!ours && f.init.length) {
        const date = dayBefore(f.from);
        for (const l of f.init) lines.push({ date, code: l.code, p: NOP, D: toInt(l.d), C: toInt(l.c) });
      }
      for (const l of f.lines) {
        if (ours && l.date <= ours.end) { dropped++; continue; }
        lines.push({ date: l.date, code: l.code, p: l.p, D: toInt(l.d), C: toInt(l.c) });
      }
    }
    const glDates = gls.flatMap(f => [f.from, f.to]).sort();
    let years = [];
    if (glDates.length) {
      const y0 = ours ? +ours.year + 1 : +glDates[0].slice(0, 4), y1 = +glDates[glDates.length - 1].slice(0, 4);
      for (let y = y0; y <= y1; y++) years.push(String(y));
    }
    // An Undistributed Profits/Losses account without a code sorts after the last balance sheet account.
    const bsCodes = Object.keys(names).filter(k => k !== UNDK && !isPL(k)).sort(cmpCode);
    const sortKey = code => (code === UND_FALLBACK ? (bsCodes[bsCodes.length - 1] || '') + '~' : code);

    return {
      dec, autoDec, UNIT, names, groups, groupsFrom: fileGroups ? 'file' : groups.length ? 'stored' : 'none',
      und, UNDK, plText, plGuess, isPL, lines, dropped, years, ours, tbs, gls, sortKey, cache: {},
    };
  }

  const cmpCode = (a, b) => a.localeCompare(b, undefined, { numeric: true });

  /* Trial balance for a period, exactly like Odoo: income/expense accounts restart at the fiscal year (1 Jan),
     and their earlier result sits in the opening balance of Undistributed Profits/Losses. */
  function tbFor(m, from, to) {
    const key = from + '|' + to;
    if (m.cache[key]) return m.cache[key];
    const fy = from.slice(0, 4) + '-01-01';
    const acc = new Map();
    const get = (code, p) => {
      let a = acc.get(code); if (!a) acc.set(code, a = new Map());
      let r = a.get(p); if (!r) a.set(p, r = { o: 0, d: 0, c: 0 });
      return r;
    };
    for (const l of m.lines) {
      if (l.date > to) continue;
      if (l.date >= from) { const r = get(l.code, l.p); r.d += l.D; r.c += l.C; }
      else if (m.isPL(l.code) && l.date < fy) { if (l.D !== l.C) get(m.UNDK, NOP).o += l.D - l.C; }
      else get(l.code, l.p).o += l.D - l.C;
    }
    const accts = [...acc.entries()].map(([code, pm]) => {
      let parts = [...pm.entries()].map(([p, r]) => ({ p, o: r.o, d: r.d, c: r.c, cl: r.o + r.d - r.c })).filter(x => x.o || x.d || x.c);
      if (!parts.length) parts = [{ p: NOP, o: 0, d: 0, c: 0, cl: 0 }];
      parts.sort((a, b) => (a.p === NOP) - (b.p === NOP) || a.p.localeCompare(b.p));
      const s = { o: 0, d: 0, c: 0, cl: 0 };
      for (const x of parts) { s.o += x.o; s.d += x.d; s.c += x.c; s.cl += x.cl; }
      return Object.assign({ code, show: code === UND_FALLBACK ? '' : code, name: m.names[code] || '', sk: m.sortKey(code), parts }, s);
    }).sort((a, b) => cmpCode(a.sk, b.sk));
    return (m.cache[key] = { from, to, accts, items: layout(m, accts), total: sumOf(accts) });
  }

  const split = v => (v >= 0 ? [v, 0] : [0, -v]);
  function sumOf(accts) {
    const s = { oD: 0, oC: 0, d: 0, c: 0, clD: 0, clC: 0 };
    for (const a of accts) {
      const [oD, oC] = split(a.o), [clD, clC] = split(a.cl);
      s.oD += oD; s.oC += oC; s.d += a.d; s.c += a.c; s.clD += clD; s.clC += clC;
    }
    return s;
  }

  // Odoo's account groups: an account belongs to a group when its code prefix falls in the group's range.
  function groupPath(groups, code) {
    return groups.filter(g => { const p = code.slice(0, g.from.length); return p >= g.from && p <= g.to; })
      .sort((a, b) => a.from.length - b.from.length || cmpCode(b.to, a.to) || cmpCode(a.from, b.from));
  }

  function layout(m, accts) {
    if (!m.groups.length) return accts.map(a => ({ type: 'acc', a }));
    const NOG = { from: '', to: '', name: t('au_no_group'), none: true };
    const withPath = accts.map(a => ({ a, path: groupPath(m.groups, a.code === UND_FALLBACK ? '' : a.code) }));
    const grouped = withPath.filter(x => x.path.length), loose = withPath.filter(x => !x.path.length).map(x => ({ a: x.a, path: [NOG] }));
    const items = [];
    let prev = [];
    for (const x of [...grouped, ...loose]) {
      let k = 0;
      while (k < prev.length && k < x.path.length && prev[k] === x.path[k]) k++;
      for (let j = k; j < x.path.length; j++) {
        const g = x.path[j];
        const members = [...grouped, ...loose].filter(y => y.path.includes(g)).map(y => y.a);
        items.push({ type: 'group', g, depth: j, s: sumOf(members) });
      }
      items.push({ type: 'acc', a: x.a, depth: x.path.length });
      prev = x.path;
    }
    return items;
  }

  function compare(m, tb) {
    const ours = tbFor(m, tb.from, tb.to);
    const byCode = new Map(ours.accts.map(a => [a.code, a]));
    const toInt = v => Math.round(v * m.UNIT);
    const out = [], seen = new Set();
    const push = (code, name, odoo, me) => {
      const fields = [['ob', 'au_f_opening'], ['pd', 'au_f_debit'], ['pc', 'au_f_credit'], ['cb', 'au_f_closing']];
      for (const [f, label] of fields) {
        const diff = me[f] - odoo[f];
        if (Math.abs(diff) > 1) out.push({ code, name, what: t(label), odoo: odoo[f], me: me[f], diff });
      }
    };
    for (const a of tb.accounts) {
      const key = a.code === m.und.code ? m.UNDK : a.code;
      seen.add(key);
      const mine = byCode.get(key);
      push(a.code, a.name, { ob: toInt(a.ob), pd: toInt(a.pd), pc: toInt(a.pc), cb: toInt(a.cb) },
        mine ? { ob: mine.o, pd: mine.d, pc: mine.c, cb: mine.cl } : { ob: 0, pd: 0, pc: 0, cb: 0 });
    }
    for (const a of ours.accts) {
      if (seen.has(a.code)) continue;
      push(a.show, a.name, { ob: 0, pd: 0, pc: 0, cb: 0 }, { ob: a.o, pd: a.d, pc: a.c, cb: a.cl });
    }
    return { tb, n: tb.accounts.length, diffs: out, accounts: new Set(out.map(d => d.code)).size };
  }

  function model() {
    if (!st.model) st.model = build();
    return st.model;
  }

  /* ---------- Files ---------- */
  async function onFiles(list) {
    const files = [...list];
    st.error = '';
    for (const file of files) {
      st.busy = file.name; App.rerender();
      await new Promise(r => setTimeout(r, 30));
      try {
        if (/\.pdf$/i.test(file.name)) throw new Error(t('au_need_excel'));
        const parsed = classify(await readBook(file));
        st.files = st.files.filter(f => f.name !== file.name);
        st.files.push(Object.assign({ id: U.uid(), name: file.name }, parsed));
      } catch (e) {
        st.error = `${file.name}: ${e.message || e}`;
      }
    }
    st.busy = '';
    await learn();
    st.model = null; st.tab = null;
    App.rerender();
  }

  // Keep what a Trial Balance teaches (groups, Undistributed account) for next time.
  async function learn() {
    const src = st.files.find(f => f.kind === 'tb' && f.groups.length) || st.files.find(f => f.kind === 'ours' && f.groups.length);
    if (src) { st.storedGroups = src.groups; await Store.set(`co:${App.companyId}:groups`, src.groups); }
    const und = (st.files.find(f => f.kind === 'tb' && f.und) || {}).und;
    const c = cfg();
    if (und && und.code && !c.undCode) { c.undCode = und.code; c.undName = und.name; saveCfg(c); }
  }

  /* ---------- Rendering ---------- */
  const money = (v, m) => (v ? (v / m.UNIT).toLocaleString('en-US', { minimumFractionDigits: m.dec, maximumFractionDigits: m.dec }) : '');
  const fd = iso => U.fmtDate(iso, 'DD/MM/YYYY');
  const pName = p => (p === NOP ? t('au_no_partner') : p);

  function render() {
    if (st.coId !== App.companyId) {
      Object.assign(st, { coId: App.companyId, files: [], error: '', model: null, tab: null, storedGroups: null, query: '' });
    }
    const has = st.files.length > 0;
    const m = has ? model() : null;
    return `
      <div class="page-head"><h1>${t('au_title')}</h1><p class="muted">${t('au_sub')}</p></div>
      <div class="card">
        <h2 style="margin-top:0">${t('au_tb_title')}</h2>
        ${has ? renderFiles(m) : `
          <div class="drop" id="auDrop" tabindex="0" role="button">
            <b>${t('au_drop')}</b><span class="muted">${t('au_drop_sub')}</span>
          </div>
          <ul class="muted small au-how">${['au_how1', 'au_how2', 'au_how3'].map(k => `<li>${t(k)}</li>`).join('')}</ul>`}
        <input type="file" id="auFile" accept=".xlsx,.xls,.csv" multiple hidden>
        ${has ? renderSettings(m) : ''}
      </div>
      ${st.busy ? `<div class="card"><span class="spinner"></span> ${U.esc(t('reading', { f: st.busy }))}</div>` : ''}
      ${st.error ? `<div class="notice bad">${U.esc(st.error)}</div>` : ''}
      ${m ? renderResult(m) : ''}`;
  }

  function renderFiles(m) {
    const desc = f => {
      if (f.kind === 'gl') return t('au_k_gl_d', { n: f.lines.length.toLocaleString('en-US'), a: fd(f.from), b: fd(f.to) });
      if (f.kind === 'tb') return t('au_k_tb_d', { a: fd(f.from), b: fd(f.to), n: f.accounts.length });
      return t('au_k_ours_d', { y: f.year });
    };
    return `
      ${st.files.map(f => `
        <div class="list-item">
          <span class="badge ${f.kind === 'gl' ? 'ok' : f.kind === 'tb' ? 'warn' : 'soon'}">${t('au_k_' + f.kind)}</span>
          <b>${U.esc(f.name)}</b><span class="muted small">${U.esc(desc(f))}</span>
          <span class="spacer"></span>
          <button class="btn ghost sm" data-rm="${f.id}" type="button">${t('au_remove')}</button>
        </div>`).join('')}
      <div class="row" style="margin-top:10px">
        <button class="btn ghost" id="auAdd" type="button">${t('au_add')}</button>
        <button class="btn ghost" id="auReset" type="button">${t('au_reset')}</button>
      </div>
      ${!m.gls.length ? `<div class="notice warn" style="margin-top:10px">${t('au_need_gl')}</div>` : ''}
      ${m.dropped ? `<div class="notice info" style="margin-top:10px">${t('au_dropped', { n: m.dropped, d: fd(m.ours.end) })}</div>` : ''}
      ${m.gls.length && m.groupsFrom === 'none' ? `<div class="notice info" style="margin-top:10px">${t('au_no_groups')}</div>` : ''}`;
  }

  function renderSettings(m) {
    const c = cfg();
    return `
      <details class="gl-opts" id="auOpts" style="margin-top:12px">
        <summary>${t('au_options')}</summary>
        <div class="row" style="margin-top:10px;align-items:flex-end">
          <label class="field">${t('au_dec')}
            <select id="auDec">
              <option value="auto" ${c.dec === 'auto' ? 'selected' : ''}>${t('au_dec_auto', { n: m.autoDec })}</option>
              ${[0, 1, 2, 3].map(n => `<option value="${n}" ${c.dec === String(n) ? 'selected' : ''}>${n}</option>`).join('')}
            </select></label>
          <label class="field">${t('au_pl')}
            <input id="auPL" value="${U.esc(c.pl)}" placeholder="${U.esc(m.plGuess)}" dir="ltr" style="width:120px"></label>
          <label class="field">${t('au_und_code')}
            <input id="auUndCode" value="${U.esc(c.undCode)}" placeholder="${U.esc(m.und.code || '—')}" dir="ltr" style="width:110px"></label>
          <label class="field">${t('au_und_name')}
            <input id="auUndName" value="${U.esc(c.undName)}" placeholder="${U.esc(m.und.name)}" style="min-width:220px"></label>
        </div>
        <p class="muted small" style="margin:8px 0 0">${t('au_pl_hint', { p: m.plText })} ${t('au_groups_n', { n: m.groups.length })}</p>
      </details>`;
  }

  function renderResult(m) {
    if (!m.years.length) return '';
    const tabs = [...m.years, ...(m.tbs.length ? ['check'] : [])];
    if (!tabs.includes(st.tab)) st.tab = m.years[m.years.length - 1];
    const checks = m.tbs.map(tb => compare(m, tb));
    const bad = checks.filter(x => x.diffs.length).length;
    return `
      <div class="card">
        <div class="row" style="margin-bottom:10px">
          <button class="btn" id="auXlsx" type="button">${t('au_download')}</button>
          ${m.tbs.length ? `<span class="badge ${bad ? 'bad' : 'ok'}">${bad ? t('au_check_bad', { n: bad }) : t('au_check_ok')}</span>` : `<span class="muted small">${t('au_check_hint')}</span>`}
        </div>
        <div class="tabs">${tabs.map(k => `<button type="button" data-tab="${k}" class="${st.tab === k ? 'active' : ''}">${k === 'check' ? t('au_check_tab') : k}</button>`).join('')}</div>
        ${st.tab === 'check' ? renderChecks(m, checks) : renderYear(m, st.tab)}
      </div>`;
  }

  function renderYear(m, year) {
    const tb = tbFor(m, `${year}-01-01`, `${year}-12-31`);
    const s = tb.total;
    const ok = s.oD === s.oC && s.d === s.c && s.clD === s.clC;
    const q = U.norm(st.query);
    const partnerHit = (a, x) => q && U.norm(pName(x.p)).includes(q);
    const accHit = a => !q || U.norm(a.show + ' ' + a.name).includes(q) || a.parts.some(x => partnerHit(a, x));
    const cells = (o, d, c, cl) => { const [oD, oC] = split(o), [clD, clC] = split(cl); return [oD, oC, d, c, clD, clC].map(v => `<td class="num">${money(v, m)}</td>`).join(''); };
    const rows = [];
    for (const it of tb.items) {
      if (it.type === 'group') {
        if (q) continue;
        const g = it.s;
        rows.push(`<tr class="au-group"><td></td><td colspan="2" style="padding-inline-start:${9 + it.depth * 14}px">${U.esc(it.g.none ? it.g.name : `${it.g.from}-${it.g.to} ${it.g.name}`)}</td>
          ${[g.oD, g.oC, g.d, g.c, g.clD, g.clC].map(v => `<td class="num">${money(v, m)}</td>`).join('')}</tr>`);
        continue;
      }
      const a = it.a;
      if (!accHit(a)) continue;
      rows.push(`<tr class="au-acc"><td dir="ltr">${U.esc(a.show)}</td><td colspan="2">${U.esc(a.name)}</td>${cells(a.o, a.d, a.c, a.cl)}</tr>`);
      if (!st.showPartners) continue;
      const accMatch = !q || U.norm(a.show + ' ' + a.name).includes(q);
      for (const x of a.parts) {
        if (!accMatch && !partnerHit(a, x)) continue;
        rows.push(`<tr class="au-part"><td></td><td></td><td class="${x.p === NOP ? 'muted' : ''}">${U.esc(pName(x.p))}</td>${cells(x.o, x.d, x.c, x.cl)}</tr>`);
      }
    }
    const nParts = tb.accts.reduce((n, a) => n + a.parts.length, 0);
    return `
      <div class="stats">
        <div class="stat"><b>${tb.accts.length}</b><span>${t('au_accounts')}</span></div>
        <div class="stat"><b>${nParts}</b><span>${t('au_partner_rows')}</span></div>
        <div class="stat"><b style="font-size:14px">${fd(tb.from)} → ${fd(tb.to)}</b><span>${t('au_period_l')}</span></div>
      </div>
      <div class="notice ${ok ? 'ok' : 'bad'}">${ok ? '✓ ' + t('au_balanced') : t('au_unbalanced')}</div>
      <div class="row" style="margin:10px 0">
        <input type="search" id="auSearch" placeholder="${t('au_search')}" value="${U.esc(st.query)}" style="min-width:240px">
        <label class="row" style="gap:6px"><input type="checkbox" id="auParts" ${st.showPartners ? 'checked' : ''}> ${t('au_show_partners')}</label>
      </div>
      <div class="table-wrap au-table"><table>
        <thead>
          <tr><th></th><th colspan="2"></th><th class="num" colspan="2">${t('au_opening')}</th><th class="num" colspan="2">${t('au_movement', { y: year })}</th><th class="num" colspan="2">${t('au_closing')}</th></tr>
          <tr><th>${t('au_code')}</th><th>${t('au_account')}</th><th>${t('h_partner')}</th>
            ${[1, 2, 3].map(() => `<th class="num">${t('role_debit')}</th><th class="num">${t('role_credit')}</th>`).join('')}</tr>
        </thead>
        <tbody>${rows.join('')}
          <tr class="au-total"><td></td><td colspan="2">${t('au_total')}</td>${[s.oD, s.oC, s.d, s.c, s.clD, s.clC].map(v => `<td class="num">${money(v, m)}</td>`).join('')}</tr>
        </tbody></table></div>`;
  }

  function renderChecks(m, checks) {
    return checks.map(x => `
      <h3 style="margin:14px 0 6px">${t('au_check_for', { f: x.tb.name, a: fd(x.tb.from), b: fd(x.tb.to) })}</h3>
      ${!x.diffs.length ? `<div class="notice ok">✓ ${t('au_match_all', { n: x.n })}</div>` : `
        <div class="notice bad">${t('au_match_some', { n: x.accounts, m: x.n })}</div>
        <div class="table-wrap"><table>
          <thead><tr><th>${t('au_code')}</th><th>${t('au_account')}</th><th>${t('au_what')}</th>
            <th class="num">${t('au_odoo')}</th><th class="num">${t('au_this_tool')}</th><th class="num">${t('au_diff')}</th></tr></thead>
          <tbody>${x.diffs.map(d => `<tr class="mismatch"><td dir="ltr">${U.esc(d.code)}</td><td>${U.esc(d.name)}</td><td>${U.esc(d.what)}</td>
            <td class="num">${money(d.odoo, m) || '0'}</td><td class="num">${money(d.me, m) || '0'}</td><td class="num">${money(d.diff, m)}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="muted small">${t('au_diff_hint')}</p>`}`).join('');
  }

  /* ---------- Excel ---------- */
  function numFmt(dec) { return dec ? `#,##0.${'0'.repeat(dec)};-#,##0.${'0'.repeat(dec)};"-"` : '#,##0;-#,##0;"-"'; }

  function yearSheet(m, year) {
    const tb = tbFor(m, `${year}-01-01`, `${year}-12-31`);
    const v = x => x / m.UNIT;
    const six = (o, d, c, cl) => { const [oD, oC] = split(o), [clD, clC] = split(cl); return [oD, oC, d, c, clD, clC].map(v); };
    const aoa = [
      [t('au_tb_title'), '', App.company().name],
      [t('au_period_x', { a: fd(tb.from), b: fd(tb.to) })],
      [],
      ['', '', '', t('au_opening'), '', t('au_movement', { y: year }), '', t('au_closing'), ''],
      [t('au_code'), t('au_account'), t('h_partner'), t('role_debit'), t('role_credit'), t('role_debit'), t('role_credit'), t('role_debit'), t('role_credit')],
    ];
    const HEAD = aoa.length;
    const rowsMeta = [];
    for (const it of tb.items) {
      if (it.type === 'group') {
        const g = it.s;
        aoa.push(['', '  '.repeat(it.depth) + (it.g.none ? it.g.name : `${it.g.from}-${it.g.to} ${it.g.name}`), '', ...[g.oD, g.oC, g.d, g.c, g.clD, g.clC].map(v)]);
        rowsMeta[aoa.length - 1] = {};
        continue;
      }
      const a = it.a;
      aoa.push([a.show, a.name, '', ...six(a.o, a.d, a.c, a.cl)]);
      for (const x of a.parts) {
        aoa.push(['', '', pName(x.p), ...six(x.o, x.d, x.c, x.cl)]);
        rowsMeta[aoa.length - 1] = { level: 1 };
      }
    }
    const s = tb.total;
    aoa.push(['', t('au_total'), '', ...[s.oD, s.oC, s.d, s.c, s.clD, s.clC].map(v)]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const z = numFmt(m.dec);
    for (let r = HEAD; r < aoa.length; r++) {
      for (let c = 3; c < 9; c++) { const cell = ws[XLSX.utils.encode_cell({ r, c })]; if (cell && cell.t === 'n') cell.z = z; }
    }
    ws['!cols'] = [12, 46, 40, 15, 15, 15, 15, 15, 15].map(w => ({ wch: w }));
    ws['!rows'] = Array.from({ length: aoa.length }, (_, i) => rowsMeta[i] || {});
    ws['!merges'] = [{ s: { r: 3, c: 3 }, e: { r: 3, c: 4 } }, { s: { r: 3, c: 5 }, e: { r: 3, c: 6 } }, { s: { r: 3, c: 7 }, e: { r: 3, c: 8 } }];
    ws['!autofilter'] = { ref: `A${HEAD}:I${aoa.length}` };
    return { ws, aoa };
  }

  function checkSheet(m) {
    const aoa = [[t('au_check_tab')], []];
    const v = x => x / m.UNIT;
    for (const x of m.tbs.map(tb => compare(m, tb))) {
      aoa.push([t('au_check_for', { f: x.tb.name, a: fd(x.tb.from), b: fd(x.tb.to) })]);
      if (!x.diffs.length) aoa.push([t('au_match_all', { n: x.n })]);
      else {
        aoa.push([t('au_match_some', { n: x.accounts, m: x.n })]);
        aoa.push([t('au_code'), t('au_account'), t('au_what'), t('au_odoo'), t('au_this_tool'), t('au_diff')]);
        for (const d of x.diffs) aoa.push([d.code, d.name, d.what, v(d.odoo), v(d.me), v(d.diff)]);
      }
      aoa.push([]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const z = numFmt(m.dec);
    for (let r = 0; r < aoa.length; r++) for (let c = 3; c < 6; c++) { const cell = ws[XLSX.utils.encode_cell({ r, c })]; if (cell && cell.t === 'n') cell.z = z; }
    ws['!cols'] = [12, 46, 18, 16, 16, 16].map(w => ({ wch: w }));
    return ws;
  }

  async function exportXlsx() {
    const m = model();
    const wb = XLSX.utils.book_new();
    let last = null;
    for (const y of m.years) { const { ws, aoa } = yearSheet(m, y); XLSX.utils.book_append_sheet(wb, ws, y); last = aoa; }
    if (m.tbs.length) XLSX.utils.book_append_sheet(wb, checkSheet(m), t('au_check_sheet').slice(0, 31));
    const yrs = m.years.length > 1 ? `${m.years[0]}-${m.years[m.years.length - 1]}` : m.years[0];
    const name = `TB-by-Partner-${U.safeName(App.company().name)}-${yrs}.xlsx`;
    const res = await U.download(name, new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
    if (String(res).startsWith('unavailable')) {
      const sel = /^\d{4}$/.test(st.tab) ? yearSheet(m, st.tab).aoa : last;
      U.copyDialog({ message: t('save_failed_msg'), text: U.toTSV(sel), reason: String(res).split(':')[1] });
    }
  }

  /* ---------- Events ---------- */
  function mount(root) {
    const q = sel => root.querySelector(sel);
    if (st.storedGroups === null) {
      const co = App.companyId;
      st.storedGroups = [];
      Store.get(`co:${co}:groups`).then(g => {
        if (st.coId !== co || !Array.isArray(g) || !g.length) return;
        st.storedGroups = g; st.model = null;
        if (App.view === 'audit') App.rerender();
      });
    }
    const file = q('#auFile');
    const drop = q('#auDrop');
    if (drop) U.dropZone(drop, file, onFiles);
    else file.addEventListener('change', () => { if (file.files.length) onFiles(file.files); file.value = ''; });
    const add = q('#auAdd'); if (add) add.addEventListener('click', () => file.click());
    const reset = q('#auReset');
    if (reset) reset.addEventListener('click', () => { Object.assign(st, { files: [], error: '', model: null, tab: null, query: '' }); App.rerender(); });
    root.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      st.files = st.files.filter(f => f.id !== b.dataset.rm); st.model = null; App.rerender();
    }));

    const setting = (sel, key) => {
      const el = q(sel); if (!el) return;
      el.addEventListener('change', () => {
        const c = cfg(); c[key] = el.value.trim(); saveCfg(c);
        st.model = null; App.rerender();
        const o = document.getElementById('auOpts'); if (o) o.open = true;
      });
    };
    setting('#auDec', 'dec'); setting('#auPL', 'pl'); setting('#auUndCode', 'undCode'); setting('#auUndName', 'undName');

    root.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { st.tab = b.dataset.tab; App.rerender(); }));
    const parts = q('#auParts'); if (parts) parts.addEventListener('change', () => { st.showPartners = parts.checked; App.rerender(); });
    const search = q('#auSearch');
    if (search) search.addEventListener('input', () => {
      st.query = search.value;
      const pos = search.selectionStart;
      App.rerender();
      const s2 = document.getElementById('auSearch'); if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); }
    });
    const xl = q('#auXlsx'); if (xl) xl.addEventListener('click', exportXlsx);
  }

  return { render, mount, _onFiles: onFiles, _state: st, _tbFor: (from, to) => tbFor(model(), from, to) };
})();
