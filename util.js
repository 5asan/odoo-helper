/* Shared helpers: escaping, numbers, dates, files, downloads. */
const U = (() => {
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /* Arabic-Indic and Persian digits → ASCII */
  function digits(s) {
    return String(s)
      .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
      .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/٫/g, '.').replace(/٬/g, ',');
  }

  /* Parse an amount like "1,234.50", "1.234,50", "(500.00)", "500.00-", "500.00 CR".
     Returns {v, sfx} where sfx is 'C' / 'D' / null, or null if not a number. */
  function parseNum(input) {
    if (input == null) return null;
    if (typeof input === 'number') return isFinite(input) ? { v: input, sfx: null } : null;
    let s = digits(input).trim();
    if (!s || /[\/:]/.test(s)) return null;
    let neg = false, sfx = null;
    const m = s.match(/\s*(CR|DR|Cr|Dr|cr|dr)\.?$/);
    if (m) { sfx = m[1].toUpperCase()[0]; s = s.slice(0, m.index); }
    s = s.replace(/(SAR|AED|USD|EUR|GBP|KWD|QAR|BHD|OMR|EGP|JOD|IQD|ر\.س|د\.إ|ريال|درهم|دينار)/gi, '')
         .replace(/[\s$€£‎‏‪-‮]/g, '');
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    else if (s.startsWith('+')) s = s.slice(1);
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (lastComma >= 0) {
      const commas = (s.match(/,/g) || []).length;
      const decLen = s.length - lastComma - 1;
      s = (commas === 1 && decLen !== 3) ? s.replace(',', '.') : s.replace(/,/g, '');
    } else if ((s.match(/\./g) || []).length > 1) {
      s = s.replace(/\./g, '');
    }
    const v = parseFloat(s);
    if (isNaN(v)) return null;
    return { v: neg ? -v : v, sfx };
  }

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    'يناير': 1, 'فبراير': 2, 'مارس': 3, 'أبريل': 4, 'ابريل': 4, 'إبريل': 4, 'مايو': 5, 'يونيو': 6, 'يوليو': 7,
    'أغسطس': 8, 'اغسطس': 8, 'سبتمبر': 9, 'أكتوبر': 10, 'اكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12,
  };
  function monthFromName(n) {
    n = n.toLowerCase();
    if (MONTHS[n]) return MONTHS[n];
    return MONTHS[n.slice(0, 3)] || null;
  }
  function valid(y, m, d) {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  /* Parse a date at the start of a string. order: 'DMY' or 'MDY'. Returns ISO 'YYYY-MM-DD' or null. */
  function parseDate(input, order = 'DMY') {
    if (input == null) return null;
    if (input instanceof Date && !isNaN(input)) return valid(input.getFullYear(), input.getMonth() + 1, input.getDate());
    const s = digits(input).trim();
    let m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?!\d)/);
    if (m) return valid(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4}|\d{2})(?!\d)/);
    if (m) {
      let a = +m[1], b = +m[2], y = +m[3];
      let d = order === 'MDY' ? b : a, mo = order === 'MDY' ? a : b;
      if (mo > 12 && d <= 12) { const tmp = d; d = mo; mo = tmp; }
      return valid(y, mo, d);
    }
    m = s.match(/^(\d{1,2})[\s\-\/.]*([A-Za-z؀-ۿ]{3,})\.?[\s\-\/.,]*(\d{4}|\d{2})(?!\d)/);
    if (m) { const mo = monthFromName(m[2]); if (mo) return valid(+m[3], mo, +m[1]); }
    m = s.match(/^([A-Za-z]{3,})\.?[\s\-]*(\d{1,2}),?[\s\-]*(\d{4})(?!\d)/);
    if (m) { const mo = monthFromName(m[1]); if (mo) return valid(+m[3], mo, +m[2]); }
    return null;
  }

  function fmtDate(iso, fmt) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    if (fmt === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
    if (fmt === 'MM/DD/YYYY') return `${m}/${d}/${y}`;
    return iso;
  }

  function fmtMoney(v) {
    if (v == null || isNaN(v)) return '';
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const round2 = v => Math.round(v * 100) / 100;

  /* Normalise text for matching: lowercase, no punctuation, unify Arabic letters. */
  function norm(s) {
    return digits(s || '').toLowerCase()
      .replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ً-ْـ]/g, '')
      .replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(file);
    });
  }

  /* Read an Excel/CSV file into an array of row arrays (strings). */
  async function readSheet(file) {
    const buf = await readFile(file);
    let wb;
    if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
      const text = new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '');
      wb = XLSX.read(text, { type: 'string', raw: true });
    } else {
      wb = XLSX.read(buf, { type: 'array', cellDates: true });
    }
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', dateNF: 'yyyy-mm-dd' })
      .map(r => r.map(c => (c == null ? '' : String(c).trim())));
  }

  /* Save a file. On the hosted (claude.ai) page this goes through the viewer's download
     permission; when opened as a local file it uses a normal browser download. */
  // Returns 'saved', 'declined', 'busy', or 'unavailable:<reason>' (caller then offers Copy instead).
  let lastPerms = null;   // set when the viewer turned downloads off, so the dialog can offer to switch it back on
  const inFrame = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  async function download(name, data) {
    const hasClaude = !!(window.claude && typeof window.claude.use === 'function');
    if (hasClaude || inFrame) {
      let dl = null, code = hasClaude ? 'no_permission' : 'not_signed_in';
      if (hasClaude) { try { dl = await window.claude.use('downloads'); } catch (e) { dl = null; } }
      if (hasClaude && !dl) {
        // Ask the viewer for the download permission if it is askable, then try again.
        try {
          const perms = await window.claude.use('permissions');
          let state = perms ? await perms.state('downloads') : 'unavailable';
          if (state === 'prompt') state = ((await perms.request(['downloads'])) || {}).downloads || state;
          if (state === 'granted') dl = await window.claude.use('downloads');
          code = 'downloads_' + state;
          if (!dl && state === 'denied') lastPerms = perms;
        } catch (e) { /* keep code */ }
      }
      if (dl) {
        try { await dl.save({ filename: name, data }); return 'saved'; }
        catch (e) {
          code = (e && e.code) || 'unavailable';
          if (code === 'declined') return 'declined';
          if (code === 'rate_limited') { toast(t('download_busy')); return 'busy'; }
        }
      }
      return 'unavailable:' + code;
    }
    const blob = data instanceof Blob ? data : new Blob([data]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    return 'saved';
  }

  /* Fallback when a file can't be saved: show the content with a Copy button.
     Tab-separated text pastes straight into Excel cells. */
  function copyDialog({ message, text, reason }) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="width:min(640px,100%)">
        <h2>${t('save_failed_title')}</h2>
        <p>${esc(message)}</p>
        <p class="muted small">${t('save_failed_reason')}: <code>${esc(reason || '')}</code></p>
        <textarea id="copyText" readonly dir="ltr" style="width:100%;height:160px;font-family:ui-monospace,Consolas,monospace;font-size:12px;margin-bottom:12px"></textarea>
        <div class="row end">
          ${lastPerms && reason === 'downloads_denied' ? `<button type="button" class="btn ghost" data-a="perm">${t('allow_downloads')}</button>` : ''}
          <button type="button" class="btn ghost" data-a="close">${t('close')}</button>
          <button type="button" class="btn" data-a="copy">${t('copy')}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const ta = wrap.querySelector('#copyText');
    ta.value = text;
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrap.querySelector('[data-a="close"]').addEventListener('click', close);
    const perm = wrap.querySelector('[data-a="perm"]');
    if (perm) perm.addEventListener('click', async () => {
      try { await lastPerms.manage(); close(); toast(t('try_again')); } catch (e) { toast(t('perm_menu_hint')); }
    });
    wrap.querySelector('[data-a="copy"]').addEventListener('click', () => {
      const fallback = () => { ta.focus(); ta.select(); try { document.execCommand('copy'); toast(t('copied')); } catch (e) { toast(t('copy_manual')); } };
      try {
        navigator.clipboard.writeText(text).then(() => toast(t('copied')), fallback);
      } catch (e) { fallback(); }
    });
  }

  const toTSV = aoa => aoa.map(r => r.map(c => String(c == null ? '' : c).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');

  function toCSV(aoa) {
    return '﻿' + aoa.map(r => r.map(c => {
      const s = c == null ? '' : String(c);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
  }

  function downloadCSV(name, aoa) { return download(name, toCSV(aoa)); }

  function downloadXLSX(name, aoa, sheetName = 'Sheet1', widths) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (widths) ws['!cols'] = widths.map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    return download(name, new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
  }

  /* In-page dialog (browser confirm/prompt are blocked on the hosted page).
     ask({message, input, okText, danger}) → resolves true / the typed text, or null if cancelled. */
  function ask({ message, input = null, okText, danger = false }) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <p>${esc(message)}</p>
          ${input != null ? `<input id="askInput" value="${esc(input)}" style="width:100%;margin-bottom:12px">` : ''}
          <div class="row end">
            <button type="button" class="btn ghost" data-a="no">${t('cancel')}</button>
            <button type="button" class="btn ${danger ? 'danger' : ''}" data-a="yes">${esc(okText || t('ok'))}</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const inp = wrap.querySelector('#askInput');
      const done = v => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const yes = () => done(inp ? (inp.value.trim() || null) : true);
      const onKey = e => { if (e.key === 'Escape') done(null); if (e.key === 'Enter') yes(); };
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('click', e => { if (e.target === wrap) done(null); });
      wrap.querySelector('[data-a="no"]').addEventListener('click', () => done(null));
      wrap.querySelector('[data-a="yes"]').addEventListener('click', yes);
      (inp || wrap.querySelector('[data-a="yes"]')).focus();
      if (inp) inp.select();
    });
  }

  function safeName(s) { return String(s || 'file').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_'); }

  /* Wire a drop zone + hidden input; calls onFiles(FileList). */
  function dropZone(el, input, onFiles) {
    el.addEventListener('click', () => input.click());
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { if (input.files.length) onFiles(input.files); input.value = ''; });
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', e => {
      e.preventDefault(); el.classList.remove('over');
      if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
    });
  }

  return { esc, toast, uid, digits, parseNum, parseDate, fmtDate, fmtMoney, round2, norm, readFile, readSheet,
    download, downloadCSV, downloadXLSX, safeName, dropZone, ask, copyDialog, toTSV };
})();
