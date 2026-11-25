/* GL Analysis: find the same label / reference posted to different accounts.
   Reads an Odoo Journal Items export (one row per line, with an Account column) or the
   General Ledger report export (account title rows followed by their lines). */
const GL = (() => {
  const FIELDS = [
    { k: 'date', re: /^(date|accounting date|التاريخ|تاريخ)/i },
    { k: 'move', re: /(journal entry|^entry\b|^number|^move\b|^voucher|القيد|المستند)/i },
    { k: 'journal', re: /^(journal|اليومية|دفتر اليومية)$/i },
    { k: 'account', re: /^(account|الحساب|حساب)/i },
    { k: 'partner', re: /(partner|الشريك|الجهة)/i },
    { k: 'label', re: /(label|communication|description|narration|البيان|الوصف)/i },
    { k: 'ref', re: /^(reference|ref\b|المرجع)/i },
    { k: 'debit', re: /^(debit|مدين)/i },
    { k: 'credit', re: /^(credit|دائن)/i },
    { k: 'amount', re: /^(amount|balance|المبلغ|الرصيد)$/i },
  ];
  const SKIP_RE = /^\s*(total|grand total|initial balance|opening balance|load more|الإجمالي|إجمالي|اجمالي|المجموع|الرصيد الافتتاحي)/i;
  const ACC_ROW_RE = /^\s*[\w.\-]*\d[\w.\-]*\s+\S/;
  const MOVE_RE = /[A-Za-z]{2,}[\w-]*\/(\d{2,4}\/)?\d+/;
  const CONTROL_TYPE_RE = /bank|cash|receivable|payable|credit card|بنك|نقد|صندوق|مدين|دائن|ذمم|بطاق/i;
  const CONTROL_NAME_RE = /bank|cash|receivable|payable|outstanding|suspense|liquidity|بنك|مصرف|صندوق|نقدي|ذمم|مدينون|دائنون|معلق/i;
  const MONTH_RE = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?|يناير|فبراير|مارس|ابريل|مايو|يونيو|يوليو|اغسطس|سبتمبر|اكتوبر|نوفمبر|ديسمبر)\b/g;
  const PAGE = 150;

  let settings = { mode: 'label', loose: false, skipControl: true, ignore: '' };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('oh_gl_settings') || '{}')); } catch (e) { /* default */ }
  const saveSettings = () => { try { localStorage.setItem('oh_gl_settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } };

  const st = { fileName: '', status: 'idle', error: '', rows: [], headerIdx: -1, headers: [], map: {}, lines: [], result: null, query: '', limit: PAGE };

  const num = s => { const p = U.parseNum(s); return p ? p.v : 0; };
  const money = v => (v ? U.fmtMoney(v) : '');

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
    // Odoo's General Ledger report has an unnamed first column holding the entry number.
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
    let curAcc = '', accRows = 0;
    const cell = (r, k) => (map[k] >= 0 ? String(r[map[k]] || '').trim() : '');
    for (const r of data) {
      if (!r.some(c => c)) continue;
      if (map.account >= 0 && cell(r, 'account') === (header[map.account] || '').trim()) continue; // repeated header
      const first = r.find(c => c) || '';
      if (SKIP_RE.test(first) || SKIP_RE.test(cell(r, 'label'))) continue;
      const date = map.date >= 0 ? U.parseDate(cell(r, 'date'), order) : null;
      if (map.account < 0 && !date && ACC_ROW_RE.test(first)) { curAcc = first.trim(); accRows++; continue; }
      if (map.date >= 0 && !date) continue;
      let debit = 0, credit = 0;
      if (map.debit >= 0 || map.credit >= 0) { debit = Math.abs(num(cell(r, 'debit'))); credit = Math.abs(num(cell(r, 'credit'))); }
      else if (map.amount >= 0) { const v = num(cell(r, 'amount')); if (v > 0) debit = v; else credit = -v; }
      if (!debit && !credit) continue;
      const account = map.account >= 0 ? cell(r, 'account') : curAcc;
      if (!account) continue;
      lines.push({
        n: lines.length, date, move: cell(r, 'move'), journal: cell(r, 'journal'), account,
        partner: cell(r, 'partner'), label: cell(r, 'label'), ref: cell(r, 'ref'), debit, credit,
      });
    }
    st.lines = lines;
    st.grouped = map.account < 0 && accRows > 0;
  }

  /* ---------- Analysis ---------- */
  function accountInfo() {
    const byCode = new Map(App.data.accounts.map(a => [String(a.code).trim(), a]));
    const cache = new Map();
    return text => {
      let r = cache.get(text);
      if (r) return r;
      const m = text.match(/^\s*([\w.\-]*\d[\w.\-]*)(\s+|$)/);
      const code = m ? m[1] : '';
      const coa = code ? byCode.get(code) : null;
      const name = coa && !text.slice(code.length).trim() ? `${code} ${coa.name}` : text;
      const control = coa && coa.type ? CONTROL_TYPE_RE.test(coa.type) : CONTROL_NAME_RE.test(name);
      r = { key: code || U.norm(text), name, control };
      cache.set(text, r);
      return r;
    };
  }

  function keyOf(text) {
    let k = U.norm(text);
    if (settings.loose) k = k.replace(MONTH_RE, ' ').replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
    if (k.length < 2 || /^[\d\s]+$/.test(k)) return '';
    return k;
  }

  function analyse() {
    const info = accountInfo();
    const ignore = settings.ignore.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const hasMove = st.map.move >= 0 && st.lines.some(l => l.move);
    const lines = [];
    let dropped = 0;
    for (const l of st.lines) {
      const a = info(l.account);
      if ((settings.skipControl && a.control) || ignore.some(p => a.key.startsWith(p))) { dropped++; continue; }
      lines.push(Object.assign(l, { acc: a.key, accName: a.name }));
    }
    const out = {};
    for (const field of ['label', 'ref']) {
      const groups = new Map();
      for (const l of lines) {
        const k = keyOf(l[field]);
        if (!k) continue;
        let g = groups.get(k);
        if (!g) groups.set(k, g = { key: k, text: l[field], lines: [] });
        g.lines.push(l);
      }
      const flagged = [];
      for (const g of groups.values()) {
        const accs = new Map();
        for (const l of g.lines) {
          let a = accs.get(l.acc);
          if (!a) accs.set(l.acc, a = { acc: l.acc, name: l.accName, lines: 0, moves: new Set(), amount: 0 });
          a.lines++; a.moves.add(l.move || 'line' + l.n); a.amount += l.debit - l.credit;
        }
        if (accs.size < 2) continue;
        let usual;
        if (hasMove) {
          // Compare entries, not lines: both sides of one entry often share a label.
          const perMove = new Map();
          for (const l of g.lines) {
            const m = l.move || 'line' + l.n;
            if (!perMove.has(m)) perMove.set(m, new Set());
            perMove.get(m).add(l.acc);
          }
          const sigs = new Map();
          for (const set of perMove.values()) {
            const s = [...set].sort().join('|');
            sigs.set(s, (sigs.get(s) || 0) + 1);
          }
          if (sigs.size < 2) continue;
          const top = [...sigs.entries()].sort((a, b) => b[1] - a[1] || b[0].split('|').length - a[0].split('|').length)[0][0];
          usual = new Set(top.split('|'));
        } else {
          const top = [...accs.values()].sort((a, b) => b.lines - a.lines)[0];
          usual = new Set([top.acc]);
        }
        const odd = g.lines.filter(l => !usual.has(l.acc));
        if (!odd.length) continue;
        g.accounts = [...accs.values()].map(a => Object.assign(a, { usual: usual.has(a.acc), moves: a.moves.size }))
          .sort((a, b) => b.usual - a.usual || b.moves - a.moves);
        g.odd = odd.length;
        g.moves = new Set(g.lines.map(l => l.move || 'line' + l.n)).size;
        g.lines.sort((a, b) => usual.has(a.acc) - usual.has(b.acc) || String(a.date).localeCompare(String(b.date)));
        g.usual = usual;
        flagged.push(g);
      }
      flagged.sort((a, b) => b.lines.length - a.lines.length || a.text.localeCompare(b.text));
      out[field] = { checked: groups.size, flagged };
    }
    st.result = {
      ...out, hasMove, dropped, used: lines.length,
      moves: hasMove ? new Set(st.lines.map(l => l.move)).size : null,
    };
    st.limit = PAGE;
  }

  /* ---------- File handling ---------- */
  async function onFiles(files) {
    const file = files[0];
    Object.assign(st, { fileName: file.name, status: 'busy', error: '', result: null, lines: [], query: '' });
    App.rerender();
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
            ${st.result ? `<button class="btn" id="glXlsx" type="button">${t('download_xlsx')}</button>
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
      <div class="row" style="margin-top:14px;align-items:flex-end">
        <label class="field">${t('gl_compare')}
          <select id="glMode">
            <option value="label" ${settings.mode === 'label' ? 'selected' : ''}>${t('gl_by_label')}</option>
            <option value="ref" ${settings.mode === 'ref' ? 'selected' : ''}>${t('gl_by_ref')}</option>
          </select></label>
        <label class="field">${t('gl_ignore')}
          <input id="glIgnore" value="${U.esc(settings.ignore)}" placeholder="${t('gl_ignore_ph')}" style="min-width:200px" dir="ltr"></label>
      </div>
      <div class="row" style="margin-top:10px">
        <label class="row" style="gap:6px"><input type="checkbox" id="glControl" ${settings.skipControl ? 'checked' : ''}> ${t('gl_skip_control')}</label>
        <label class="row" style="gap:6px"><input type="checkbox" id="glLoose" ${settings.loose ? 'checked' : ''}> ${t('gl_loose')}</label>
      </div>`;
  }

  function filtered() {
    const R = st.result[settings.mode];
    const q = U.norm(st.query);
    if (!q) return R.flagged;
    return R.flagged.filter(g => g.key.includes(q) || g.accounts.some(a => U.norm(a.name).includes(q)) ||
      g.lines.some(l => U.norm(l.partner + ' ' + l.move).includes(q)));
  }

  function renderResult() {
    const R = st.result, cur = R[settings.mode];
    const list = filtered();
    const oddLines = cur.flagged.reduce((s, g) => s + g.odd, 0);
    const shown = list.slice(0, st.limit);
    return `
      <div class="card">
        <div class="stats">
          <div class="stat"><b>${st.lines.length}</b><span>${t('gl_lines')}</span></div>
          ${R.moves != null ? `<div class="stat"><b>${R.moves}</b><span>${t('gl_entries')}</span></div>` : ''}
          <div class="stat"><b>${cur.checked}</b><span>${t(settings.mode === 'label' ? 'gl_labels_checked' : 'gl_refs_checked')}</span></div>
          <div class="stat"><b class="${cur.flagged.length ? 'neg' : 'pos'}">${cur.flagged.length}</b><span>${t('gl_flagged')}</span></div>
          <div class="stat"><b>${oddLines}</b><span>${t('gl_to_check')}</span></div>
        </div>
        ${R.dropped ? `<div class="notice info">${t('gl_dropped', { n: R.dropped })}</div>` : ''}
        ${!R.hasMove ? `<div class="notice warn">${t('gl_no_move')}</div>` : ''}
        ${cur.flagged.length
          ? `<p class="muted small">${t('gl_explain')}</p>
             <input type="search" id="glSearch" placeholder="${t('search')}" value="${U.esc(st.query)}" style="min-width:240px;margin-bottom:12px">
             <div id="glList">${shown.map((g, i) => renderGroup(g, i)).join('')}</div>
             ${list.length > shown.length ? `<button class="btn ghost sm" id="glMore" type="button">${t('gl_more', { n: list.length - shown.length })}</button>` : ''}
             ${!list.length ? `<p class="muted">${t('gl_no_search')}</p>` : ''}`
          : `<div class="notice ok">✓ ${t(settings.mode === 'label' ? 'gl_clean_label' : 'gl_clean_ref')}</div>`}
      </div>`;
  }

  function renderGroup(g, i) {
    return `
      <details class="gl-group" data-g="${i}">
        <summary>
          <span class="gl-text">${U.esc(g.text)}</span>
          <span class="badge warn">${t('gl_odd_n', { n: g.odd })}</span>
          <span class="muted small">${t('gl_group_meta', { l: g.lines.length, a: g.accounts.length })}</span>
          <div class="gl-accs">${g.accounts.map(a => `
            <span class="gl-acc ${a.usual ? '' : 'odd'}" title="${U.esc(t(a.usual ? 'gl_usual' : 'gl_different'))}">
              ${U.esc(a.name)} <b>×${a.lines}</b></span>`).join('')}</div>
        </summary>
        <div class="gl-body"></div>
      </details>`;
  }

  function renderLines(g) {
    const rows = g.lines.slice(0, 500);
    return `
      <div class="table-wrap"><table>
        <thead><tr><th>${t('h_date')}</th><th>${t('gl_h_move')}</th><th>${t('gl_h_account')}</th><th>${t('h_partner')}</th>
          <th>${t('h_label')}</th><th>${t('fld_ref')}</th><th class="num">${t('role_debit')}</th><th class="num">${t('role_credit')}</th></tr></thead>
        <tbody>${rows.map(l => `
          <tr class="${g.usual.has(l.acc) ? '' : 'mismatch'}">
            <td style="white-space:nowrap">${U.esc(l.date || '')}</td><td dir="ltr" style="white-space:nowrap">${U.esc(l.move)}</td>
            <td>${U.esc(l.accName)}</td><td>${U.esc(l.partner)}</td><td>${U.esc(l.label)}</td><td>${U.esc(l.ref)}</td>
            <td class="num">${money(l.debit)}</td><td class="num">${money(l.credit)}</td></tr>`).join('')}
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
    const cur = st.result[settings.mode];
    const head = [t('gl_x_text'), t('gl_x_status'), t('gl_h_account'), t('gl_x_usual'), t('h_date'), t('gl_h_move'),
      t('h_partner'), t('h_label'), t('fld_ref'), t('role_debit'), t('role_credit')];
    const aoa = [head];
    for (const g of cur.flagged) {
      const usual = g.accounts.filter(a => a.usual).map(a => a.name).join(' + ');
      for (const l of g.lines) {
        aoa.push([g.text, t(g.usual.has(l.acc) ? 'gl_usual' : 'gl_different'), l.accName, usual, l.date || '', l.move,
          l.partner, l.label, l.ref, l.debit || '', l.credit || '']);
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
    const rerun = () => { saveSettings(); if (st.lines.length) { analyse(); } App.rerender(); };

    q('#glMode').addEventListener('change', e => { settings.mode = e.target.value; st.limit = PAGE; saveSettings(); App.rerender(); });
    q('#glControl').addEventListener('change', e => { settings.skipControl = e.target.checked; rerun(); });
    q('#glLoose').addEventListener('change', e => { settings.loose = e.target.checked; rerun(); });
    q('#glIgnore').addEventListener('change', e => { settings.ignore = e.target.value; rerun(); });

    const nw = q('#glNew');
    if (nw) nw.addEventListener('click', () => {
      Object.assign(st, { fileName: '', rows: [], headers: [], lines: [], result: null, error: '', query: '' });
      App.rerender();
    });
    const xl = q('#glXlsx');
    if (xl) xl.addEventListener('click', async () => {
      const aoa = exportRows();
      const name = `GL-check-${settings.mode}-${U.safeName(st.fileName.replace(/\.[^.]+$/, ''))}.xlsx`;
      afterSave(await U.downloadXLSX(name, aoa, 'Review', [32, 12, 30, 30, 11, 18, 24, 32, 18, 12, 12]), aoa);
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

    const list = filtered && st.result ? filtered() : [];
    root.querySelectorAll('details.gl-group').forEach(d => d.addEventListener('toggle', () => {
      const body = d.querySelector('.gl-body');
      if (d.open && !body.innerHTML) body.innerHTML = renderLines(list[+d.dataset.g]);
    }));
  }

  return { render, mount, _onFiles: onFiles, _state: st };
})();
