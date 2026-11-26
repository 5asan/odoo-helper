/* End-of-Service Indemnity provision (Kuwait Private Sector Labour Law 6/2010, Art. 51 & 53):
   - Monthly pay = basic + allowances; day rate = monthly ÷ 26 (or ÷ 30).
   - First 5 years: 15 days' pay per year; after 5 years: one month's pay per year; part years pro rata.
   - Cap: 1.5 years' pay (18 months).
   - Basis "termination" = full amount (usual for the provision); "resignation" (Art. 53): none under 3 years,
     ½ for 3–5 years, ⅔ for 5–10 years, full from 10 years.
   - Output: a calculation sheet with live formulas + an Odoo journal entries import file
     (reverse last provision, post the new one). */
const Indemnity = (() => {
  const DAY = 864e5;
  const st = { coId: null, emps: [], prevInfo: null, files: [], error: '', busy: '', form: {}, editId: null };

  /* ---------- Settings (per company) ---------- */
  const SKEY = 'oh_eosi_settings';
  const lastMonthEnd = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0)).toISOString().slice(0, 10); };
  const loadAll = () => { try { return JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch (e) { return {}; } };
  const cfg = () => Object.assign({ date: '', revDate: '', days: 26, basis: 'term', dec: 3, provAcc: '', expAcc: '', journal: 'MISC', perEmp: true },
    loadAll()[App.companyId] || {});
  function saveCfg(c) {
    const all = loadAll(); all[App.companyId] = c;
    try { localStorage.setItem(SKEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
  }
  const asOf = c => c.date || lastMonthEnd();

  const fd = iso => U.fmtDate(iso, 'DD/MM/YYYY');
  const dnum = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; };
  const r = (v, dec) => { const p = Math.pow(10, dec); return Math.round((v + Math.sign(v) * 1e-9) * p) / p; };
  const money = (v, dec) => (v ? v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : '-');
  const num = x => { if (typeof x === 'number') return x; const p = U.parseNum(x); return p ? p.v : 0; };

  /* ---------- Calculation ---------- */
  const factorOf = (basis, years) => (basis !== 'resign' ? 1 : years < 3 ? 0 : years < 5 ? 0.5 : years < 10 ? 2 / 3 : 1);
  function calc(e, c) {
    const date = asOf(c), dec = +c.dec || 0, days = +c.days || 26;
    const out = { ok: false };
    if (!e.name || !e.join) return Object.assign(out, { err: 'eo_err_missing' });
    if (e.join > date) return Object.assign(out, { err: 'eo_err_future' });
    const monthly = num(e.basic) + num(e.allow);
    if (!(monthly > 0)) return Object.assign(out, { err: 'eo_err_pay' });
    // Net working days = date − joining date − unpaid leave days; years = days ÷ 365 (the company accountant's method:
    // salary/26×15×5 + salary×(days − 1825)/365).
    const service = Math.max(0, dnum(date) - dnum(e.join) - num(e.unpaid));
    const years = service / 365;
    const first = Math.min(years, 5) * 15 * monthly / days;
    const after = Math.max(years - 5, 0) * monthly;
    const cap = 18 * monthly;
    const capped = first + after > cap;
    const factor = factorOf(c.basis, years);
    const gross = r(Math.min(first + after, cap) * factor, dec);
    const paid = r(num(e.paid), dec);
    const ind = r(Math.max(gross - paid, 0), dec);
    const prev = r(num(e.prev), dec);
    return { ok: true, monthly, service, years, first, after, cap, capped, factor, gross, paid, ind, prev, move: r(ind - prev, dec) };
  }
  function model() {
    const c = cfg();
    const rows = st.emps.map(e => ({ e, x: calc(e, c) }));
    const good = rows.filter(x => x.x.ok);
    const sum = k => r(good.reduce((s, x) => s + x.x[k], 0), +c.dec || 0);
    return { c, date: asOf(c), rows, good, bad: rows.filter(x => !x.x.ok), gross: sum('gross'), paid: sum('paid'), total: sum('ind'), prev: sum('prev'), move: sum('move') };
  }

  /* ---------- Reading the employee file ---------- */
  const COLS = {
    code: /employee code|emp\.? ?(code|no|id)|^code\b|^id\b|staff (no|id)|رقم الموظف|الرقم الوظيفي|كود الموظف/i,
    name: /employee name|^name\b|full name|اسم الموظف|^الاسم/i,
    join: /join|hir(e|ing)|start date|date of employment|تاريخ التعيين|تاريخ الالتحاق|تاريخ المباشرة|تاريخ بدء/i,
    basic: /basic|الراتب الأساسي|الأساسي/i,
    allow: /allowance|بدل|علاوات/i,
    unpaid: /unpaid|without pay|بدون راتب|غير مدفوعة/i,
    paid: /advance|paid in advance|already paid|^paid|^received|المدفوع مقدم|مدفوعة مقدم|المصروف مقدم|سلف|المستلم/i,
    prev: /last provision|previous provision|opening provision|المخصص السابق|مخصص سابق/i,
    ind: /^(indemnity|eosi|end of service indemnity)\b(?!.*(part|year))|^(المكافأة|مكافأة نهاية الخدمة)$/i,
    asof: /^as at|^كما في/i,
  };
  function readEmployees(sheets) {
    for (const sh of sheets) {
      const rows = sh.rows;
      for (let i = 0; i < Math.min(rows.length, 30); i++) {
        const h = rows[i].map(x => x.replace(/\*/g, '').replace(/\s+/g, ' ').trim());
        const at = k => h.findIndex(x => x && COLS[k].test(x));
        const ix = { code: at('code'), name: at('name'), join: at('join'), basic: at('basic'), allow: at('allow'), unpaid: at('unpaid'), paid: at('paid'), prev: at('prev'), ind: at('ind') };
        if (ix.name < 0 || ix.join < 0 || ix.basic < 0) continue;
        // "As at dd/mm/yyyy" in the title rows of our own export.
        let prevDate = '';
        for (let j = 0; j < i; j++) for (const cell of rows[j]) {
          const mm = String(cell).match(/(\d{1,2}\/\d{1,2}\/\d{4})/); if (mm && COLS.asof.test(String(cell).trim())) prevDate = U.parseDate(mm[1]) || '';
        }
        const val = (row, k) => (ix[k] < 0 ? '' : row.v && row.v[ix[k]] !== undefined && row.v[ix[k]] !== '' ? row.v[ix[k]] : row[ix[k]]);
        const emps = [];
        for (const row of rows.slice(i + 1)) {
          const name = String(row[ix.name] || '').trim();
          if (/^(total|الإجمالي|المجموع)/i.test(String(row[0] || '').trim())) break;
          if (!name || /^(total|الإجمالي|المجموع)/i.test(name)) continue;
          if (!row[ix.join] && !row[ix.basic]) continue;
          const jv = val(row, 'join');
          const join = jv instanceof Date ? U.parseDate(jv) : typeof jv === 'number' && jv > 1000 && jv < 80000 ? new Date(Math.round((jv - 25569) * DAY)).toISOString().slice(0, 10) : U.parseDate(row[ix.join]);
          emps.push({ id: U.uid(), code: String(row[ix.code] || '').trim(), name, join: join || '',
            basic: num(val(row, 'basic')), allow: num(val(row, 'allow')), unpaid: num(val(row, 'unpaid')), paid: num(val(row, 'paid')),
            prev: ix.ind >= 0 ? num(val(row, 'ind')) : num(val(row, 'prev')) });
        }
        return { emps, isPrev: ix.ind >= 0, prevDate };
      }
    }
    return null;
  }
  async function onFiles(list) {
    st.error = '';
    for (const file of Array.from(list)) {
      st.busy = file.name; App.rerender();
      try {
        const got = readEmployees(await Audit.io.readBook(file));
        if (!got || !got.emps.length) { st.error = t(got ? 'eo_empty_file' : 'eo_bad_file', { f: file.name }); continue; }
        if (got.isPrev && st.emps.length) {
          // Last calculation: its indemnity becomes "last provision" for the employees already listed.
          const key = e => (e.code ? 'c:' + e.code : 'n:' + U.norm(e.name));
          const map = new Map(got.emps.map(e => [key(e), e.prev]));
          let n = 0;
          st.emps.forEach(e => { if (map.has(key(e))) { e.prev = map.get(key(e)); n++; } });
          st.prevInfo = { file: file.name, date: got.prevDate, n, of: got.emps.length };
        } else {
          st.emps = got.emps;
          st.prevInfo = got.isPrev ? { file: file.name, date: got.prevDate, n: got.emps.length, of: got.emps.length } : null;
        }
        st.files.push(file.name);
      } catch (e) { st.error = t('eo_bad_file', { f: file.name }) + ' ' + (e.message || ''); }
    }
    st.busy = ''; App.rerender();
  }

  /* ---------- Rendering ---------- */
  function render() {
    if (st.coId !== App.companyId) Object.assign(st, { coId: App.companyId, emps: [], files: [], prevInfo: null, error: '', form: {}, editId: null });
    const m = model(), c = m.c;
    return `
      <div class="card">
        <h2 style="margin-top:0">${t('eo_title')}</h2>
        <p class="muted small" style="margin-top:0">${t('eo_law')}</p>
        <div class="drop" id="eoDrop" tabindex="0" role="button">
          <b>${t(st.emps.length ? 'eo_drop_more' : 'eo_drop')}</b><span class="muted">${t('eo_drop_sub')}</span>
        </div>
        <input type="file" id="eoFile" accept=".xlsx,.xls,.csv" multiple hidden>
        <div class="row" style="margin-top:10px">
          <button class="btn ghost" id="eoTemplate" type="button">${t('eo_template')}</button>
          ${st.emps.length ? `<button class="btn ghost" id="eoClear" type="button">${t('eo_clear')}</button>` : ''}
          ${st.files.length ? `<span class="muted small">${U.esc(st.files.join(', '))}</span>` : ''}
        </div>
        ${st.prevInfo ? `<div class="notice info" style="margin-top:10px">${t('eo_prev_info', { f: st.prevInfo.file, d: st.prevInfo.date ? fd(st.prevInfo.date) : '—', n: st.prevInfo.n, m: st.prevInfo.of })}</div>` : ''}
      </div>
      ${st.busy ? `<div class="card"><span class="spinner"></span> ${U.esc(t('reading', { f: st.busy }))}</div>` : ''}
      ${st.error ? `<div class="notice bad">${U.esc(st.error)}</div>` : ''}
      ${renderSettings(c)}
      ${renderForm(c)}
      ${st.emps.length ? renderResult(m) : ''}`;
  }

  function renderSettings(c) {
    return `
      <div class="card">
        <h2 style="margin-top:0">${t('eo_setup')}</h2>
        <div class="row" style="align-items:flex-end;flex-wrap:wrap">
          <label class="field">${t('eo_asof')}<input id="eoDate" type="date" value="${U.esc(asOf(c))}"></label>
          <label class="field">${t('eo_days')}
            <select id="eoDays"><option value="26" ${+c.days === 26 ? 'selected' : ''}>${t('eo_days26')}</option>
              <option value="30" ${+c.days === 30 ? 'selected' : ''}>${t('eo_days30')}</option></select></label>
          <label class="field">${t('eo_basis')}
            <select id="eoBasis"><option value="term" ${c.basis !== 'resign' ? 'selected' : ''}>${t('eo_basis_term')}</option>
              <option value="resign" ${c.basis === 'resign' ? 'selected' : ''}>${t('eo_basis_resign')}</option></select></label>
          <label class="field">${t('eo_dec')}<input id="eoDec" type="number" min="0" max="3" value="${U.esc(c.dec)}" style="width:70px"></label>
        </div>
        <h3 style="margin:14px 0 6px">${t('eo_entries')}</h3>
        <div class="row" style="align-items:flex-end;flex-wrap:wrap">
          <label class="field">${t('eo_prov_acc')}<input id="eoProvAcc" value="${U.esc(c.provAcc)}" placeholder="${U.esc(t('eo_acc_ph'))}" style="width:260px"></label>
          <label class="field">${t('eo_exp_acc')}<input id="eoExpAcc" value="${U.esc(c.expAcc)}" placeholder="${U.esc(t('eo_acc_ph'))}" style="width:260px"></label>
          <label class="field">${t('eo_journal')}<input id="eoJournal" value="${U.esc(c.journal)}" style="width:110px"></label>
          <label class="field">${t('eo_rev_date')}<input id="eoRevDate" type="date" value="${U.esc(c.revDate || asOf(c))}"></label>
        </div>
        <label class="row" style="gap:8px;margin-top:10px"><input type="checkbox" id="eoPerEmp" ${c.perEmp !== false ? 'checked' : ''}> ${t('eo_per_emp')}</label>
      </div>`;
  }

  const F = [['code', 'text'], ['name', 'text'], ['join', 'date'], ['basic', 'number'], ['allow', 'number'], ['unpaid', 'number'], ['paid', 'number'], ['prev', 'number']];
  function renderForm(c) {
    const f = st.form;
    return `
      <div class="card">
        <h2 style="margin-top:0">${t(st.editId ? 'eo_one_edit' : 'eo_one')}</h2>
        <p class="muted small" style="margin-top:0">${t('eo_one_hint', { d: fd(asOf(c)) })}</p>
        <div class="row" style="align-items:flex-end;flex-wrap:wrap">
          ${F.map(([k, type]) => `<label class="field">${t('eo_f_' + k)}${['name', 'join', 'basic'].includes(k) ? ' *' : ''}
            <input data-ef="${k}" type="${type}" ${type === 'number' ? 'step="any" min="0"' : ''} value="${U.esc(f[k] == null ? '' : f[k])}" style="width:${k === 'name' ? 220 : k === 'join' ? 150 : 120}px"></label>`).join('')}
        </div>
        <div id="eoOneOut" style="margin-top:10px">${oneOut(c)}</div>
        <div class="row" style="margin-top:10px">
          <button class="btn" id="eoAdd" type="button">${t(st.editId ? 'eo_save' : 'eo_add')}</button>
          ${st.editId || Object.keys(f).length ? `<button class="btn ghost" id="eoFormClear" type="button">${t('eo_form_clear')}</button>` : ''}
        </div>
      </div>`;
  }
  function oneOut(c) {
    const f = st.form;
    if (!f.name && !f.join && !f.basic) return '';
    const x = calc(f, c), dec = +c.dec || 0;
    if (!x.ok) return `<div class="notice warn">${t(x.err)}</div>`;
    return `<div class="stats" style="margin:0">
      <div class="stat"><b>${x.years.toFixed(3)}</b><span>${t('eo_years', { d: x.service.toLocaleString('en-US') })}</span></div>
      <div class="stat"><b>${money(x.first, dec)}</b><span>${t('eo_first5')}</span></div>
      <div class="stat"><b>${money(x.after, dec)}</b><span>${t('eo_after5')}</span></div>
      ${x.capped ? `<div class="stat"><b>${money(x.cap, dec)}</b><span>${t('eo_capped')}</span></div>` : ''}
      ${x.factor !== 1 ? `<div class="stat"><b>${Math.round(x.factor * 1000) / 10}%</b><span>${t('eo_factor')}</span></div>` : ''}
      ${x.paid ? `<div class="stat"><b>${money(x.gross, dec)}</b><span>${t('eo_gross')}</span></div><div class="stat"><b>(${money(x.paid, dec)})</b><span>${t('eo_f_paid')}</span></div>` : ''}
      <div class="stat"><b>${money(x.ind, dec)}</b><span>${t('eo_ind_at', { d: fd(asOf(c)) })}</span></div>
      ${x.prev ? `<div class="stat"><b>${money(x.move, dec)}</b><span>${t('eo_move')}</span></div>` : ''}
    </div>`;
  }

  function renderResult(m) {
    const dec = +m.c.dec || 0;
    return `
      <div class="card">
        <div class="stats">
          <div class="stat"><b>${m.good.length}</b><span>${t('eo_s_emps')}</span></div>
          <div class="stat"><b>${money(m.total, dec)}</b><span>${t('eo_ind_at', { d: fd(m.date) })}</span></div>
          <div class="stat"><b>${money(m.prev, dec)}</b><span>${t('eo_s_prev')}</span></div>
          <div class="stat"><b>${money(m.move, dec)}</b><span>${t(m.move >= 0 ? 'eo_charge' : 'eo_release')}</span></div>
        </div>
        ${m.bad.length ? `<div class="notice warn">${t('eo_bad_rows', { n: m.bad.length })} ${m.bad.map(x => U.esc(x.e.name || '?') + ' (' + t(x.x.err) + ')').join(' · ')}</div>` : ''}
        ${!m.c.provAcc || !m.c.expAcc ? `<div class="notice info">${t('eo_need_acc')}</div>` : ''}
        <div class="row" style="margin:10px 0">
          <button class="btn" id="eoXlsx" type="button">${t('eo_download')}</button>
          <button class="btn ghost" id="eoOdoo" type="button" ${!m.c.provAcc || !m.c.expAcc ? 'disabled' : ''}>${t('eo_download_je')}</button>
        </div>
        <div class="table-wrap ecl-wide"><table class="au-table">
          <thead><tr><th>${t('eo_f_code')}</th><th>${t('eo_f_name')}</th><th>${t('eo_f_join')}</th><th class="num">${t('eo_monthly')}</th>
            <th class="num">${t('eo_h_years')}</th><th class="num">${t('eo_first5')}</th><th class="num">${t('eo_after5')}</th>
            <th class="num">${t('eo_gross')}</th><th class="num">${t('eo_f_paid')}</th>
            <th class="num">${t('eo_h_ind')}</th><th class="num">${t('eo_f_prev')}</th><th class="num">${t('eo_move')}</th><th></th></tr></thead>
          <tbody>${m.rows.map(({ e, x }) => `
            <tr class="${x.ok ? '' : 'ecl-credit'}">
              <td>${U.esc(e.code)}</td><td>${U.esc(e.name)}</td><td>${fd(e.join)}</td>
              ${x.ok ? `<td class="num">${money(x.monthly, dec)}</td><td class="num">${x.years.toFixed(3)}</td>
                <td class="num">${money(x.first, dec)}</td><td class="num">${money(x.after, dec)}${x.capped ? ' ⚑' : ''}</td>
                <td class="num">${money(x.gross, dec)}</td><td class="num">${money(x.paid, dec)}</td>
                <td class="num"><b>${money(x.ind, dec)}</b></td><td class="num">${money(x.prev, dec)}</td><td class="num">${money(x.move, dec)}</td>`
                : `<td colspan="9" class="muted">${t(x.err)}</td>`}
              <td style="white-space:nowrap"><button class="btn ghost sm" data-edit="${e.id}" type="button">${t('eo_edit')}</button>
                <button class="btn ghost sm" data-del="${e.id}" type="button">×</button></td>
            </tr>`).join('')}
            <tr class="au-total"><td colspan="7">${t('au_total')}</td><td class="num">${money(m.gross, dec)}</td><td class="num">${money(m.paid, dec)}</td><td class="num">${money(m.total, dec)}</td><td class="num">${money(m.prev, dec)}</td><td class="num">${money(m.move, dec)}</td><td></td></tr>
          </tbody></table></div>
        ${m.good.some(x => x.x.capped) ? `<p class="muted small">⚑ ${t('eo_capped_note')}</p>` : ''}
      </div>`;
  }

  /* ---------- Odoo journal entries (reverse last provision, post the new one) ---------- */
  function jeLines(m) {
    const c = m.c, dec = +c.dec || 0, d = fd(m.date);
    const head = ['Date', 'Journal', 'Reference', 'Journal Items/Account', 'Journal Items/Partner', 'Journal Items/Label', 'Journal Items/Debit', 'Journal Items/Credit'];
    const out = [head];
    const entry = (date, ref, lines) => lines.forEach((l, i) => out.push([i ? '' : date, i ? '' : c.journal, i ? '' : ref, l[0], l[1], l[2], l[3] ? r(l[3], dec) : 0, l[4] ? r(l[4], dec) : 0]));
    const prevD = st.prevInfo && st.prevInfo.date ? fd(st.prevInfo.date) : '';
    const emp = (k, debit) => (c.perEmp !== false
      ? m.good.filter(x => x.x[k]).map(x => [c.provAcc, x.e.name, t('eo_je_line', { n: x.e.name }), debit ? x.x[k] : 0, debit ? 0 : x.x[k]])
      : [[c.provAcc, '', t('eo_je_prov'), debit ? m[k === 'ind' ? 'total' : 'prev'] : 0, debit ? 0 : m[k === 'ind' ? 'total' : 'prev']]]);
    if (m.prev) {
      const ref = prevD ? t('eo_je_rev_ref_d', { d: prevD }) : t('eo_je_rev_ref');
      entry(c.revDate || m.date, ref, [...emp('prev', true), [c.expAcc, '', ref, 0, m.prev]]);
    }
    if (m.total) {
      const ref = t('eo_je_ref', { d });
      entry(m.date, ref, [[c.expAcc, '', ref, m.total, 0], ...emp('ind', false)]);
    }
    return out;
  }
  async function exportOdoo() {
    const m = model();
    const aoa = jeLines(m);
    const res = await U.downloadXLSX(`EOSI-entries-${U.safeName(App.company().name)}-${m.date}.xlsx`, aoa, 'Journal Entries', [12, 10, 40, 30, 30, 40, 14, 14]);
    if (String(res).startsWith('unavailable')) U.copyDialog({ message: t('save_failed_msg'), text: U.toTSV(aoa), reason: String(res).split(':')[1] });
  }

  /* ---------- Template ---------- */
  async function exportTemplate() {
    const head = ['Employee Code', 'Employee Name *', 'Joining Date *', 'Basic Salary *', 'Allowances', 'Unpaid Leave Days', 'Advance Paid', 'Last Provision'];
    const help = [[t('eo_tpl_title')], [], ...['eo_tpl_1', 'eo_tpl_2', 'eo_tpl_3', 'eo_tpl_4', 'eo_tpl_8', 'eo_tpl_5', 'eo_tpl_6', 'eo_tpl_7'].map(k => [t(k)])];
    const X = window.XLSX;
    const wb = X.utils.book_new();
    const ws = X.utils.aoa_to_sheet([head]);
    ws['!cols'] = [14, 32, 16, 14, 14, 16, 16, 16].map(w => ({ wch: w }));
    X.utils.book_append_sheet(wb, ws, 'Employees');
    const hs = X.utils.aoa_to_sheet(help); hs['!cols'] = [{ wch: 110 }];
    X.utils.book_append_sheet(wb, hs, 'Instructions');
    await U.download('EOSI-employees-template.xlsx', new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' })));
  }

  /* ---------- Excel calculation sheet (live formulas) ---------- */
  async function exportXlsx() {
    const m = model(), c = m.c, dec = +c.dec || 0;
    const btn = document.getElementById('eoXlsx'); if (btn) btn.disabled = true;
    try {
      const X = await AgedECL.xl.lib(), ST = AgedECL.xl.ST;
      const ws = {}; let maxR = 0; const merges = [];
      const put = (rr, cc, cell) => { ws[X.utils.encode_cell({ r: rr, c: cc })] = cell; maxR = Math.max(maxR, rr); };
      const fz = (st, z) => (z ? Object.assign({}, st || {}, { numFmt: z }) : st);
      const s = (rr, cc, v, st) => put(rr, cc, { t: 's', v: String(v == null ? '' : v), s: st });
      const n = (rr, cc, v, z, st) => put(rr, cc, { t: 'n', v, z, s: fz(st, z) });
      const f = (rr, cc, fx, v, z, st) => put(rr, cc, { t: 'n', v, f: fx, z, s: fz(st, z) });
      const A = (rr, cc, abs) => (abs ? `$${X.utils.encode_col(cc)}$${rr + 1}` : `${X.utils.encode_col(cc)}${rr + 1}`);
      const zA = dec ? `#,##0.${'0'.repeat(dec)};(#,##0.${'0'.repeat(dec)});"-"` : '#,##0;(#,##0);"-"';
      const zD = 'dd/mm/yyyy', zY = '0.000';
      const xd = iso => dnum(iso) + 25569;     // Excel serial date
      const LAST = 18;
      s(0, 0, t('eo_x_title'), ST.title); merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: LAST } });
      s(1, 0, App.company().name, ST.company); merges.push({ s: { r: 1, c: 0 }, e: { r: 1, c: LAST } });
      s(2, 0, t('eo_x_asof', { d: fd(m.date) }), ST.sub); merges.push({ s: { r: 2, c: 0 }, e: { r: 2, c: LAST } });
      // Parameters (formulas refer to these cells).
      s(4, 0, t('eo_asof'), ST.label); n(4, 3, xd(m.date), zD, ST.key);
      s(5, 0, t('eo_x_days'), ST.label); n(5, 3, +c.days || 26, '0', ST.key);
      s(6, 0, t('eo_x_cap'), ST.label); n(6, 3, 18, '0', ST.key);
      s(7, 0, t('eo_basis'), ST.label); s(7, 3, t(c.basis === 'resign' ? 'eo_basis_resign' : 'eo_basis_term'), ST.key); merges.push({ s: { r: 7, c: 3 }, e: { r: 7, c: 5 } });
      [4, 5, 6, 7].forEach(rr => merges.push({ s: { r: rr, c: 0 }, e: { r: rr, c: 2 } }));
      const D = A(4, 3, true), DAYS = A(5, 3, true), CAP = A(6, 3, true);
      const H = 9;
      const heads = ['#', t('eo_f_code'), t('eo_f_name'), t('eo_f_join'), t('eo_f_basic'), t('eo_f_allow'), t('eo_monthly'), t('eo_f_unpaid'),
        t('eo_h_days'), t('eo_h_years'), t('eo_first5'), t('eo_after5'), t('eo_h_cap'), t('eo_factor'), t('eo_gross'), t('eo_f_paid'), t('eo_h_ind'), t('eo_f_prev'), t('eo_move')];
      heads.forEach((h, i) => s(H, i, h, i === 2 ? ST.headL : ST.head));
      const rows = [];
      m.good.forEach(({ e, x }, i) => {
        const rr = H + 1 + i; rows.push(rr);
        n(rr, 0, i + 1, '0', ST.cell); s(rr, 1, e.code, ST.cell); s(rr, 2, e.name, ST.label);
        n(rr, 3, xd(e.join), zD, ST.cell); n(rr, 4, num(e.basic), zA, ST.cell); n(rr, 5, num(e.allow), zA, ST.cell);
        f(rr, 6, `${A(rr, 4)}+${A(rr, 5)}`, x.monthly, zA, ST.cell);
        n(rr, 7, num(e.unpaid), '0', ST.cell);
        f(rr, 8, `MAX(0,${D}-${A(rr, 3)}-${A(rr, 7)})`, x.service, '#,##0', ST.cell);
        f(rr, 9, `${A(rr, 8)}/365`, x.years, zY, ST.cell);
        f(rr, 10, `MIN(${A(rr, 9)},5)*15*${A(rr, 6)}/${DAYS}`, x.first, zA, ST.cell);
        f(rr, 11, `MAX(${A(rr, 9)}-5,0)*${A(rr, 6)}`, x.after, zA, ST.cell);
        f(rr, 12, `${CAP}*${A(rr, 6)}`, x.cap, zA, ST.cell);
        const yr = A(rr, 9);
        if (c.basis === 'resign') f(rr, 13, `IF(${yr}<3,0,IF(${yr}<5,1/2,IF(${yr}<10,2/3,1)))`, x.factor, '0.0%', ST.cell);
        else n(rr, 13, 1, '0%', ST.cell);
        f(rr, 14, `ROUND(MIN(${A(rr, 10)}+${A(rr, 11)},${A(rr, 12)})*${A(rr, 13)},${dec})`, x.gross, zA, ST.cell);
        n(rr, 15, x.paid, zA, ST.cell);
        f(rr, 16, `MAX(0,${A(rr, 14)}-${A(rr, 15)})`, x.ind, zA, ST.key);
        n(rr, 17, x.prev, zA, ST.cell);
        f(rr, 18, `${A(rr, 16)}-${A(rr, 17)}`, x.move, zA, ST.cell);
      });
      const T = H + 1 + m.good.length;
      s(T, 0, t('au_total'), ST.total); for (let cc = 1; cc <= LAST; cc++) s(T, cc, '', ST.total);
      merges.push({ s: { r: T, c: 0 }, e: { r: T, c: 2 } });
      const sumC = (cc, v) => f(T, cc, rows.length ? `SUM(${A(H + 1, cc)}:${A(T - 1, cc)})` : '0', v, zA, ST.total);
      sumC(14, m.gross); sumC(15, m.paid); sumC(16, m.total); sumC(17, m.prev); sumC(18, m.move);
      // Journal entries summary under the table.
      let rr = T + 3;
      s(rr, 0, t('eo_entries'), ST.section); rr++;
      ['eo_x_je_date', 'eo_x_je_ref', 'eo_x_je_acc', 'eo_x_je_partner', 'eo_x_je_dr', 'eo_x_je_cr'].forEach((k, i) => s(rr, [0, 2, 4, 8, 12, 14][i], t(k), ST.headL));
      [[0, 1], [2, 3], [4, 7], [8, 11], [12, 13], [14, 15]].forEach(([a, b]) => merges.push({ s: { r: rr, c: a }, e: { r: rr, c: b } }));
      for (const l of jeLines(m).slice(1)) {
        rr++;
        s(rr, 0, l[0] ? fd(l[0]) : '', ST.cell); s(rr, 2, l[2], ST.cell); s(rr, 4, l[3], ST.cell); s(rr, 8, l[4], ST.cell);
        n(rr, 12, l[6], zA, ST.cell); n(rr, 14, l[7], zA, ST.cell);
        [[0, 1], [2, 3], [4, 7], [8, 11], [12, 13], [14, 15]].forEach(([a, b]) => merges.push({ s: { r: rr, c: a }, e: { r: rr, c: b } }));
      }
      rr += 2;
      ['eo_x_note1', 'eo_x_note2', 'eo_x_note3'].forEach(k => { s(rr, 0, t(k), ST.note); merges.push({ s: { r: rr, c: 0 }, e: { r: rr, c: LAST } }); rr++; });
      ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: LAST } });
      ws['!cols'] = [5, 12, 30, 12, 12, 12, 13, 9, 10, 9, 14, 14, 14, 10, 15, 14, 15, 15, 14].map(w => ({ wch: w }));
      ws['!rows'] = Array.from({ length: maxR + 1 }, (_, i) => (i === H ? { hpt: 44 } : i === 0 ? { hpt: 24 } : {}));
      ws['!merges'] = merges;
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, ws, t('eo_x_sheet').slice(0, 31));
      const res = await U.download(`EOSI-${U.safeName(App.company().name)}-${m.date}.xlsx`, new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' })));
      if (String(res).startsWith('unavailable')) U.copyDialog({ message: t('save_failed_msg'), text: U.toTSV(jeLines(m)), reason: String(res).split(':')[1] });
    } finally { if (btn) btn.disabled = false; }
  }

  /* ---------- Events ---------- */
  function mount(root) {
    const q = sel => root.querySelector(sel);
    const file = q('#eoFile');
    U.dropZone(q('#eoDrop'), file, onFiles);
    q('#eoTemplate').addEventListener('click', exportTemplate);
    const clr = q('#eoClear'); if (clr) clr.addEventListener('click', () => { Object.assign(st, { emps: [], files: [], prevInfo: null }); App.rerender(); });

    const change = (el, fn) => el && el.addEventListener('change', () => { const c = cfg(); fn(c, el); saveCfg(c); App.rerender(); });
    change(q('#eoDate'), (c, el) => { c.date = el.value; });
    change(q('#eoDays'), (c, el) => { c.days = +el.value; });
    change(q('#eoBasis'), (c, el) => { c.basis = el.value; });
    change(q('#eoDec'), (c, el) => { c.dec = Math.max(0, Math.min(3, +el.value || 0)); });
    change(q('#eoJournal'), (c, el) => { c.journal = el.value.trim(); });
    change(q('#eoRevDate'), (c, el) => { c.revDate = el.value === asOf(c) ? '' : el.value; });
    change(q('#eoPerEmp'), (c, el) => { c.perEmp = el.checked; });
    const accItems = () => (App.data.accounts || []).map(a => ({ value: `${a.code} ${a.name}`, sub: a.type || '' }));
    [['#eoProvAcc', 'provAcc'], ['#eoExpAcc', 'expAcc']].forEach(([sel, k]) => {
      const el = q(sel); if (!el) return;
      U.attachAutocomplete(el, { items: accItems, empty: () => t('eo_no_accounts') });
      change(el, (c, e) => { c[k] = e.value.trim(); });
    });

    // Single employee form: live result without re-rendering (keeps the cursor).
    root.querySelectorAll('[data-ef]').forEach(el => el.addEventListener('input', () => {
      st.form[el.dataset.ef] = el.type === 'number' ? (el.value === '' ? '' : +el.value) : el.value.trim();
      const out = q('#eoOneOut'); if (out) out.innerHTML = oneOut(cfg());
    }));
    q('#eoAdd').addEventListener('click', () => {
      const f = st.form, x = calc(f, cfg());
      if (!x.ok) { U.toast(t(x.err)); return; }
      const e = { code: f.code || '', name: f.name, join: f.join, basic: +f.basic || 0, allow: +f.allow || 0, unpaid: +f.unpaid || 0, paid: +f.paid || 0, prev: +f.prev || 0 };
      const cur = st.emps.find(z => z.id === st.editId);
      if (cur) Object.assign(cur, e); else st.emps.push(Object.assign({ id: U.uid() }, e));
      st.form = {}; st.editId = null; App.rerender();
    });
    const fc = q('#eoFormClear'); if (fc) fc.addEventListener('click', () => { st.form = {}; st.editId = null; App.rerender(); });
    root.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      const e = st.emps.find(z => z.id === b.dataset.edit); if (!e) return;
      st.form = { code: e.code, name: e.name, join: e.join, basic: e.basic, allow: e.allow || '', unpaid: e.unpaid || '', paid: e.paid || '', prev: e.prev || '' };
      st.editId = e.id; App.rerender();
      const nm = document.querySelector('[data-ef="name"]'); if (nm) { nm.scrollIntoView({ block: 'center' }); nm.focus(); }
    }));
    root.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { st.emps = st.emps.filter(z => z.id !== b.dataset.del); App.rerender(); }));
    const xl = q('#eoXlsx'); if (xl) xl.addEventListener('click', exportXlsx);
    const od = q('#eoOdoo'); if (od) od.addEventListener('click', exportOdoo);
  }

  return { render, mount, _onFiles: onFiles, _state: st, _model: model, _calc: calc, _je: () => jeLines(model()) };
})();
