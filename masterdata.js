/* Master Data: Chart of Accounts, Contacts, Analytic Accounts (per company). */
const MasterData = (() => {
  const TYPES = {
    accounts: {
      tab: 'tab_accounts', how: 'how_accounts',
      fields: [
        { k: 'code', label: 'fld_code', req: true, re: /^(code|account code|الرمز|رمز|كود)/i },
        { k: 'name', label: 'fld_name', req: true, re: /(account name|^name$|^name\b|اسم الحساب|^الاسم|^اسم)/i },
        { k: 'type', label: 'fld_type', re: /(type|النوع|نوع)/i },
      ],
    },
    contacts: {
      tab: 'tab_contacts', how: 'how_contacts',
      fields: [
        { k: 'name', label: 'fld_name', req: true, re: /(display name|complete name|^name|^الاسم|^اسم)/i },
        { k: 'vat', label: 'fld_vat', re: /(tax id|vat|الرقم الضريبي|ضريب)/i },
        { k: 'ref', label: 'fld_ref', re: /(^reference|^ref\b|^internal ref|المرجع)/i },
        { k: 'email', label: 'fld_email', re: /(e-?mail|البريد)/i },
      ],
    },
    analytics: {
      tab: 'tab_analytics', how: 'how_analytics',
      fields: [
        { k: 'name', label: 'fld_name', req: true, re: /(^name|analytic account|^الاسم|^اسم)/i },
        { k: 'code', label: 'fld_ref', re: /(^reference|^ref\b|^code|المرجع|الرمز)/i },
        { k: 'plan', label: 'fld_plan', re: /(plan|الخطة|خطة)/i },
      ],
    },
  };

  let tab = 'accounts';
  let pending = null;   // { type, headers, rows, map }
  let query = '';

  function autoMap(type, headers) {
    const used = new Set();
    const map = {};
    for (const f of TYPES[type].fields) {
      const idx = headers.findIndex((h, i) => !used.has(i) && f.re.test(h.trim()));
      map[f.k] = idx;
      if (idx >= 0) used.add(idx);
    }
    // Fallbacks: if required fields are unmapped, use first unused columns.
    for (const f of TYPES[type].fields) {
      if (f.req && map[f.k] < 0) {
        const idx = headers.findIndex((h, i) => !used.has(i) && h);
        map[f.k] = idx; if (idx >= 0) used.add(idx);
      }
    }
    return map;
  }

  function render() {
    const co = App.company();
    const d = App.data;
    return `
      <div class="page-head">
        <h1>${t('master_title')}</h1>
        <p class="muted">${U.esc(t('master_sub', { name: co.name }))}</p>
      </div>
      <div class="tabs" role="tablist">
        ${Object.keys(TYPES).map(k => `<button type="button" role="tab" data-tab="${k}" class="${k === tab ? 'active' : ''}">
          ${t(TYPES[k].tab)} <span class="badge soon">${d[k].length}</span></button>`).join('')}
      </div>
      ${pending ? renderMapping() : renderList()}`;
  }

  function renderList() {
    const T = TYPES[tab];
    const list = App.data[tab];
    const q = U.norm(query);
    const filtered = q ? list.filter(r => U.norm(Object.values(r).join(' ')).includes(q)) : list;
    const shown = filtered.slice(0, 300);
    return `
      <div class="card">
        <p class="muted small">${t(T.how)}</p>
        <div class="row">
          <button class="btn" id="mdUpload" type="button">${t('upload_file')}</button>
          <input type="file" id="mdFile" accept=".xlsx,.xls,.csv" hidden>
          <input type="search" id="mdSearch" placeholder="${t('search')}" value="${U.esc(query)}" style="min-width:220px">
          <span class="spacer"></span>
          ${list.length ? `<button class="btn danger sm" id="mdClear" type="button">${t('clear_all')}</button>` : ''}
        </div>
      </div>
      <div class="card">
        ${list.length ? `
          <p class="muted small">${t('showing', { a: shown.length, b: filtered.length })}</p>
          <div class="table-wrap"><table>
            <thead><tr>${T.fields.map(f => `<th>${t(f.label)}</th>`).join('')}</tr></thead>
            <tbody>${shown.map(r => `<tr>${T.fields.map(f => `<td>${U.esc(r[f.k] || '')}</td>`).join('')}</tr>`).join('')}</tbody>
          </table></div>` : `<p class="muted">${t('no_data')}</p>`}
      </div>`;
  }

  function renderMapping() {
    const T = TYPES[pending.type];
    const opts = sel => `<option value="-1">${t('not_used')}</option>` +
      pending.headers.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${U.esc(h || '#' + (i + 1))}</option>`).join('');
    const preview = pending.rows.slice(0, 8);
    return `
      <div class="card">
        <h2>${t('map_columns')}</h2>
        <p class="muted small">${t('map_hint')}</p>
        <div class="row" style="margin-bottom:14px">
          ${T.fields.map(f => `<label class="field">${t(f.label)}${f.req ? ' *' : ''}
            <select data-map="${f.k}">${opts(pending.map[f.k])}</select></label>`).join('')}
        </div>
        <h3>${t('preview')} (${pending.rows.length})</h3>
        <div class="table-wrap" style="margin-bottom:14px"><table>
          <thead><tr>${T.fields.map(f => `<th>${t(f.label)}</th>`).join('')}</tr></thead>
          <tbody>${preview.map(r => `<tr>${T.fields.map(f => `<td>${U.esc(pending.map[f.k] >= 0 ? r[pending.map[f.k]] : '')}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
        <div class="row">
          <button class="btn" id="mdSave" type="button">${t('save')}</button>
          <button class="btn ghost" id="mdCancel" type="button">${t('cancel')}</button>
        </div>
      </div>`;
  }

  async function onFile(file) {
    try {
      const rows = (await U.readSheet(file)).filter(r => r.some(c => c));
      const hi = rows.findIndex(r => r.filter(c => c).length >= 2);
      const headerIdx = hi < 0 ? 0 : hi;
      const headers = rows[headerIdx] || [];
      pending = { type: tab, headers, rows: rows.slice(headerIdx + 1), map: autoMap(tab, headers) };
      App.rerender();
    } catch (e) { U.toast(t('error', { e: e.message })); }
  }

  async function save() {
    const T = TYPES[pending.type];
    const missing = T.fields.filter(f => f.req && pending.map[f.k] < 0).map(f => t(f.label));
    if (missing.length) { U.toast(t('required_missing', { f: missing.join(', ') })); return; }
    const out = [];
    for (const r of pending.rows) {
      const o = {};
      for (const f of T.fields) o[f.k] = pending.map[f.k] >= 0 ? (r[pending.map[f.k]] || '').trim() : '';
      if (T.fields.filter(f => f.req).every(f => o[f.k])) out.push(o);
    }
    if (pending.type === 'accounts') out.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    await App.saveData(pending.type, out);
    pending = null;
    U.toast(t('saved_n', { n: out.length }));
    App.rerender();
  }

  function mount(root) {
    root.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      tab = b.dataset.tab; pending = null; query = ''; App.rerender();
    }));
    if (pending) {
      root.querySelectorAll('[data-map]').forEach(s => s.addEventListener('change', () => {
        pending.map[s.dataset.map] = +s.value; App.rerender();
      }));
      root.querySelector('#mdSave').addEventListener('click', save);
      root.querySelector('#mdCancel').addEventListener('click', () => { pending = null; App.rerender(); });
      return;
    }
    const file = root.querySelector('#mdFile');
    root.querySelector('#mdUpload').addEventListener('click', () => file.click());
    file.addEventListener('change', () => { if (file.files[0]) onFile(file.files[0]); });
    const search = root.querySelector('#mdSearch');
    search.addEventListener('input', () => {
      query = search.value;
      const pos = search.selectionStart;
      App.rerender();
      const s2 = document.getElementById('mdSearch');
      s2.focus(); s2.setSelectionRange(pos, pos);
    });
    const clear = root.querySelector('#mdClear');
    if (clear) clear.addEventListener('click', async () => {
      if (!(await U.ask({ message: t('confirm_clear', { what: t(TYPES[tab].tab) }), okText: t('clear_all'), danger: true }))) return;
      await App.saveData(tab, []);
      App.rerender();
    });
  }

  function reset() { pending = null; query = ''; }

  return { render, mount, reset };
})();
