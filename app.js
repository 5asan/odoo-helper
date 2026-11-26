/* App shell: companies, navigation, views. */
const DATA_TYPES = ['accounts', 'contacts', 'analytics'];

const App = {
  view: 'home',
  companies: [],
  companyId: null,
  data: { accounts: [], contacts: [], analytics: [] },

  company() { return this.companies.find(c => c.id === this.companyId) || this.companies[0]; },

  async init() {
    applyLang();
    this.companies = (await Store.get('companies')) || [];
    if (!this.companies.length) {
      this.companies = [{ id: U.uid(), name: t('default_company') }];
      await Store.set('companies', this.companies);
    }
    const saved = await Store.get('activeCompany');
    this.companyId = this.companies.some(c => c.id === saved) ? saved : this.companies[0].id;
    await this.loadCompanyData();

    document.getElementById('langBtn').addEventListener('click', () => {
      setLang(LANG === 'ar' ? 'en' : 'ar');
      this.renderShell(); this.rerender();
    });
    document.getElementById('companySelect').addEventListener('change', e => this.switchCompany(e.target.value));
    window.addEventListener('hashchange', () => this.go(location.hash.slice(1)));
    this.renderShell();
    this.go(location.hash.slice(1) || 'home');
  },

  async loadCompanyData() {
    for (const k of DATA_TYPES) this.data[k] = (await Store.get(`co:${this.companyId}:${k}`)) || [];
  },

  async saveData(type, rows) {
    this.data[type] = rows;
    await Store.set(`co:${this.companyId}:${type}`, rows);
  },

  async switchCompany(id) {
    this.companyId = id;
    await Store.set('activeCompany', id);
    await this.loadCompanyData();
    MasterData.reset();
    this.renderShell(); this.rerender();
  },

  async saveCompanies() { await Store.set('companies', this.companies); },

  renderShell() {
    const sel = document.getElementById('companySelect');
    sel.innerHTML = this.companies.map(c => `<option value="${c.id}" ${c.id === this.companyId ? 'selected' : ''}>${U.esc(c.name)}</option>`).join('');
    const items = [
      ['home', 'nav_home'], null,
      ['bank', 'nav_bank', true], ['bills', 'nav_bills'],
      ['recon', 'nav_recon'], ['gl', 'nav_gl', true], ['audit', 'nav_audit', true], null,
      ['master', 'nav_master', true], ['companies', 'nav_companies', true],
    ];
    document.getElementById('nav').innerHTML = items.map(it => it ? `
      <a href="#${it[0]}" class="${this.view === it[0] ? 'active' : ''}">
        <span>${t(it[1])}</span>${it[2] || it[0] === 'home' ? '' : `<span class="badge soon">${t('soon')}</span>`}
      </a>` : '<div class="sep"></div>').join('');
  },

  go(view) {
    if (!Views[view]) view = 'home';
    this.view = view;
    this.renderShell();
    this.rerender();
    window.scrollTo(0, 0);
  },

  rerender() {
    const main = document.getElementById('main');
    const v = Views[this.view];
    main.innerHTML = v.render();
    if (v.mount) v.mount(main);
  },
};

/* ---------- Views ---------- */
const Home = {
  render() {
    const co = App.company(), d = App.data;
    const f = (href, key, desc, ready, extra = '') => `
      <a class="card feature" href="#${href}">
        <div class="row"><h2 style="margin:0">${t(key)}</h2><span class="spacer"></span>
          <span class="badge ${ready ? 'ok' : 'soon'}">${t(ready ? 'ready' : 'soon')}</span></div>
        <p class="muted" style="margin:0">${t(desc)}</p>${extra}
      </a>`;
    return `
      <div class="page-head">
        <h1>${t('home_title')}</h1>
        <p class="muted">${t('home_sub')}</p>
        <p><b>${U.esc(t('home_active', { name: co.name }))}</b> ·
          <span class="muted">${t('accounts_n', { n: d.accounts.length })} · ${t('contacts_n', { n: d.contacts.length })} · ${t('analytics_n', { n: d.analytics.length })}</span></p>
      </div>
      <div class="grid">
        ${f('bank', 'nav_bank', 'f_bank', true)}
        ${f('gl', 'nav_gl', 'f_gl', true)}
        ${f('audit', 'nav_audit', 'f_audit', true)}
        ${f('master', 'nav_master', 'f_master', true)}
        ${f('companies', 'nav_companies', 'f_companies', true)}
        ${f('bills', 'nav_bills', 'f_bills', false)}
        ${f('recon', 'nav_recon', 'f_recon', false)}
      </div>`;
  },
};

const Companies = {
  render() {
    return `
      <div class="page-head"><h1>${t('companies_title')}</h1><p class="muted">${t('companies_sub')}</p></div>
      <div class="card">
        <div class="row" style="margin-bottom:8px">
          <input id="coName" placeholder="${t('company_name')}" style="min-width:240px">
          <button class="btn" id="coAdd" type="button">${t('add_company')}</button>
        </div>
        ${App.companies.map(c => `
          <div class="list-item">
            <b>${U.esc(c.name)}</b>
            ${c.id === App.companyId ? `<span class="badge ok">${t('active')}</span>` : ''}
            <span class="spacer"></span>
            ${c.id !== App.companyId ? `<button class="btn ghost sm" data-act="use" data-id="${c.id}" type="button">${t('make_active')}</button>` : ''}
            <button class="btn ghost sm" data-act="rename" data-id="${c.id}" type="button">${t('rename')}</button>
            <button class="btn danger sm" data-act="delete" data-id="${c.id}" type="button">${t('delete')}</button>
          </div>`).join('')}
      </div>
      <div class="card">
        <h2>${t('backup_title')}</h2>
        <p class="muted">${t('backup_sub')}</p>
        <div class="row">
          <button class="btn ghost" id="bkExport" type="button">${t('export_backup')}</button>
          <button class="btn ghost" id="bkImport" type="button">${t('import_backup')}</button>
          <input type="file" id="bkFile" accept=".json" hidden>
        </div>
      </div>`;
  },
  mount(root) {
    const name = root.querySelector('#coName');
    const add = async () => {
      const n = name.value.trim(); if (!n) { name.focus(); return; }
      const c = { id: U.uid(), name: n };
      App.companies.push(c);
      await App.saveCompanies();
      await App.switchCompany(c.id);
    };
    root.querySelector('#coAdd').addEventListener('click', add);
    name.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });

    root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
      const c = App.companies.find(x => x.id === b.dataset.id);
      if (b.dataset.act === 'use') return App.switchCompany(c.id);
      if (b.dataset.act === 'rename') {
        const n = await U.ask({ message: t('company_name'), input: c.name, okText: t('save') });
        if (n) { c.name = n; await App.saveCompanies(); App.renderShell(); App.rerender(); }
        return;
      }
      if (App.companies.length === 1) { U.toast(t('cant_delete_last')); return; }
      if (!(await U.ask({ message: t('confirm_delete_company', { name: c.name }), okText: t('delete'), danger: true }))) return;
      App.companies = App.companies.filter(x => x.id !== c.id);
      for (const k of DATA_TYPES) await Store.del(`co:${c.id}:${k}`);
      await App.saveCompanies();
      await App.switchCompany(c.id === App.companyId ? App.companies[0].id : App.companyId);
    }));

    root.querySelector('#bkExport').addEventListener('click', async () => {
      const out = { app: 'odoo-helper', version: 1, exported: new Date().toISOString(), companies: [] };
      for (const c of App.companies) {
        const e = { name: c.name };
        for (const k of DATA_TYPES) e[k] = (await Store.get(`co:${c.id}:${k}`)) || [];
        out.companies.push(e);
      }
      const json = JSON.stringify(out);
      const res = await U.download(`odoo-helper-backup-${new Date().toISOString().slice(0, 10)}.json`, json);
      if (String(res).startsWith('unavailable')) {
        U.copyDialog({ message: t('backup_copy_msg'), text: json, reason: String(res).split(':')[1] });
      }
    });
    const file = root.querySelector('#bkFile');
    root.querySelector('#bkImport').addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      try {
        const data = JSON.parse(new TextDecoder().decode(await U.readFile(file.files[0])));
        if (data.app !== 'odoo-helper' || !Array.isArray(data.companies)) throw new Error(t('bad_backup'));
        for (const e of data.companies) {
          const c = { id: U.uid(), name: String(e.name || t('default_company')) };
          App.companies.push(c);
          for (const k of DATA_TYPES) await Store.set(`co:${c.id}:${k}`, Array.isArray(e[k]) ? e[k] : []);
        }
        await App.saveCompanies();
        U.toast(t('imported_companies', { n: data.companies.length }));
        App.renderShell(); App.rerender();
      } catch (err) { U.toast(err.message === t('bad_backup') ? err.message : t('bad_backup')); }
      file.value = '';
    });
  },
};

const comingSoon = (titleKey, descKey) => ({
  render: () => `
    <div class="page-head"><h1>${t(titleKey)}</h1></div>
    <div class="card"><span class="badge soon">${t('soon')}</span>
      <h2 style="margin-top:10px">${t('soon_title')}</h2><p class="muted">${t(descKey)}</p></div>`,
});

const Views = {
  home: Home,
  bank: Bank,
  master: MasterData,
  companies: Companies,
  bills: comingSoon('nav_bills', 'soon_bills'),
  recon: comingSoon('nav_recon', 'soon_recon'),
  gl: GL,
  audit: Audit,
};

App.init();
