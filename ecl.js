/* Aged Receivable + ECL working sheet (IFRS 9 provision matrix, the company's own method):
   - Aging from the AR General Ledger: per account, per partner; payments settle the oldest invoices first (FIFO).
   - History: year-end aging of every year from the start year to the current one (GL, or typed for years before Odoo).
   - Max default rate = share of the "> 365 days" band in the average aging + forward-looking rates.
   - Provision % per band = (1,2,3,4,5 ÷ 15) × max default rate; "> 365 days" = 100%.
   - Provision already recorded comes from the allowance account in an uploaded Trial Balance (or typed). */
const AgedECL = (() => {
  const LIMITS = [30, 60, 90, 180, 365];
  const NB = 6;
  const WEIGHTS = [1, 2, 3, 4, 5, 0];
  const ALLOW_RE = /allowance|expected credit|doubtful|impairment|\becl\b|مخصص|خسائر ائتمانية/i;
  const DAY = 864e5;
  // Odoo's opening entry (migrated balances): its lines say "Opening Balance(s)".
  const OPENING_RE = /opening balance|رصيد افتتاحي|الرصيد الافتتاحي|الأرصدة الافتتاحية/i;

  const st = { coId: null, files: [], busy: '', error: '', model: null, tab: 'aged' };

  /* ---------- Settings (per company) ---------- */
  const SKEY = 'oh_ecl_settings';
  const loadAll = () => { try { return JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch (e) { return {}; } };
  const cfg = () => Object.assign({ year: '', start: 2022, exclude: [], rates: { inf: 0, ind: 0, unemp: 0 }, hist: {}, allow: '', manualProv: '', openOld: true },
    loadAll()[App.companyId] || {});
  function saveCfg(c) {
    const all = loadAll(); all[App.companyId] = c;
    try { localStorage.setItem(SKEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
    st.model = null;
  }

  const NOP = () => Audit.io.NOP;
  const pName = p => (p === NOP() ? t('au_no_partner') : p);
  const bandOf = age => { for (let i = 0; i < LIMITS.length; i++) if (age <= LIMITS[i]) return i; return NB - 1; };
  const bandLabel = i => t('ecl_b' + (i + 1));
  const fd = iso => U.fmtDate(iso, 'DD/MM/YYYY');

  /* ---------- Aging ---------- */
  // FIFO per account + partner: each credit settles the oldest open debit (and the other way round).
  function aging(m, asOf) {
    if (m.agingCache[asOf]) return m.agingCache[asOf];
    const end = Date.parse(asOf + 'T00:00:00Z');
    const groups = new Map();
    for (const l of m.lines) {
      if (l.date > asOf || !l.v) continue;
      const k = l.code + '\u0001' + l.p;
      let g = groups.get(k); if (!g) groups.set(k, g = { code: l.code, p: l.p, lines: [] });
      g.lines.push(l);
    }
    const rows = [];
    for (const g of groups.values()) {
      g.lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.n - b.n));
      const open = [];
      for (const l of g.lines) {
        let v = l.v;
        while (v && open.length && Math.sign(open[0].amt) !== Math.sign(v)) {
          const take = Math.min(Math.abs(v), Math.abs(open[0].amt));
          v -= Math.sign(v) * take;
          open[0].amt -= Math.sign(open[0].amt) * take;
          if (!open[0].amt) open.shift();
        }
        if (v) open.push({ date: l.date, move: l.move, label: l.label, amt: v, old: l.old });
      }
      if (!open.length) continue;
      const bands = new Array(NB).fill(0);
      for (const it of open) { it.band = it.old ? NB - 1 : bandOf(Math.round((end - Date.parse(it.date + 'T00:00:00Z')) / DAY)); bands[it.band] += it.amt; }
      rows.push({ code: g.code, p: g.p, bands, total: bands.reduce((s, x) => s + x, 0), items: open });
    }
    rows.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }) || (a.p === NOP()) - (b.p === NOP()) || a.p.localeCompare(b.p));
    return (m.agingCache[asOf] = rows);
  }

  const sumBands = rows => rows.reduce((s, r) => s.map((x, i) => x + r.bands[i]), new Array(NB).fill(0));

  /* ---------- Model ---------- */
  function build() {
    const c = cfg();
    const gls = st.files.filter(f => f.kind === 'gl');
    const tbs = st.files.filter(f => f.kind === 'tb' || f.kind === 'ours');
    if (!gls.length) return { gls, tbs, empty: true };
    const tbDec = tbs.map(f => f.dec).find(d => d >= 0);
    const glDec = Math.max(-1, ...gls.map(f => f.dec));
    const dec = tbDec != null ? tbDec : glDec >= 0 ? glDec : 2;
    const UNIT = Math.pow(10, dec);
    const toInt = v => Math.round(v * UNIT);

    const names = {};
    for (const f of [...gls, ...tbs]) Object.assign(names, f.names);
    const lines = [];
    // A GL exported for one year starts with an "Initial Balance" per account, without partners or dates.
    // Keep it (as "(No partner)", dated the day before the GL starts) so totals still agree with the TB.
    let initTotal = 0;
    for (const f of gls) {
      const date = new Date(Date.parse(f.from + 'T00:00:00Z') - DAY).toISOString().slice(0, 10);
      for (const l of f.init) {
        const v = toInt(l.d) - toInt(l.c);
        if (!v) continue;
        initTotal += v;
        lines.push({ n: lines.length, date, code: l.code, p: NOP(), v, move: t('ecl_init_move'), label: '' });
      }
    }
    for (const f of gls) for (const l of f.lines) {
      const old = c.openOld !== false && OPENING_RE.test(l.label || '');
      lines.push({ n: lines.length, date: l.date, code: l.code, p: l.p, v: toInt(l.d) - toInt(l.c), move: l.move || '', label: l.label || '', old });
    }
    const openCount = lines.filter(l => OPENING_RE.test(l.label)).length;
    const dates = gls.flatMap(f => [f.from, f.to]).sort();
    const glFrom = dates[0], glTo = dates[dates.length - 1];
    const years = [];
    for (let y = +glFrom.slice(0, 4); y <= +glTo.slice(0, 4); y++) years.push(String(y));
    // Last year's ECL file as given to the auditor: its history, rates and ECL are the basis for this year.
    const prevF = st.files.find(f => f.kind === 'eclprev');
    const prev = prevF ? prevF.reports[prevF.sel || 0] : null;
    const next = prev ? String(+prev.year + 1) : '';
    const year = years.includes(c.year) ? c.year : years.includes(next) ? next : years[years.length - 1];
    const asOf = `${year}-12-31`;

    const m = { dec, UNIT, names, lines, glFrom, glTo, years, year, asOf, gls, tbs, initTotal, openCount, prev, prevFile: prevF && prevF.name, agingCache: {} };
    const all = aging(m, asOf);
    const codes = [...new Set(lines.map(l => l.code))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    m.accounts = codes.map(code => {
      const rs = all.filter(r => r.code === code);
      return { code, name: names[code] || '', partners: rs.length, balance: rs.reduce((s, r) => s + r.total, 0), on: !c.exclude.includes(code) };
    });
    const on = new Set(m.accounts.filter(a => a.on).map(a => a.code));
    m.multi = on.size > 1;
    // A customer with a credit balance has paid in advance: left out of both the aging and the ECL
    // (listed only to reconcile the aging with the ledger).
    m.aged = all.filter(r => on.has(r.code) && r.total > 0);
    m.credits = all.filter(r => on.has(r.code) && r.total < 0);
    m.base = m.aged;
    m.baseTotals = sumBands(m.base);

    // History: one row per year-end from the start year to the current year.
    // Years in last year's ECL file are taken exactly as reported to the auditor.
    const prevYears = prev ? Object.keys(prev.hist).sort() : [];
    const start = Math.min(prevYears.length ? +prevYears[0] : +c.start || +year, +year);
    m.hist = [];
    for (let y = start; y <= +year; y++) {
      const ys = String(y);
      if (ys === year) { m.hist.push({ year: ys, src: 'current', v: m.baseTotals }); continue; }
      if (prev && prev.hist[ys]) { m.hist.push({ year: ys, src: 'prior', v: prev.hist[ys].map(toInt) }); continue; }
      const canGL = glFrom <= `${ys}-01-01`;
      const h = c.hist[ys] || {};
      const src = h.src || (canGL ? 'gl' : 'manual');
      const v = src === 'gl'
        ? sumBands(aging(m, `${ys}-12-31`).filter(r => on.has(r.code) && r.total > 0))
        : (h.v || []).concat(new Array(NB).fill(0)).slice(0, NB).map(x => toInt(+x || 0));
      m.hist.push({ year: ys, src, v, canGL });
    }
    m.avg = new Array(NB).fill(0).map((_, i) => m.hist.reduce((s, h) => s + h.v[i], 0) / m.hist.length);
    const avgTot = m.avg.reduce((s, x) => s + x, 0);
    m.share = m.avg.map(x => (avgTot ? x / avgTot : 0));
    m.rates = { inf: +c.rates.inf || 0, ind: +c.rates.ind || 0, unemp: +c.rates.unemp || 0 };
    m.maxRate = m.share[NB - 1] + (m.rates.inf + m.rates.ind + m.rates.unemp) / 100;
    const wsum = WEIGHTS.reduce((s, x) => s + x, 0);
    m.pct = WEIGHTS.map((w, i) => (i === NB - 1 ? 1 : (w / wsum) * m.maxRate));
    m.ecl = m.baseTotals.map((x, i) => x * m.pct[i]);
    m.eclTotal = m.ecl.reduce((s, x) => s + x, 0);

    // Provision already recorded: the allowance account in an uploaded Trial Balance.
    m.allowOptions = [];
    for (const f of tbs) {
      const bal = {};
      if (f.kind === 'tb') for (const a of f.accounts) bal[a.code] = { name: a.name, cb: a.cb };
      else for (const r of f.rows) { const b = bal[r.code] || (bal[r.code] = { name: f.names[r.code] || '', cb: 0 }); b.cb += r.net; }
      const end = f.kind === 'tb' ? f.to : f.end;
      for (const [code, b] of Object.entries(bal)) m.allowOptions.push({ id: f.id + '|' + code, code, name: b.name, cb: toInt(b.cb), end, file: f.name, guess: ALLOW_RE.test(b.name) });
    }
    const pick = m.allowOptions.find(o => o.id === c.allow) || m.allowOptions.find(o => o.code === c.allow.split('|')[1] && o.guess)
      || m.allowOptions.find(o => o.guess && o.end === asOf) || m.allowOptions.find(o => o.guess);
    m.allow = c.allow === 'manual' ? null : pick || null;
    m.tbAllow = m.allow ? -m.allow.cb : null;
    if (prev) {
      // Opening provision = last year's ECL as reported; the TB allowance is only a check.
      m.recorded = toInt(prev.ecl);
      m.allowDiff = m.tbAllow != null && Math.abs(m.tbAllow - m.recorded) > 1;
      // Does last year's reported aging agree with what the GL gives for that year-end?
      if (glFrom <= `${prev.year}-01-01` && prev.hist[prev.year]) {
        const gl = sumBands(aging(m, `${prev.year}-12-31`).filter(r => on.has(r.code) && r.total > 0)).reduce((s, x) => s + x, 0);
        const rep = prev.hist[prev.year].reduce((s, x) => s + toInt(x), 0);
        if (Math.abs(gl - rep) > 1) m.prevCheck = { year: prev.year, gl, rep };
      }
    } else m.recorded = m.allow ? -m.allow.cb : toInt(+c.manualProv || 0);
    m.required = m.eclTotal - m.recorded;

    // Does the aging agree with the Trial Balance?
    m.tbCheck = [];
    for (const a of m.accounts.filter(x => x.on)) {
      const o = m.allowOptions.find(x => x.code === a.code && x.end === asOf);
      if (o) m.tbCheck.push({ code: a.code, aged: a.balance, tb: o.cb, ok: Math.abs(a.balance - o.cb) <= 1 });
    }
    return m;
  }
  const model = () => st.model || (st.model = build());

  /* ---------- Last year's ECL working file (the company's own sheet, or the one made here) ---------- */
  const PREV_RE = {
    year: /^(year|السنة)$/i,
    ecl: /ecl required|المخصص المطلوب حسب/i,
    inf: /inflation|التضخم/i, ind: /industry|القطاع/i, unemp: /unemployment|البطالة/i,
  };
  // Every sheet with a "Year" history table and an "ECL required" row is one report (e.g. Dubai and Kuwait).
  function parsePrevECL(sheets) {
    const out = [];
    for (const s of sheets) {
      const rows = s.rows;
      const val = (r, i) => { const v = r.v && r.v[i]; if (typeof v === 'number') return v; const p = U.parseNum(r[i]); return p ? p.v : null; };
      const label = r => String(r[0] || '').replace(/\s+/g, ' ').trim();
      const hi = rows.findIndex(r => PREV_RE.year.test(label(r)));
      if (hi < 0) continue;
      const hist = {};
      for (let i = hi + 1; i < rows.length; i++) {
        const y = label(rows[i]);
        if (!/^(19|20)\d{2}$/.test(y)) break;
        hist[y] = Array.from({ length: NB }, (_, k) => val(rows[i], 1 + k) || 0);
      }
      const years = Object.keys(hist).sort();
      const eclRow = rows.find(r => PREV_RE.ecl.test(label(r)));
      if (!years.length || !eclRow) continue;
      let ecl = null;   // the row's total = its last number
      for (let i = 1; i < Math.max(eclRow.length, (eclRow.v || []).length); i++) { const x = val(eclRow, i); if (x != null && isFinite(x)) ecl = x; }
      if (ecl == null) continue;
      const rate = re => { const r = rows.find(x => re.test(label(x))); const x = r ? val(r, 1) : null; return x == null ? 0 : Math.abs(x) <= 1 ? +(x * 100).toFixed(4) : x; };
      out.push({ sheet: s.name, year: years[years.length - 1], hist, ecl, rates: { inf: rate(PREV_RE.inf), ind: rate(PREV_RE.ind), unemp: rate(PREV_RE.unemp) } });
    }
    return out;
  }

  // Take last year's forward-looking rates as this year's starting point (they can still be changed).
  function adoptPrev(f) {
    const p = f.reports[f.sel || 0], c = cfg();
    c.rates = Object.assign({}, p.rates);
    c.year = String(+p.year + 1);
    saveCfg(c);
  }

  /* ---------- Files ---------- */
  async function onFiles(list) {
    st.error = '';
    for (const file of [...list]) {
      st.busy = file.name; App.rerender();
      await new Promise(r => setTimeout(r, 30));
      try {
        if (/\.pdf$/i.test(file.name)) throw new Error(t('au_need_excel'));
        const sheets = await Audit.io.readBook(file);
        const reports = parsePrevECL(sheets);
        const parsed = reports.length ? { kind: 'eclprev', reports, sel: 0 } : Audit.io.classify(sheets);
        st.files = st.files.filter(f => f.name !== file.name && !(parsed.kind === 'eclprev' && f.kind === 'eclprev'));
        const f = Object.assign({ id: U.uid(), name: file.name }, parsed);
        st.files.push(f);
        if (f.kind === 'eclprev') adoptPrev(f);
      } catch (e) { st.error = `${file.name}: ${e.message || e}`; }
    }
    st.busy = ''; st.model = null;
    App.rerender();
  }

  /* ---------- Rendering ---------- */
  const money = (v, m) => (Math.abs(v) >= 0.5 ? (v / m.UNIT).toLocaleString('en-US', { minimumFractionDigits: m.dec, maximumFractionDigits: m.dec }) : '');
  const pctTxt = x => (x * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  const accLabel = (m, code) => `${code} ${m.names[code] || ''}`.trim();
  const rowLabel = (m, r) => (m.multi ? `${r.code} · ${pName(r.p)}` : pName(r.p));

  function render() {
    if (st.coId !== App.companyId) Object.assign(st, { coId: App.companyId, files: [], error: '', model: null });
    const has = st.files.length > 0;
    const m = has ? model() : null;
    return `
      <div class="card">
        <h2 style="margin-top:0">${t('ecl_title')}</h2>
        ${has ? renderFiles(m) : `
          <div class="drop" id="eclDrop" tabindex="0" role="button">
            <b>${t('au_drop')}</b><span class="muted">${t('ecl_drop_sub')}</span>
          </div>
          <ul class="muted small au-how">${['ecl_how1', 'ecl_how4', 'ecl_how2', 'ecl_how3'].map(k => `<li>${t(k)}</li>`).join('')}</ul>`}
        <input type="file" id="eclFile" accept=".xlsx,.xls,.csv" multiple hidden>
      </div>
      ${st.busy ? `<div class="card"><span class="spinner"></span> ${U.esc(t('reading', { f: st.busy }))}</div>` : ''}
      ${st.error ? `<div class="notice bad">${U.esc(st.error)}</div>` : ''}
      ${m && !m.empty ? renderSettings(m) + renderResult(m) : ''}`;
  }

  function renderFiles(m) {
    const prevDesc = p => t('ecl_k_prev_d', { y: p.year, a: Object.keys(p.hist).sort()[0], e: p.ecl.toLocaleString('en-US', { maximumFractionDigits: 3 }) });
    const desc = f => (f.kind === 'gl' ? t('au_k_gl_d', { n: f.lines.length.toLocaleString('en-US'), a: fd(f.from), b: fd(f.to) })
      : f.kind === 'tb' ? t('au_k_tb_d', { a: fd(f.from), b: fd(f.to), n: f.accounts.length })
      : f.kind === 'eclprev' ? prevDesc(f.reports[f.sel || 0]) : t('ecl_k_ours_d', { y: f.year }));
    const badge = f => (f.kind === 'gl' ? ['ok', 'ecl_k_gl'] : f.kind === 'eclprev' ? ['soon', 'ecl_k_prev'] : ['warn', 'ecl_k_tb']);
    return `
      ${st.files.map(f => `
        <div class="list-item">
          <span class="badge ${badge(f)[0]}">${t(badge(f)[1])}</span>
          <b>${U.esc(f.name)}</b><span class="muted small">${U.esc(desc(f))}</span>
          ${f.kind === 'eclprev' && f.reports.length > 1 ? `<select data-prevsheet="${f.id}" title="${U.esc(t('ecl_prev_sheet'))}">
            ${f.reports.map((p, i) => `<option value="${i}" ${i === (f.sel || 0) ? 'selected' : ''}>${U.esc(p.sheet)}</option>`).join('')}</select>` : ''}
          <span class="spacer"></span>
          <button class="btn ghost sm" data-rm="${f.id}" type="button">${t('au_remove')}</button>
        </div>`).join('')}
      <div class="row" style="margin-top:10px">
        <button class="btn ghost" id="eclAdd" type="button">${t('au_add')}</button>
        <button class="btn ghost" id="eclReset" type="button">${t('au_reset')}</button>
      </div>
      ${m.empty ? `<div class="notice warn" style="margin-top:10px">${t('ecl_need_gl')}</div>` : ''}
      ${!m.empty && m.initTotal ? `<div class="notice warn" style="margin-top:10px">${t('ecl_init_warn', { v: money(m.initTotal, m), d: fd(m.glFrom) })}</div>` : ''}
      ${!m.empty && m.prev && m.prev.year >= m.year ? `<div class="notice warn" style="margin-top:10px">${t('ecl_prev_year_warn', { y: m.prev.year })}</div>` : ''}
      ${!m.empty && m.prevCheck ? `<div class="notice info" style="margin-top:10px">${t('ecl_prev_check', { y: m.prevCheck.year, r: money(m.prevCheck.rep, m) || '0', g: money(m.prevCheck.gl, m) || '0' })}</div>` : ''}`;
  }

  function renderSettings(m) {
    const c = cfg();
    const opts = m.allowOptions.filter(o => o.guess || o.id === (m.allow && m.allow.id));
    const others = m.allowOptions.filter(o => !opts.includes(o));
    const opt = o => `<option value="${U.esc(o.id)}" ${m.allow && m.allow.id === o.id ? 'selected' : ''}>${U.esc(`${o.code} ${o.name} · ${money(-o.cb, m) || '0'} (${fd(o.end)})`)}</option>`;
    return `
      <div class="card">
        <h2 style="margin-top:0">${t('ecl_setup')}</h2>
        <div class="row" style="align-items:flex-end">
          <label class="field">${t('ecl_asof')}
            <select id="eclYear">${m.years.map(y => `<option value="${y}" ${y === m.year ? 'selected' : ''}>31/12/${y}</option>`).join('')}</select></label>
          <label class="field">${t('ecl_start')}
            <input id="eclStart" type="number" min="2000" max="${m.year}" value="${U.esc(c.start)}" style="width:100px"></label>
          <label class="field">${t('ecl_inf')}<input data-rate="inf" type="number" step="0.01" value="${m.rates.inf}" style="width:90px"></label>
          <label class="field">${t('ecl_ind')}<input data-rate="ind" type="number" step="0.01" value="${m.rates.ind}" style="width:90px"></label>
          <label class="field">${t('ecl_unemp')}<input data-rate="unemp" type="number" step="0.01" value="${m.rates.unemp}" style="width:90px"></label>
        </div>
        <label class="row" style="gap:8px;margin-top:12px"><input type="checkbox" id="eclOpenOld" ${c.openOld !== false ? 'checked' : ''}> ${t('ecl_open_old', { n: m.openCount })}</label>
        <h3 style="margin:14px 0 6px">${t('ecl_accounts')}</h3>
        <p class="muted small" style="margin:0 0 6px">${t('ecl_accounts_hint')}</p>
        ${m.accounts.map(a => `
          <label class="row" style="gap:8px;margin:4px 0">
            <input type="checkbox" data-acc="${U.esc(a.code)}" ${a.on ? 'checked' : ''}>
            <span dir="ltr">${U.esc(a.code)}</span> ${U.esc(a.name)}
            <span class="muted small">${t('ecl_acc_meta', { n: a.partners, b: money(a.balance, m) || '0' })}</span>
          </label>`).join('')}
        <h3 style="margin:14px 0 6px">${t(m.prev ? 'ecl_opening' : 'ecl_recorded')}</h3>
        ${m.prev ? `<p style="margin:0 0 8px">${t('ecl_opening_from', { v: money(m.recorded, m) || '0', y: m.prev.year, f: m.prevFile + (m.prev.sheet ? ' · ' + m.prev.sheet : '') })}</p>
          ${m.allowDiff ? `<div class="notice warn">${t('ecl_allow_diff', { a: money(m.tbAllow, m) || '0', b: money(m.recorded, m) || '0' })}</div>` : ''}` : ''}
        <div class="row" style="align-items:flex-end">
          <label class="field">${t(m.prev ? 'ecl_tb_check_from' : 'ecl_recorded_from')}
            <select id="eclAllow" style="max-width:520px">
              ${opts.map(opt).join('')}
              ${others.length ? `<optgroup label="${U.esc(t('ecl_other_accounts'))}">${others.map(opt).join('')}</optgroup>` : ''}
              <option value="manual" ${!m.allow ? 'selected' : ''}>${t('ecl_type_it')}</option>
            </select></label>
          ${!m.allow && !m.prev ? `<label class="field">${t('ecl_amount')}<input id="eclManual" type="number" step="any" value="${U.esc(c.manualProv)}" style="width:140px"></label>` : ''}
        </div>
        ${!m.allowOptions.length ? `<p class="muted small" style="margin:6px 0 0">${t('ecl_tb_hint')}</p>` : ''}
      </div>`;
  }

  function renderResult(m) {
    return `
      <div class="card">
        <div class="stats">
          <div class="stat"><b>${money(m.aged.reduce((s, r) => s + r.total, 0), m) || '0'}</b><span>${t('ecl_s_aged')}</span></div>
          ${m.credits.length ? `<div class="stat"><b>${money(m.credits.reduce((s, r) => s + r.total, 0), m)}</b><span>${t('ecl_s_credits', { n: m.credits.length })}</span></div>` : ''}
          <div class="stat"><b>${money(m.eclTotal, m) || '0'}</b><span>${t('ecl_s_ecl')}</span></div>
          <div class="stat"><b>${money(m.recorded, m) || '0'}</b><span>${t(m.prev ? 'ecl_s_opening' : 'ecl_s_recorded')}</span></div>
          <div class="stat"><b>${money(m.required, m) || '0'}</b><span>${t(m.prev ? (m.required >= 0 ? 'ecl_charge' : 'ecl_release') : m.required >= 0 ? 'ecl_s_more' : 'ecl_s_less')}</span></div>
        </div>
        ${m.tbCheck.map(x => `<div class="notice ${x.ok ? 'ok' : 'bad'}">${x.ok ? '✓ ' + t('ecl_tb_ok', { a: accLabel(m, x.code) }) : t('ecl_tb_bad', { a: accLabel(m, x.code), x: money(x.aged, m) || '0', y: money(x.tb, m) || '0' })}</div>`).join('')}
        <div class="row" style="margin:10px 0"><button class="btn" id="eclXlsx" type="button">${t('ecl_download')}</button></div>
        <div class="tabs">${['aged', 'ecl'].map(k => `<button type="button" data-etab="${k}" class="${st.tab === k ? 'active' : ''}">${t('ecl_tab_' + k)}</button>`).join('')}</div>
        ${st.tab === 'ecl' ? renderECL(m) : renderAged(m)}
      </div>`;
  }

  const recLabel = m => t(m.prev ? 'ecl_rec_prev' : 'ecl_rec_row', { y: m.prev && m.prev.year });
  const reqLabel = m => t(m.prev ? (m.required >= 0 ? 'ecl_charge' : 'ecl_release') : m.required >= 0 ? 'ecl_req_more' : 'ecl_req_less');
  const srcLabel = h => t({ current: 'ecl_src_current', prior: 'ecl_src_prior', gl: 'ecl_src_gl' }[h.src] || 'ecl_src_manual');
  const bandHead = () => `${Array.from({ length: NB }, (_, i) => `<th class="num">${bandLabel(i)}</th>`).join('')}<th class="num">${t('au_total')}</th>`;
  const bandCells = (m, b, tot) => b.map(v => `<td class="num">${money(v, m)}</td>`).join('') + `<td class="num"><b>${money(tot, m) || '0'}</b></td>`;

  function renderAged(m) {
    const codes = [...new Set([...m.aged, ...m.credits].map(r => r.code))];
    if (!codes.length) return `<p class="muted">${t('ecl_nothing')}</p>`;
    return codes.map(code => {
      const rs = m.aged.filter(r => r.code === code), cr = m.credits.filter(r => r.code === code);
      const tot = sumBands(rs);
      return `
        <h3 style="margin:14px 0 6px">${U.esc(accLabel(m, code))}</h3>
        ${rs.length ? `<div class="table-wrap ecl-wide"><table>
          <thead><tr><th>${t('h_partner')}</th>${bandHead()}</tr></thead>
          <tbody>${rs.map(r => `<tr><td>${U.esc(pName(r.p))}</td>${bandCells(m, r.bands, r.total)}</tr>`).join('')}
            <tr class="au-total"><td>${t('au_total')}</td>${bandCells(m, tot, tot.reduce((s, x) => s + x, 0))}</tr></tbody>
        </table></div>` : `<p class="muted">${t('ecl_nothing')}</p>`}
        ${cr.length ? `<details class="ecl-credits"><summary class="muted small">${t('ecl_credits_excl', { n: cr.length, v: money(cr.reduce((s, x) => s + x.total, 0), m) })}</summary>
          <ul class="small">${cr.map(x => `<li>${U.esc(pName(x.p))}: ${money(x.total, m)}</li>`).join('')}</ul></details>` : ''}`;
    }).join('') + `<p class="muted small">${t('ecl_aged_hint')}</p>`;
  }

  function renderECL(m) {
    const n = x => money(x, m);
    const histRows = m.hist.map(h => `
      <tr>
        <td>${h.year}</td>
        ${h.v.map((v, i) => `<td class="num">${h.src === 'manual'
          ? `<input class="num" data-hist="${h.year}" data-i="${i}" value="${v ? (v / m.UNIT).toFixed(m.dec) : ''}" inputmode="decimal">` : n(v)}</td>`).join('')}
        <td class="num"><b>${n(h.v.reduce((s, x) => s + x, 0)) || '0'}</b></td>
        <td>${h.src === 'current' || h.src === 'prior' ? `<span class="muted small">${t(h.src === 'prior' ? 'ecl_src_prior' : 'ecl_src_current')}</span>` : `
          <select data-src="${h.year}">
            ${h.canGL ? `<option value="gl" ${h.src === 'gl' ? 'selected' : ''}>${t('ecl_src_gl')}</option>` : ''}
            <option value="manual" ${h.src === 'manual' ? 'selected' : ''}>${t('ecl_src_manual')}</option>
          </select>`}</td>
      </tr>`).join('');
    return `
      <h3 style="margin:14px 0 6px">${t('ecl_h_base')}</h3>
      <div class="table-wrap ecl-wide"><table>
        <thead><tr><th>${t('h_partner')}</th>${bandHead()}</tr></thead>
        <tbody>${m.base.map(r => `<tr><td>${U.esc(rowLabel(m, r))}</td>${bandCells(m, r.bands, r.total)}</tr>`).join('')}
          <tr class="au-total"><td>${t('au_total')}</td>${bandCells(m, m.baseTotals, m.baseTotals.reduce((s, x) => s + x, 0))}</tr></tbody>
      </table></div>

      <h3 style="margin:18px 0 6px">${t('ecl_h_hist')}</h3>
      <p class="muted small" style="margin:0 0 6px">${t('ecl_hist_hint')}</p>
      <div class="table-wrap ecl-wide ecl-hist"><table>
        <thead><tr><th>${t('ecl_year')}</th>${bandHead()}<th>${t('ecl_source')}</th></tr></thead>
        <tbody>${histRows}
          <tr class="au-acc"><td>${t('ecl_avg')}</td>${m.avg.map(v => `<td class="num">${n(v)}</td>`).join('')}<td class="num">${n(m.avg.reduce((s, x) => s + x, 0))}</td><td></td></tr>
          <tr class="au-acc"><td>${t('ecl_share')}</td>${m.share.map(v => `<td class="num">${pctTxt(v)}</td>`).join('')}<td class="num">${pctTxt(m.share.reduce((s, x) => s + x, 0))}</td><td></td></tr>
        </tbody>
      </table></div>

      <h3 style="margin:18px 0 6px">${t('ecl_h_matrix')}</h3>
      <p class="small">${t('ecl_max_line', { s: pctTxt(m.share[NB - 1]), f: pctTxt((m.rates.inf + m.rates.ind + m.rates.unemp) / 100), r: pctTxt(m.maxRate) })}</p>
      <div class="table-wrap ecl-wide"><table>
        <thead><tr><th></th>${bandHead()}</tr></thead>
        <tbody>
          <tr><td>${t('ecl_months')}</td>${WEIGHTS.map(w => `<td class="num">${w}</td>`).join('')}<td class="num">${WEIGHTS.reduce((s, x) => s + x, 0)}</td></tr>
          <tr><td>${t('ecl_pct')}</td>${m.pct.map(v => `<td class="num">${pctTxt(v)}</td>`).join('')}<td></td></tr>
          <tr><td>${t('ecl_gross')}</td>${bandCells(m, m.baseTotals, m.baseTotals.reduce((s, x) => s + x, 0))}</tr>
          <tr class="au-acc"><td>${t('ecl_required')}</td>${bandCells(m, m.ecl, m.eclTotal)}</tr>
          <tr><td>${recLabel(m)}</td>${'<td></td>'.repeat(NB)}<td class="num">${n(m.recorded) || '0'}</td></tr>
          <tr class="au-total"><td>${reqLabel(m)}</td>${'<td></td>'.repeat(NB)}<td class="num">${n(m.required) || '0'}</td></tr>
        </tbody>
      </table></div>

      <h3 style="margin:18px 0 6px">${t('ecl_h_partner')}</h3>
      <div class="table-wrap ecl-wide"><table>
        <thead><tr><th>${t('h_partner')}</th>${bandHead()}</tr></thead>
        <tbody>${m.base.map(r => { const e = r.bands.map((v, i) => v * m.pct[i]); return `<tr><td>${U.esc(rowLabel(m, r))}</td>${bandCells(m, e, e.reduce((s, x) => s + x, 0))}</tr>`; }).join('')}
          <tr class="au-total"><td>${t('au_total')}</td>${bandCells(m, m.ecl, m.eclTotal)}</tr></tbody>
      </table></div>`;
  }

  /* ---------- Excel (live formulas and a clean, styled layout for the auditor) ---------- */
  // Styles need the "xlsx-js-style" build of SheetJS. It is loaded only when exporting and kept apart from the
  // normal XLSX (used for reading files). Without it the export still works, just without colours.
  let X = window.XLSX, styledP = null;
  function styledLib() {
    if (!styledP) styledP = new Promise(resolve => {
      const orig = window.XLSX;
      const el = document.createElement('script');
      el.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
      const done = ok => { const lib = window.XLSX; window.XLSX = orig; resolve(ok && lib && lib !== orig ? lib : orig); };
      el.onload = () => done(true);
      el.onerror = () => done(false);
      setTimeout(() => done(false), 15000);
      document.head.appendChild(el);
    });
    return styledP;
  }

  const BRAND = '714B67', SOFT = 'F3ECF1', GREY = 'F2F2F2', LINE = 'BFBFBF';
  const thin = { style: 'thin', color: { rgb: LINE } };
  const box = { top: thin, bottom: thin, left: thin, right: thin };
  const ST = {
    title: { font: { bold: true, sz: 15, color: { rgb: BRAND } } },
    company: { font: { bold: true, sz: 12 } },
    sub: { font: { italic: true, color: { rgb: '595959' } } },
    section: { font: { bold: true, sz: 12, color: { rgb: BRAND } } },
    head: { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: BRAND } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: box },
    headL: { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: BRAND } }, alignment: { horizontal: 'left', vertical: 'center', wrapText: true }, border: box },
    account: { font: { bold: true, color: { rgb: BRAND } }, fill: { fgColor: { rgb: SOFT } }, border: box },
    partner: { font: { bold: true }, border: box },
    item: { font: { sz: 10, color: { rgb: '595959' } }, border: box },
    itemName: { font: { sz: 10, color: { rgb: '595959' } }, alignment: { indent: 2 }, border: box },
    cell: { border: box },
    label: { font: { bold: true }, border: box },
    total: { font: { bold: true }, fill: { fgColor: { rgb: GREY } }, border: { top: { style: 'thin', color: { rgb: '000000' } }, bottom: { style: 'double', color: { rgb: '000000' } }, left: thin, right: thin } },
    key: { font: { bold: true }, fill: { fgColor: { rgb: 'FFF2CC' } }, border: box },
    result: { font: { bold: true, sz: 12 }, fill: { fgColor: { rgb: 'FCE4D6' } }, border: { top: { style: 'medium', color: { rgb: '000000' } }, bottom: { style: 'medium', color: { rgb: '000000' } }, left: thin, right: thin } },
    ok: { font: { bold: true, color: { rgb: '1F7A4D' } }, fill: { fgColor: { rgb: 'E5F4EC' } }, alignment: { horizontal: 'center' }, border: box },
    note: { font: { italic: true, sz: 9, color: { rgb: '7F7F7F' } } },
  };
  const withFmt = (st, z) => (z ? Object.assign({}, st || {}, { numFmt: z }) : st);

  function sheet() {
    const ws = {}; let maxR = 0, maxC = 0;
    const rows = [], merges = [];
    const put = (r, c, cell) => { ws[X.utils.encode_cell({ r, c })] = cell; maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); };
    const s = (r, c, v, st) => put(r, c, { t: 's', v: v == null ? '' : String(v), s: st });
    const nv = (r, c, v, z, st) => put(r, c, { t: 'n', v, z, s: withFmt(st, z) });
    const fm = (r, c, f, v, z, st) => put(r, c, typeof v === 'boolean' ? { t: 'b', v, f, s: st } : { t: 'n', v, f, z, s: withFmt(st, z) });
    // Give empty cells of a row the same look (fill, borders) so the row reads as one band.
    const paint = (r, c0, c1, st) => { for (let c = c0; c <= c1; c++) { const k = X.utils.encode_cell({ r, c }); if (!ws[k]) put(r, c, { t: 's', v: '', s: st }); } };
    const merge = (r, c0, c1) => merges.push({ s: { r, c: c0 }, e: { r, c: c1 } });
    const height = (r, hpt) => { rows[r] = Object.assign({}, rows[r], { hpt }); };
    const done = cols => {
      ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
      ws['!cols'] = cols.map(w => ({ wch: w }));
      ws['!rows'] = Array.from({ length: maxR + 1 }, (_, i) => rows[i] || {});
      ws['!merges'] = merges;
      return ws;
    };
    return { ws, s, nv, fm, paint, merge, height, done, rows };
  }
  const col = c => X.utils.encode_col(c);
  const A1 = (r, c, abs) => (abs ? `$${col(c)}$${r + 1}` : `${col(c)}${r + 1}`);
  function amtFmt(m) { return m.dec ? `#,##0.${'0'.repeat(m.dec)};(#,##0.${'0'.repeat(m.dec)});"-"` : '#,##0;(#,##0);"-"'; }

  function header(S, m, title, lastCol) {
    S.s(0, 0, title, ST.title); S.merge(0, 0, lastCol); S.height(0, 24);
    S.s(1, 0, App.company().name, ST.company); S.merge(1, 0, lastCol);
    S.s(2, 0, `${t('ecl_asof_x', { d: fd(m.asOf) })}  ·  ${t('ecl_x_accounts', { a: m.accounts.filter(a => a.on).map(a => accLabel(m, a.code)).join(', ') })}`, ST.sub);
    S.merge(2, 0, lastCol);
  }

  function agedSheet(m) {
    const S = sheet(), z = amtFmt(m), v = x => x / m.UNIT;
    const C0 = 3, CT = C0 + NB, LAST = CT;          // A partner/entry, B date, C label, D..I bands, J total
    header(S, m, t('ecl_aged_title'), LAST);
    let r = 4;
    S.s(r, 0, t('ecl_x_partner'), ST.headL); S.s(r, 1, t('h_date'), ST.head); S.s(r, 2, t('h_label'), ST.headL);
    for (let i = 0; i < NB; i++) S.s(r, C0 + i, bandLabel(i), ST.head);
    S.s(r, CT, t('au_total'), ST.head); S.height(r, 30);
    r++;
    const accTotals = [];
    for (const code of [...new Set(m.aged.map(x => x.code))]) {
      S.s(r, 0, accLabel(m, code), ST.account); S.paint(r, 1, LAST, ST.account); r++;
      const partnerRows = [];
      for (const row of m.aged.filter(x => x.code === code)) {
        const pr = r;
        S.s(r, 0, pName(row.p), ST.partner); S.paint(r, 1, 2, ST.partner);
        partnerRows.push(pr);
        r++;
        for (const it of row.items) {
          S.s(r, 0, it.move, ST.itemName); S.s(r, 1, fd(it.date), ST.item); S.s(r, 2, it.label, ST.item);
          for (let i = 0; i < NB; i++) if (i !== it.band) S.s(r, C0 + i, '', ST.item);
          S.nv(r, C0 + it.band, v(it.amt), z, ST.item);
          S.fm(r, CT, `SUM(${A1(r, C0)}:${A1(r, CT - 1)})`, v(it.amt), z, ST.item);
          S.rows[r] = { level: 1 };
          r++;
        }
        for (let i = 0; i <= NB; i++) S.fm(pr, C0 + i, `SUM(${A1(pr + 1, C0 + i)}:${A1(r - 1, C0 + i)})`, v(i < NB ? row.bands[i] : row.total), z, ST.partner);
      }
      const tot = sumBands(m.aged.filter(x => x.code === code));
      S.s(r, 0, `${t('au_total')} ${code}`, ST.total); S.paint(r, 1, 2, ST.total);
      for (let i = 0; i <= NB; i++) S.fm(r, C0 + i, partnerRows.map(p => A1(p, C0 + i)).join('+') || '0', v(i < NB ? tot[i] : tot.reduce((a, b) => a + b, 0)), z, ST.total);
      accTotals.push(r);
      r += 2;
    }
    let grand = accTotals[0];
    if (accTotals.length > 1) {
      const all = sumBands(m.aged);
      S.s(r, 0, t('au_total'), ST.result); S.paint(r, 1, 2, ST.result);
      for (let i = 0; i <= NB; i++) S.fm(r, C0 + i, accTotals.map(x => A1(x, C0 + i)).join('+'), v(i < NB ? all[i] : all.reduce((a, b) => a + b, 0)), z, ST.result);
      grand = r; r += 2;
    }

    // Reconciliation to the ledger: customers with a credit balance (paid in advance) are left out of the aging.
    if (grand != null || m.credits.length) {
      S.s(r, 0, t('ecl_x_recon'), ST.section); r++;
      const agedTot = m.aged.reduce((a, x) => a + x.total, 0);
      S.s(r, 0, t('ecl_x_recon_aged'), ST.label); S.paint(r, 1, CT - 1, ST.cell); S.merge(r, 0, CT - 1);
      if (grand != null) S.fm(r, CT, A1(grand, CT), v(agedTot), z, ST.label); else S.nv(r, CT, 0, z, ST.label);
      const ra = r; r++;
      for (const x of m.credits) {
        S.s(r, 0, `${rowLabel(m, x)} — ${t('ecl_credit_bal')}`, ST.cell); S.paint(r, 1, CT - 1, ST.cell); S.merge(r, 0, CT - 1);
        S.nv(r, CT, v(x.total), z, ST.cell); r++;
      }
      S.s(r, 0, t('ecl_x_recon_ledger'), ST.total); S.paint(r, 1, CT - 1, ST.total); S.merge(r, 0, CT - 1);
      S.fm(r, CT, `SUM(${A1(ra, CT)}:${A1(r - 1, CT)})`, v(agedTot + m.credits.reduce((a, x) => a + x.total, 0)), z, ST.total);
      r += 2;
    }
    S.s(r, 0, t('ecl_x_note_aged'), ST.note); S.merge(r, 0, LAST);
    return S.done([50, 12, 46, 15, 15, 15, 15, 15, 15, 16]);
  }

  function eclSheet(m) {
    const S = sheet(), z = amtFmt(m), P = '0.00%', v = x => x / m.UNIT;
    const B0 = 1, TOT = B0 + NB, LAST = TOT + 1;     // bands in B..G, total in H, notes in I
    const sumRow = r => `SUM(${A1(r, B0)}:${A1(r, B0 + NB - 1)})`;
    const head = (r, first) => {
      S.s(r, 0, first, ST.headL);
      for (let i = 0; i < NB; i++) S.s(r, B0 + i, bandLabel(i), ST.head);
      S.s(r, TOT, t('ecl_x_total'), ST.head); S.height(r, 30);
    };
    header(S, m, t('ecl_x_title'), LAST);

    // 1. Customers with a debit balance, by band.
    let r = 4;
    S.s(r, 0, t('ecl_x_s1'), ST.section); r++;
    head(r, t('ecl_x_partner')); r++;
    const first = r;
    for (const row of m.base) {
      S.s(r, 0, rowLabel(m, row), ST.cell);
      row.bands.forEach((x, i) => S.nv(r, B0 + i, v(x), z, ST.cell));
      S.fm(r, TOT, sumRow(r), v(row.total), z, ST.label);
      row.xr = r; r++;
    }
    const T = r;
    S.s(T, 0, t('au_total'), ST.total);
    for (let i = 0; i < NB; i++) S.fm(T, B0 + i, m.base.length ? `SUM(${A1(first, B0 + i)}:${A1(T - 1, B0 + i)})` : '0', v(m.baseTotals[i]), z, ST.total);
    S.fm(T, TOT, sumRow(T), v(m.baseTotals.reduce((a, b) => a + b, 0)), z, ST.total);

    // 2. History of year-end aging, average and share per band.
    r = T + 2;
    S.s(r, 0, t('ecl_x_s2'), ST.section); r++;
    head(r, t('ecl_year')); S.s(r, TOT + 1, t('ecl_source'), ST.head); r++;
    const h0 = r;
    for (const h of m.hist) {
      S.s(r, 0, h.year, ST.label);
      h.v.forEach((x, i) => (h.src === 'current' ? S.fm(r, B0 + i, A1(T, B0 + i), v(x), z, ST.cell) : S.nv(r, B0 + i, v(x), z, ST.cell)));
      S.fm(r, TOT, sumRow(r), v(h.v.reduce((a, b) => a + b, 0)), z, ST.label);
      S.s(r, TOT + 1, srcLabel(h), ST.item);
      r++;
    }
    const AVG = r, SH = r + 1;
    S.s(AVG, 0, t('ecl_avg'), ST.key);
    for (let i = 0; i < NB; i++) S.fm(AVG, B0 + i, `AVERAGE(${A1(h0, B0 + i)}:${A1(AVG - 1, B0 + i)})`, v(m.avg[i]), z, ST.key);
    S.fm(AVG, TOT, sumRow(AVG), v(m.avg.reduce((a, b) => a + b, 0)), z, ST.key);
    S.s(SH, 0, t('ecl_share'), ST.key);
    for (let i = 0; i < NB; i++) S.fm(SH, B0 + i, `IF(${A1(AVG, TOT, true)}=0,0,${A1(AVG, B0 + i)}/${A1(AVG, TOT, true)})`, m.share[i], P, ST.key);
    S.fm(SH, TOT, sumRow(SH), m.share.reduce((a, b) => a + b, 0), P, ST.key);

    // 3. Forward-looking assumptions.
    r = SH + 2;
    S.s(r, 0, t('ecl_x_forward'), ST.section); r++;
    const RI = r;
    [['ecl_inf', m.rates.inf], ['ecl_ind', m.rates.ind], ['ecl_unemp', m.rates.unemp]].forEach(([k, x], j) => {
      S.s(RI + j, 0, t(k), ST.cell); S.nv(RI + j, B0, x / 100, P, ST.cell);
    });

    // 4. Provision matrix (Kuwait method).
    r = RI + 4;
    S.s(r, 0, t('ecl_x_s4'), ST.section); r++;
    const MX = r, HD = r + 1, MO = r + 2, PC = r + 3, GR = r + 4, EC = r + 5, RC = r + 7, RQ = r + 8;
    S.s(MX, 0, t('ecl_x_max'), ST.key);
    S.fm(MX, B0, `${A1(SH, B0 + NB - 1)}+${A1(RI, B0)}+${A1(RI + 1, B0)}+${A1(RI + 2, B0)}`, m.maxRate, P, ST.key);
    head(HD, '');
    S.s(MO, 0, t('ecl_months'), ST.cell); WEIGHTS.forEach((w, i) => S.nv(MO, B0 + i, w, null, ST.cell)); S.fm(MO, TOT, sumRow(MO), WEIGHTS.reduce((a, b) => a + b, 0), null, ST.label);
    S.s(PC, 0, t('ecl_pct'), ST.label);
    for (let i = 0; i < NB - 1; i++) S.fm(PC, B0 + i, `${A1(MO, B0 + i)}/${A1(MO, TOT, true)}*${A1(MX, B0, true)}`, m.pct[i], P, ST.label);
    S.nv(PC, B0 + NB - 1, 1, P, ST.label); S.paint(PC, TOT, TOT, ST.label);
    S.s(GR, 0, t('ecl_gross'), ST.cell);
    for (let i = 0; i < NB; i++) S.fm(GR, B0 + i, A1(T, B0 + i), v(m.baseTotals[i]), z, ST.cell);
    S.fm(GR, TOT, sumRow(GR), v(m.baseTotals.reduce((a, b) => a + b, 0)), z, ST.label);
    S.s(EC, 0, t('ecl_required'), ST.total);
    for (let i = 0; i < NB; i++) S.fm(EC, B0 + i, `${A1(GR, B0 + i)}*${A1(PC, B0 + i)}`, v(m.ecl[i]), z, ST.total);
    S.fm(EC, TOT, sumRow(EC), v(m.eclTotal), z, ST.total);
    S.s(RC, 0, recLabel(m), ST.cell); S.paint(RC, B0, TOT - 1, ST.cell); S.nv(RC, TOT, v(m.recorded), z, ST.label);
    if (m.prev) S.s(RC, TOT + 1, `${m.prevFile}${m.prev.sheet ? ' · ' + m.prev.sheet : ''}`, ST.note);
    else if (m.allow) S.s(RC, TOT + 1, `${m.allow.code} ${m.allow.name} (${m.allow.file})`, ST.note);
    S.s(RQ, 0, reqLabel(m), ST.result); S.paint(RQ, B0, TOT - 1, ST.result);
    S.fm(RQ, TOT, `${A1(EC, TOT)}-${A1(RC, TOT)}`, v(m.required), z, ST.result);

    // 5. ECL per customer.
    r = RQ + 2;
    S.s(r, 0, t('ecl_x_s5'), ST.section); r++;
    head(r, t('ecl_x_partner')); r++;
    const p0 = r;
    for (const row of m.base) {
      S.s(r, 0, rowLabel(m, row), ST.cell);
      for (let i = 0; i < NB; i++) S.fm(r, B0 + i, `${A1(row.xr, B0 + i)}*${A1(PC, B0 + i, true)}`, v(row.bands[i] * m.pct[i]), z, ST.cell);
      S.fm(r, TOT, sumRow(r), v(row.bands.reduce((a, x, i) => a + x * m.pct[i], 0)), z, ST.label);
      r++;
    }
    const PT = r;
    S.s(PT, 0, t('au_total'), ST.total);
    for (let i = 0; i <= NB; i++) S.fm(PT, B0 + i, m.base.length ? `SUM(${A1(p0, B0 + i)}:${A1(PT - 1, B0 + i)})` : '0', v(i < NB ? m.ecl[i] : m.eclTotal), z, ST.total);
    S.s(PT + 1, 0, t('ecl_check'), ST.ok);
    for (let i = 0; i <= NB; i++) S.fm(PT + 1, B0 + i, `ROUND(${A1(PT, B0 + i)}-${A1(EC, B0 + i)},${m.dec})=0`, true, null, ST.ok);
    S.s(PT + 3, 0, t('ecl_x_note_ecl'), ST.note); S.merge(PT + 3, 0, LAST);
    return S.done([54, 15, 15, 15, 15, 15, 15, 16, 48]);
  }

  async function exportXlsx() {
    const m = model();
    const btn = document.getElementById('eclXlsx'); if (btn) btn.disabled = true;
    X = await styledLib();
    try {
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, agedSheet(m), t('ecl_tab_aged').slice(0, 31));
      X.utils.book_append_sheet(wb, eclSheet(m), t('ecl_tab_ecl').slice(0, 31));
      const name = `Aged-AR-ECL-${U.safeName(App.company().name)}-${m.year}.xlsx`;
      const res = await U.download(name, new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' })));
      if (String(res).startsWith('unavailable')) {
        const aoa = [[t('h_partner'), ...Array.from({ length: NB }, (_, i) => bandLabel(i)), t('au_total')],
          ...m.base.map(r => [rowLabel(m, r), ...r.bands.map(x => x / m.UNIT), r.total / m.UNIT])];
        U.copyDialog({ message: t('save_failed_msg'), text: U.toTSV(aoa), reason: String(res).split(':')[1] });
      }
    } finally { if (btn) btn.disabled = false; }
  }

  /* ---------- Events ---------- */
  function mount(root) {
    const q = sel => root.querySelector(sel);
    const file = q('#eclFile'), drop = q('#eclDrop');
    if (drop) U.dropZone(drop, file, onFiles);
    else file.addEventListener('change', () => { if (file.files.length) onFiles(file.files); file.value = ''; });
    const add = q('#eclAdd'); if (add) add.addEventListener('click', () => file.click());
    const reset = q('#eclReset'); if (reset) reset.addEventListener('click', () => { Object.assign(st, { files: [], error: '', model: null }); App.rerender(); });
    root.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { st.files = st.files.filter(f => f.id !== b.dataset.rm); st.model = null; App.rerender(); }));
    root.querySelectorAll('[data-prevsheet]').forEach(sel => sel.addEventListener('change', () => {
      const f = st.files.find(x => x.id === sel.dataset.prevsheet);
      if (f) { f.sel = +sel.value; adoptPrev(f); App.rerender(); }
    }));

    const change = (el, fn) => el && el.addEventListener('change', () => { const c = cfg(); fn(c, el); saveCfg(c); App.rerender(); });
    change(q('#eclYear'), (c, el) => { c.year = el.value; });
    change(q('#eclOpenOld'), (c, el) => { c.openOld = el.checked; });
    change(q('#eclStart'), (c, el) => { c.start = +el.value || 2022; });
    root.querySelectorAll('[data-rate]').forEach(el => change(el, (c, e) => { c.rates = Object.assign({}, c.rates, { [e.dataset.rate]: +e.value || 0 }); }));
    root.querySelectorAll('[data-acc]').forEach(el => change(el, (c, e) => {
      const set = new Set(c.exclude); if (e.checked) set.delete(e.dataset.acc); else set.add(e.dataset.acc); c.exclude = [...set];
    }));
    change(q('#eclAllow'), (c, el) => { c.allow = el.value; });
    change(q('#eclManual'), (c, el) => { c.manualProv = el.value; });
    root.querySelectorAll('[data-src]').forEach(el => change(el, (c, e) => {
      const y = e.dataset.src; c.hist = Object.assign({}, c.hist, { [y]: Object.assign({}, c.hist[y], { src: e.value }) });
    }));
    root.querySelectorAll('[data-hist]').forEach(el => change(el, (c, e) => {
      const y = e.dataset.hist, h = Object.assign({ src: 'manual', v: [] }, c.hist[y]);
      const vals = (h.v || []).concat(new Array(NB).fill(0)).slice(0, NB);
      vals[+e.dataset.i] = U.parseNum(e.value) ? U.parseNum(e.value).v : 0;
      c.hist = Object.assign({}, c.hist, { [y]: { src: 'manual', v: vals } });
    }));
    root.querySelectorAll('[data-etab]').forEach(b => b.addEventListener('click', () => { st.tab = b.dataset.etab; App.rerender(); }));
    const xl = q('#eclXlsx'); if (xl) xl.addEventListener('click', exportXlsx);
  }

  return { render, mount, _onFiles: onFiles, _state: st, _model: () => model(), xl: { lib: styledLib, ST } };
})();
