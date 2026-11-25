/* Bank Statement → Odoo import file (Date, Label, Partner, Amount, Cumulative balance). */
const Bank = (() => {
  const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const ROLES = ['date', 'label', 'ref', 'partner', 'debit', 'credit', 'amount', 'balance', 'ignore'];
  const OUT_HEADERS = ['Date', 'Label', 'Partner', 'Amount', 'Cumulative balance'];

  // Header keywords, checked in this order (first match wins).
  const KW = [
    ['date', /\bdate\b|تاريخ/i],
    ['balance', /balance|رصيد/i],
    ['debit', /debit|withdraw|paid out|money out|^dr\.?$|مدين|سحب|مسحوب|خصم/i],
    ['credit', /credit|deposit|paid in|money in|^cr\.?$|دائن|إيداع|ايداع/i],
    ['amount', /^amount\b|^المبلغ|^مبلغ/i],
    ['ref', /ref|cheque|chq|check no|المرجع|مرجع|شيك/i],
    ['label', /descr|detail|narrat|particular|transaction|remark|memo|البيان|بيان|الوصف|التفاصيل|تفاصيل|شرح/i],
    ['partner', /beneficiary|counterparty|payee|partner|المستفيد|الطرف/i],
  ];
  const TOTAL_RE = /^\s*(grand\s+)?(total|sub-?total|closing balance|number of|الإجمالي|إجمالي|اجمالي|المجموع|مجموع|عدد)/i;
  const OPENING_RE =/opening|brought forward|b\/f|previous balance|balance forward|رصيد افتتاحي|الرصيد الافتتاحي|الرصيد السابق|رصيد سابق|رصيد أول/i;

  let settings = { dateOrder: 'DMY', debitPositive: true, outDate: 'YYYY-MM-DD' };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('oh_bank_settings') || '{}')); } catch (e) { /* ignore */ }
  const saveSettings = () => { try { localStorage.setItem('oh_bank_settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } };

  // State
  let st = { status: 'idle', fileName: '', error: '', raw: null, roles: [], rows: [], info: {} };

  /* ---------- Reading ---------- */
  function roleOf(text) {
    const s = (text || '').trim();
    if (!s || s.length > 40) return null;
    for (const [role, re] of KW) if (re.test(s)) return role;
    return null;
  }
  function isHeaderCells(strs) {
    if (strs.some(s => U.parseDate(s) || U.parseNum(s))) return false;
    const roles = new Set(strs.map(roleOf).filter(Boolean));
    return roles.size >= 3 || (roles.size >= 2 && roles.has('date'));
  }

  // Money amounts that may be glued to neighbouring text, e.g. "INTERNAAED200,000.00".
  const CUR = '(?:AED|USD|EUR|GBP|SAR|KWD|QAR|BHD|OMR|EGP|JOD|INR)';
  const MONEY_RE = new RegExp(CUR + '\\s?-?\\d[\\d,]*\\.\\d{1,3}|-?\\d{1,3}(?:,\\d{3})+\\.\\d{1,3}', 'g');
  const IS_MONEY = new RegExp('^\\s*' + CUR + '?\\s?[-(]?\\d[\\d,]*\\.\\d{1,3}\\)?-?\\s*(CR|DR)?\\s*$', 'i');

  // Decimal places of the statement's currency (2 for AED/SAR/USD, 3 for KWD/BHD/OMR/JOD). Detected per file.
  let DEC = 2;
  const rnd = v => { const f = Math.pow(10, DEC); return Math.round(v * f) / f; };
  const TOL = () => Math.pow(10, -DEC) * 0.6;
  const fx = v => Number(v).toFixed(DEC);
  const money = v => (v == null || isNaN(v) ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: DEC, maximumFractionDigits: DEC }));

  /* Most common number of decimals among amount cells (wrapped fragments are ignored by taking the mode). */
  function detectDecimals(rows, idx) {
    const count = {};
    for (const r of rows) for (const i of idx) {
      const m = U.digits(r.cells[i] || '').match(/[.,](\d{2,3})\)?-?\s*(CR|DR)?\.?\s*$/i);
      if (m && /\d/.test(r.cells[i]) && !/[\/:]/.test(r.cells[i])) count[m[1].length] = (count[m[1].length] || 0) + 1;
    }
    return (count[3] || 0) > (count[2] || 0) ? 3 : 2;
  }

  /* Split one PDF text item into text / money pieces, estimating each piece's x position. */
  function splitItem(it) {
    const s = it.str, parts = [];
    let last = 0;
    for (const m of s.matchAll(MONEY_RE)) {
      if (m.index > last) parts.push([last, m.index, false]);
      parts.push([m.index, m.index + m[0].length, true]);
      last = m.index + m[0].length;
    }
    if (last < s.length) parts.push([last, s.length, false]);
    if (parts.length <= 1) return [{ ...it, money: IS_MONEY.test(s) }];
    const cw = it.w / Math.max(s.length, 1);
    return parts
      .map(([a, b, money]) => ({ ...it, str: s.slice(a, b), x: it.x + a * cw, w: (b - a) * cw, money: money || IS_MONEY.test(s.slice(a, b)) }))
      .filter(p => p.str.trim());
  }

  function mergeCells(items) {
    const cells = [];
    for (const it of items) {
      const last = cells[cells.length - 1];
      const gap = last ? it.x - last.x1 : Infinity;
      const fs = Math.max(it.h, 4);
      if (last && gap < fs * 0.9 && !it.money && !last.money) {
        last.str += (gap > fs * 0.12 ? ' ' : '') + it.str;
        last.x1 = Math.max(last.x1, it.x + it.w);
      } else cells.push({ str: it.str, x0: it.x, x1: it.x + it.w, money: it.money });
    }
    cells.forEach(c => { c.str = c.str.replace(/\s+/g, ' ').trim(); });
    return cells.filter(c => c.str);
  }

  async function pdfLines(buf) {
    if (!window.pdfjsLib) throw new Error(t('pdf_lib_missing'));
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter(i => i.str && i.str.trim()).flatMap(i => splitItem({
        str: i.str, x: i.transform[4], y: vp.height - i.transform[5], w: i.width,
        h: Math.abs(i.transform[3]) || i.height || 8,
      }));
      items.sort((a, b) => a.y - b.y || a.x - b.x);
      const pageLines = [];
      for (const it of items) {
        const L = pageLines.find(l => Math.abs(l.y - it.y) <= Math.max(2, Math.min(l.h, it.h) * 0.45));
        if (L) { L.items.push(it); L.h = Math.max(L.h, it.h); }
        else pageLines.push({ y: it.y, h: it.h, items: [it], page: p });
      }
      for (const L of pageLines) { L.items.sort((a, b) => a.x - b.x); L.cells = mergeCells(L.items); }
      pageLines.sort((a, b) => a.y - b.y);
      lines.push(...pageLines.filter(l => l.cells.length));
    }
    return lines;
  }

  function spansFrom(cols) {
    cols.sort((a, b) => a.x0 - b.x0);
    cols.forEach((c, i) => {
      c.l = i === 0 ? -Infinity : (cols[i - 1].x1 + c.x0) / 2;
      c.r = i === cols.length - 1 ? Infinity : (c.x1 + cols[i + 1].x0) / 2;
    });
    return cols;
  }

  function clusterColumns(lines) {
    const dateLines = lines.filter(l => l.cells.length >= 2 && U.parseDate(l.cells[0].str, settings.dateOrder));
    const iv = dateLines.flatMap(l => l.cells.map(c => [c.x0, c.x1])).sort((a, b) => a[0] - b[0]);
    const cols = [];
    for (const [a, b] of iv) {
      const last = cols[cols.length - 1];
      if (last && a <= last.x1 + 1) last.x1 = Math.max(last.x1, b);
      else cols.push({ x0: a, x1: b, header: '' });
    }
    return spansFrom(cols);
  }

  function linesToRaw(lines) {
    const hi = lines.findIndex(l => isHeaderCells(l.cells.map(c => c.str)));
    let cols, startIdx = 0;
    const headerTexts = new Set();
    if (hi >= 0) {
      // Headers can sit on two lines ("Transaction" above, "Date" below): merge nearby header lines.
      const H = lines[hi], hh = H.h || 8;
      const hdr = H.cells.map(c => ({ x0: c.x0, x1: c.x1, header: c.str }));
      let last = hi;
      headerTexts.add(H.cells.map(c => c.str).join('|'));
      for (let j = Math.max(0, hi - 2); j <= Math.min(lines.length - 1, hi + 2); j++) {
        const L = lines[j];
        if (j === hi || L.page !== H.page || Math.abs(L.y - H.y) > hh * 1.3) continue;
        if (L.cells.some(c => U.parseDate(c.str) || U.parseNum(c.str))) continue;   // a data line, not a header
        for (const c of L.cells) {
          const col = hdr.find(h => c.x0 < h.x1 && c.x1 > h.x0);
          if (col) {
            col.header = L.y < H.y ? c.str + ' ' + col.header : col.header + ' ' + c.str;
            col.x0 = Math.min(col.x0, c.x0); col.x1 = Math.max(col.x1, c.x1);
          } else hdr.push({ x0: c.x0, x1: c.x1, header: c.str });
        }
        headerTexts.add(L.cells.map(c => c.str).join('|'));
        last = Math.max(last, j);
      }
      cols = spansFrom(hdr);
      startIdx = last + 1;
    } else {
      cols = clusterColumns(lines);
    }
    const rows = [];
    for (let i = startIdx; i < lines.length; i++) {
      const L = lines[i];
      if (headerTexts.has(L.cells.map(c => c.str).join('|'))) continue; // repeated header on later pages
      // Place each piece by where it starts (text) or ends (right-aligned amounts),
      // so text overflowing into the next column stays in its own column.
      const cells = cols.map(() => '');
      const ends = cols.map(() => -Infinity);
      const colAt = x => { const k = cols.findIndex(col => x >= col.l && x < col.r); return k < 0 ? 0 : k; };
      for (const it of L.items) {
        let k = colAt(it.x + 0.5);
        if (it.money) {
          // Amounts may be left- or right-aligned: pick the column they line up with best.
          const k1 = colAt(it.x + it.w - 0.5);
          if (k1 !== k) {
            const fit = c => Math.min(Math.abs(it.x - cols[c].x0), Math.abs(it.x + it.w - cols[c].x1));
            if (fit(k1) < fit(k)) k = k1;
          }
        }
        const str = it.str.trim();
        const tight = it.x - ends[k] < Math.max(it.h, 4) * 0.12;
        cells[k] = !cells[k] ? str : cells[k] + (tight ? '' : ' ') + str;
        ends[k] = it.x + it.w;
      }
      rows.push({ cells, page: L.page, y: L.y, h: L.h });
    }
    return { cols: cols.map(c => ({ header: c.header })), rows, hasHeader: hi >= 0 };
  }

  function sheetToRaw(aoa) {
    const rows = aoa.filter(r => r.some(c => c));
    const hi = rows.findIndex(r => isHeaderCells(r.filter(c => c)));
    const width = Math.max(...rows.map(r => r.length));
    const pad = r => Array.from({ length: width }, (_, i) => r[i] || '');
    const header = hi >= 0 ? pad(rows[hi]) : Array(width).fill('');
    return {
      cols: header.map(h => ({ header: h })),
      rows: rows.slice(hi + 1).map(r => ({ cells: pad(r) })),
      hasHeader: hi >= 0,
    };
  }

  /* ---------- Column roles ---------- */
  function autoRoles(raw) {
    const n = raw.cols.length;
    const roles = Array(n).fill('ignore');
    const seen = new Set();
    raw.cols.forEach((c, i) => {
      const r = roleOf(c.header);
      if (r && !seen.has(r)) { roles[i] = r; seen.add(r); }
      else if (r === 'label' || r === 'ref') roles[i] = 'ref';   // extra description columns ("Details") go into the label
    });
    const sample = raw.rows.slice(0, 400);
    const stats = raw.cols.map((_, i) => {
      let nonEmpty = 0, dates = 0, nums = 0, len = 0;
      for (const r of sample) {
        const v = r.cells[i]; if (!v) continue;
        nonEmpty++; len += v.length;
        if (U.parseDate(v, settings.dateOrder)) dates++;
        else if (U.parseNum(v)) nums++;
      }
      return { nonEmpty, dates, nums, avgLen: nonEmpty ? len / nonEmpty : 0 };
    });
    if (!seen.has('date')) {
      let best = -1, bestScore = 0;
      stats.forEach((s, i) => { if (roles[i] === 'ignore' && s.dates > bestScore) { best = i; bestScore = s.dates; } });
      if (best >= 0) { roles[best] = 'date'; seen.add('date'); }
    }
    const hasAmounts = ['debit', 'credit', 'amount'].some(r => seen.has(r));
    if (!hasAmounts || !seen.has('balance')) {
      const numeric = stats.map((s, i) => ({ i, s }))
        .filter(({ i, s }) => roles[i] === 'ignore' && s.nonEmpty >= 2 && s.nums / s.nonEmpty > 0.7)
        .map(o => o.i);
      if (!seen.has('balance') && numeric.length && (numeric.length > 1 || hasAmounts)) {
        roles[numeric.pop()] = 'balance'; seen.add('balance');
      }
      if (!hasAmounts) {
        if (numeric.length >= 2) { roles[numeric[numeric.length - 2]] = 'debit'; roles[numeric[numeric.length - 1]] = 'credit'; }
        else if (numeric.length === 1) roles[numeric[0]] = 'amount';
      }
    }
    if (!seen.has('label')) {
      let best = -1, bestLen = 0;
      stats.forEach((s, i) => { if (roles[i] === 'ignore' && s.avgLen > bestLen && s.nums < s.nonEmpty / 2) { best = i; bestLen = s.avgLen; } });
      if (best >= 0) roles[best] = 'label';
    }
    return roles;
  }

  /* ---------- Building transactions ---------- */
  function prepContacts() {
    return App.data.contacts
      .map(c => ({ name: c.name, n: U.norm(c.name) }))
      .filter(c => c.n.length >= 3)
      .sort((a, b) => b.n.length - a.n.length);
  }
  function matchPartner(label, prepared) {
    const nl = ' ' + U.norm(label) + ' ';
    for (const p of prepared) if (nl.includes(' ' + p.n + ' ')) return p.name;
    return '';
  }

  function runCheck(list, opening) {
    let ok = 0, bad = 0, prev = opening;
    for (const x of list) {
      if (prev != null && x.balance != null) {
        if (Math.abs(prev + x.amount - x.balance) < TOL()) ok++; else bad++;
      }
      prev = x.balance != null ? x.balance : (prev != null ? prev + x.amount : null);
    }
    return { ok, bad };
  }

  function build() {
    const raw = st.raw, roles = st.roles;
    const at = r => roles.indexOf(r);
    const all = r => roles.map((x, i) => (x === r ? i : -1)).filter(i => i >= 0);
    const di = at('date'), debI = at('debit'), creI = at('credit'), amtI = at('amount'), balI = at('balance'), parI = at('partner');
    const labelIdx = all('label'), refIdx = all('ref');
    const numIdx = [debI, creI, amtI, balI].filter(i => i >= 0);
    const NUMK = [['deb', debI], ['cre', creI], ['amt', amtI], ['bal', balI]];
    DEC = detectDecimals(raw.rows, numIdx);
    const COMPLETE = new RegExp('[.,]\\d{' + DEC + '}\\)?-?\\s*(CR|DR)?\\.?$', 'i');   // amount string that is not cut off
    const joinTxt = (a, b) => (!a ? b : (a.endsWith('-') || b.startsWith('-') ? a + b : a + ' ' + b));
    let opening = null;
    const dateOf = row => U.parseDate(row.cells[di], settings.dateOrder);
    const hasContent = row => row.cells.some(v => v && v.trim());
    // Summary lines ("Total Debit Amount", "إجمالي", …) or non-date text in the Date column are not transaction lines.
    const isSummary = row => {
      const c = row.cells;
      return c.some((v, i) => !labelIdx.includes(i) && TOTAL_RE.test(v || '')) || (!!(c[di] || '').trim() && !dateOf(row));
    };
    const tryOpening = row => {
      if (!groups.length && balI >= 0 && OPENING_RE.test(row.cells.join(' ')) && U.parseNum(row.cells[balI])) {
        opening = U.parseNum(row.cells[balI]).v; return true;
      }
      return false;
    };

    // 1) Group lines into transactions: { date, dateRow, rows (in reading order) }.
    const groups = [];
    if (di >= 0 && raw.rows.some(r => r.y != null)) {
      // PDF: split lines into visual blocks by vertical spacing. A block's lines belong to its date line,
      // including lines printed ABOVE it (descriptions centred on the row). Blocks without a date continue
      // the previous transaction when close enough (text wrapped onto following lines).
      const blocks = [];
      let blk = null, prev = null, intraMax = 0, interMin = Infinity;
      for (const row of raw.rows) {
        if (!hasContent(row)) continue;
        if (tryOpening(row) || isSummary(row)) { blk = null; prev = null; continue; }
        const gap = prev && row.page === prev.page ? row.y - prev.y : Infinity;
        const gapLimit = 1.4 * Math.max(row.h || 8, (prev && prev.h) || 8);
        if (!blk || gap > gapLimit) { blk = []; blocks.push(blk); if (gap < Infinity) interMin = Math.min(interMin, gap); }
        else intraMax = Math.max(intraMax, gap);
        blk.push(row); prev = row;
      }
      // Use blocks only when the layout clearly has them: one date per block and gaps between
      // transactions well above the gaps inside them. Otherwise lines are evenly spaced, and
      // wrapped lines always belong to the transaction above.
      const oneDate = blocks.filter(b => b.filter(r => dateOf(r)).length === 1).length;
      const centred = blocks.length > 1 && oneDate >= 0.8 * blocks.length && interMin >= Math.max(intraMax, 1) * 1.5;
      if (!centred) {
        const flat = blocks.flat();
        blocks.length = 0;
        for (const r of flat) {
          const p = blocks.length ? blocks[blocks.length - 1] : null;
          const last = p && p[p.length - 1];
          if (dateOf(r) || !p || last.page !== r.page || r.y - last.y > (r.h || 10) * 2.6) blocks.push([r]);
          else p.push(r);
        }
      }
      for (const b of blocks) {
        const first = b.findIndex(r => dateOf(r));
        if (first < 0) {
          const g = groups[groups.length - 1];
          if (g && g.page === b[0].page && b[0].y - g.lastY <= (b[0].h || 10) * 2.6) { g.rows.push(...b); g.lastY = b[b.length - 1].y; }
          continue;
        }
        let g = null;
        b.forEach((r, i) => {
          const d = dateOf(r);
          if (d) {
            g = { date: d, dateRow: r, rows: i === first ? b.slice(0, first).concat(r) : [r], page: r.page, lastY: r.y };
            groups.push(g);
          } else if (i > first) { g.rows.push(r); g.lastY = r.y; }
        });
      }
    } else if (di >= 0) {
      // Excel / CSV: one row per transaction, plus following rows that only carry extra text.
      let g = null;
      for (const row of raw.rows) {
        if (!hasContent(row)) continue;
        if (tryOpening(row) || isSummary(row)) { g = null; continue; }
        const d = dateOf(row);
        if (d) { g = { date: d, dateRow: row, rows: [row] }; groups.push(g); }
        else if (g && !numIdx.some(i => row.cells[i] && COMPLETE.test(row.cells[i].trim()))) g.rows.push(row);
        else g = null;
      }
    }

    // 2) Fold each group's lines into one transaction.
    const found = groups.map(g => {
      const f = { date: g.date, label: '', ref: '', partner: '', raw: {} };
      for (const [k, i] of NUMK) f.raw[k] = i >= 0 ? (g.dateRow.cells[i] || '').trim() : '';
      let after = false;
      for (const r of g.rows) {
        const c = r.cells;
        const text = labelIdx.map(i => c[i]).filter(Boolean).join(' ').trim();
        const refTxt = refIdx.map(i => c[i]).filter(Boolean).join(' ').trim();
        if (text) f.label = (f.label + ' ' + text).trim();
        if (refTxt) f.ref = joinTxt(f.ref, refTxt);
        if (parI >= 0 && c[parI]) f.partner = (f.partner + ' ' + c[parI]).trim();
        if (r === g.dateRow) { after = true; continue; }
        // Finish amounts cut across lines (e.g. "7,933,493.0" + "6").
        if (after) for (const [k, i] of NUMK) {
          const v = i >= 0 ? (c[i] || '').trim() : '';
          if (v && f.raw[k] && !COMPLETE.test(f.raw[k]) && /^[\d.,]+\)?-?$/.test(v)) f.raw[k] += v;
        }
      }
      return f;
    });

    // Turn raw strings into signed amounts.
    const txs = [];
    for (const f of found) {
      const deb = U.parseNum(f.raw.deb), cre = U.parseNum(f.raw.cre), amt = U.parseNum(f.raw.amt), bal = U.parseNum(f.raw.bal);
      let amount = null;
      if ((deb && deb.v) || (cre && cre.v)) {
        const d = deb ? Math.abs(deb.v) : 0, cr = cre ? Math.abs(cre.v) : 0;
        amount = settings.debitPositive ? d - cr : cr - d;
      } else if (amt && amt.v) {
        let v = amt.v;
        if (amt.sfx === 'D') v = Math.abs(v) * (settings.debitPositive ? 1 : -1);
        else if (amt.sfx === 'C') v = Math.abs(v) * (settings.debitPositive ? -1 : 1);
        amount = v;
      }
      if (amount == null) {
        if (bal && !txs.length && opening == null) opening = bal.v;
        continue;
      }
      txs.push({ ...f, amount: rnd(amount), balance: bal ? rnd(bal.v) : null });
    }

    // Order: oldest first.
    let reversed = false;
    if (txs.length > 1) {
      const firstD = txs[0].date, lastD = txs[txs.length - 1].date;
      const fwd = runCheck(txs, opening), rev = runCheck([...txs].reverse(), null);
      if (firstD > lastD || (firstD === lastD && rev.ok > fwd.ok)) { txs.reverse(); reversed = true; }
    }

    // Sign check against running balance.
    const hasBalance = txs.some(x => x.balance != null);
    const op = reversed ? null : opening;
    const chk = runCheck(txs, op);
    const flipped = runCheck(txs.map(x => ({ ...x, amount: -x.amount })), op);
    const suggestFlip = hasBalance && chk.bad > 0 && flipped.ok > chk.ok && flipped.bad < chk.bad;

    // Fill missing balances, mark mismatches, match partners.
    const prepared = prepContacts();
    let prev = op, partnersFound = 0;
    st.rows = txs.map((x, i) => {
      let mismatch = false, balance = x.balance;
      if (prev != null && balance != null) mismatch = Math.abs(prev + x.amount - balance) >= TOL();
      if (balance == null && prev != null) balance = rnd(prev + x.amount);
      prev = balance;
      const one = s => (s || '').replace(/\s+/g, ' ').trim();   // single line: no line breaks or long space runs
      const lbl = one(x.label), ref = one(x.ref);
      const label = (lbl + (ref && ref !== lbl && !lbl.includes(ref) ? ' - ' + ref : '')).trim();
      let partner = x.partner || '';
      if (!partner && prepared.length) partner = matchPartner(label, prepared);
      if (partner) partnersFound++;
      return { id: i + 1, date: x.date, label, partner, amount: x.amount, balance, mismatch };
    });
    if (reversed && opening == null && st.rows.length && st.rows[0].balance != null) {
      opening = rnd(st.rows[0].balance - st.rows[0].amount);
    }
    st.info = { opening, reversed, hasBalance, mismatches: st.rows.filter(r => r.mismatch).length, suggestFlip, partnersFound };
  }

  async function onFiles(files) {
    const file = files[0];
    st = { status: 'busy', fileName: file.name, error: '', raw: null, roles: [], rows: [], info: {} };
    App.rerender();
    try {
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        const lines = await pdfLines(await U.readFile(file));
        if (!lines.length) throw new Error(t('no_text'));
        st.raw = linesToRaw(lines);
      } else {
        st.raw = sheetToRaw(await U.readSheet(file));
      }
      st.roles = autoRoles(st.raw);
      build();
      st.status = 'done';
      if (!st.rows.length) st.error = t('no_rows');
    } catch (e) {
      console.error(e);
      st.status = 'done';
      st.error = e.message && (e.message === t('no_text') || e.message === t('pdf_lib_missing')) ? e.message : t('error', { e: e.message || e });
    }
    App.rerender();
  }

  /* ---------- Export ---------- */
  function aoa(forCsv) {
    return [OUT_HEADERS, ...st.rows.map(r => [
      U.fmtDate(r.date, settings.outDate), r.label, r.partner,
      forCsv ? fx(r.amount) : r.amount,
      r.balance == null ? '' : (forCsv ? fx(r.balance) : r.balance),
    ])];
  }
  function fileBase() {
    const first = st.rows[0], last = st.rows[st.rows.length - 1];
    return `${U.safeName(App.company().name)}_bank_statement_${first ? first.date : ''}_${last ? last.date : ''}`;
  }

  /* ---------- Rendering ---------- */
  function renderSettings() {
    const o = (v, cur, label) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    return `
      <div class="row" style="margin-top:14px">
        <label class="field">${t('date_order')}
          <select data-set="dateOrder">${o('DMY', settings.dateOrder, 'DD/MM/YYYY')}${o('MDY', settings.dateOrder, 'MM/DD/YYYY')}</select></label>
        <label class="field">${t('sign_rule')}
          <select data-set="debitPositive">${o('1', settings.debitPositive ? '1' : '0', t('sign_debit_pos'))}${o('0', settings.debitPositive ? '1' : '0', t('sign_credit_pos'))}</select></label>
        <label class="field">${t('out_date')}
          <select data-set="outDate">${['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'].map(f => o(f, settings.outDate, f)).join('')}</select></label>
      </div>`;
  }

  function renderSummary() {
    const rows = st.rows, info = st.info;
    if (!rows.length) return '';
    const pos = rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
    const neg = rows.filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0);
    const mism = rows.filter(r => r.mismatch).length;
    const last = rows[rows.length - 1];
    let check;
    if (!info.hasBalance) check = `<div class="notice warn">${t('check_none')}</div>`;
    else if (!mism) check = `<div class="notice ok">✓ ${t('check_ok')}</div>`;
    else check = `<div class="notice warn">⚠ ${t('check_bad', { n: mism })}</div>`;
    return `
      ${check}
      ${info.suggestFlip ? `<div class="notice warn">${t('check_flip')} <button class="btn sm" id="bkFlip" type="button">${t('flip_now')}</button></div>` : ''}
      ${info.reversed ? `<div class="notice info">${t('reversed_note')}</div>` : ''}
      ${App.data.contacts.length
        ? `<div class="notice info">${t('partners_found', { n: rows.filter(r => r.partner).length, m: rows.length })}</div>`
        : `<div class="notice info">${t('no_contacts_hint')}</div>`}
      <div class="stats">
        <div class="stat"><b>${rows.length}</b><span>${t('rows')}</span></div>
        <div class="stat"><b class="pos">${money(pos)}</b><span>${t('total_pos')}</span></div>
        <div class="stat"><b class="neg">${money(neg)}</b><span>${t('total_neg')}</span></div>
        ${info.opening != null ? `<div class="stat"><b>${money(info.opening)}</b><span>${t('opening')}</span></div>` : ''}
        ${last.balance != null ? `<div class="stat"><b>${money(last.balance)}</b><span>${t('closing')}</span></div>` : ''}
      </div>`;
  }

  function renderTable() {
    return `
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>${t('h_date')}</th><th>${t('h_label')}</th><th>${t('h_partner')}</th>
          <th class="num">${t('h_amount')}</th><th class="num">${t('h_balance')}</th><th></th></tr></thead>
        <tbody>${st.rows.map((r, i) => `
          <tr class="${r.mismatch ? 'mismatch' : ''}" data-i="${i}">
            <td class="muted">${i + 1}</td>
            <td class="date-cell"><input data-f="date" type="date" value="${r.date}"></td>
            <td class="label-cell"><input data-f="label" dir="auto" value="${U.esc(r.label)}"></td>
            <td class="partner-cell"><input data-f="partner" dir="auto" placeholder="—" value="${U.esc(r.partner)}"></td>
            <td class="num"><input data-f="amount" class="num ${r.amount < 0 ? 'neg' : 'pos'}" value="${fx(r.amount)}"></td>
            <td class="num"><input data-f="balance" class="num" value="${r.balance == null ? '' : fx(r.balance)}"></td>
            <td><button class="icon-btn" data-del="${i}" title="${t('remove_row')}" aria-label="${t('remove_row')}" type="button">✕</button></td>
          </tr>`).join('')}</tbody>
      </table></div>`;
  }

  function renderRaw() {
    if (!st.raw) return '';
    const raw = st.raw;
    const sample = raw.rows.slice(0, 40);
    return `
      <details class="card" id="bkRaw">
        <summary>${t('detected_cols')}</summary>
        <p class="muted small">${t('detected_hint')}</p>
        <div class="table-wrap"><table>
          <thead><tr>${raw.cols.map((c, i) => `<th>
            <select data-role="${i}">${ROLES.map(r => `<option value="${r}" ${st.roles[i] === r ? 'selected' : ''}>${t('role_' + r)}</option>`).join('')}</select>
            <div class="muted small" style="font-weight:400">${U.esc(c.header || '')}</div></th>`).join('')}</tr></thead>
          <tbody>${sample.map(r => `<tr>${r.cells.map(c => `<td>${U.esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
      </details>`;
  }

  function render() {
    const busy = st.status === 'busy';
    const has = st.rows.length > 0;
    return `
      <div class="page-head"><h1>${t('bank_title')}</h1><p class="muted">${t('bank_sub')}</p></div>
      <div class="card">
        ${has ? `
          <div class="row">
            <b>${U.esc(st.fileName)}</b><span class="spacer"></span>
            <button class="btn" id="bkXlsx" type="button">${t('download_xlsx')}</button>
            <button class="btn ghost" id="bkCsv" type="button">${t('download_csv')}</button>
            <button class="btn ghost" id="bkCopy" type="button">${t('copy_table')}</button>
            <button class="btn ghost" id="bkNew" type="button">${t('new_file')}</button>
          </div>` : `
          <div class="drop" id="bkDrop" tabindex="0" role="button">
            <b>${t('drop_title')}</b><span class="muted">${t('drop_sub')}</span>
          </div>`}
        <input type="file" id="bkFile" accept=".pdf,.xlsx,.xls,.csv" hidden>
        ${renderSettings()}
      </div>
      ${busy ? `<div class="card"><span class="spinner"></span> ${U.esc(t('reading', { f: st.fileName }))}</div>` : ''}
      ${st.error ? `<div class="notice bad">${U.esc(st.error)}</div>` : ''}
      ${has ? `<div class="card"><div id="bkSummary">${renderSummary()}</div>
        ${renderTable()}
        <div class="row" style="margin-top:10px"><button class="btn ghost sm" id="bkAdd" type="button">+ ${t('add_row')}</button></div>
      </div>` : ''}
      ${renderRaw()}`;
  }

  function refreshSummary(root) {
    const el = root.querySelector('#bkSummary');
    if (el) { el.innerHTML = renderSummary(); wireFlip(root); }
  }
  function wireFlip(root) {
    const flip = root.querySelector('#bkFlip');
    if (flip) flip.addEventListener('click', () => {
      settings.debitPositive = !settings.debitPositive; saveSettings(); build(); App.rerender();
    });
  }

  // Contacts as dropdown items (name + Tax ID / reference), rebuilt only when the contact list changes.
  let ciFor = null, ciList = [];
  function contactItems() {
    if (ciFor !== App.data.contacts) {
      ciFor = App.data.contacts;
      ciList = ciFor.map(c => ({ value: c.name, sub: [c.vat, c.ref].filter(Boolean).join(' · ') }));
    }
    return ciList;
  }

  function recalcMismatch() {
    let prev = st.info.reversed ? null : st.info.opening;
    for (const r of st.rows) {
      r.mismatch = prev != null && r.balance != null && Math.abs(prev + r.amount - r.balance) >= TOL();
      prev = r.balance != null ? r.balance : (prev != null ? prev + r.amount : null);
    }
  }

  function mount(root) {
    const file = root.querySelector('#bkFile');
    const drop = root.querySelector('#bkDrop');
    if (drop) U.dropZone(drop, file, onFiles);
    else file.addEventListener('change', () => { if (file.files.length) onFiles(file.files); file.value = ''; });

    root.querySelectorAll('[data-set]').forEach(s => s.addEventListener('change', () => {
      const k = s.dataset.set;
      settings[k] = k === 'debitPositive' ? s.value === '1' : s.value;
      saveSettings();
      if (st.raw && k !== 'outDate') build();
      App.rerender();
    }));

    const raw = root.querySelector('#bkRaw');
    if (raw) {
      if (!st.rows.length) raw.open = true;
      root.querySelectorAll('[data-role]').forEach(s => s.addEventListener('change', () => {
        st.roles[+s.dataset.role] = s.value;
        build(); st.error = st.rows.length ? '' : t('no_rows');
        App.rerender();
        const d = document.getElementById('bkRaw'); if (d) d.open = true;
      }));
    }
    if (!st.rows.length) return;

    const afterSave = res => {
      if (String(res).startsWith('unavailable')) {
        U.copyDialog({ message: t('save_failed_msg'), text: U.toTSV(aoa(true)), reason: String(res).split(':')[1] });
      }
    };
    root.querySelector('#bkXlsx').addEventListener('click', async () =>
      afterSave(await U.downloadXLSX(fileBase() + '.xlsx', aoa(false), 'Bank Statement', [12, 60, 30, 14, 18])));
    root.querySelector('#bkCsv').addEventListener('click', async () => afterSave(await U.downloadCSV(fileBase() + '.csv', aoa(true))));
    root.querySelector('#bkCopy').addEventListener('click', () => {
      const text = U.toTSV(aoa(true));
      const fail = () => U.copyDialog({ message: t('copy_manual'), text, reason: 'clipboard' });
      try { navigator.clipboard.writeText(text).then(() => U.toast(t('copied_table')), fail); } catch (e) { fail(); }
    });
    root.querySelector('#bkNew').addEventListener('click', () => {
      st = { status: 'idle', fileName: '', error: '', raw: null, roles: [], rows: [], info: {} };
      App.rerender();
    });
    root.querySelector('#bkAdd').addEventListener('click', () => {
      const last = st.rows[st.rows.length - 1];
      st.rows.push({ id: Date.now(), date: last ? last.date : new Date().toISOString().slice(0, 10), label: '', partner: '', amount: 0, balance: last ? last.balance : null, mismatch: false });
      App.rerender();
    });
    wireFlip(root);

    // Partner: searchable list of this company's Contacts; typing a name that is not in the list is allowed.
    const partnerSource = { items: contactItems, empty: () => t('ac_no_contacts') };
    root.querySelectorAll('tbody input[data-f="partner"]').forEach(inp => U.attachAutocomplete(inp, partnerSource));

    root.querySelectorAll('tbody input[data-f]').forEach(inp => inp.addEventListener('change', () => {
      const tr = inp.closest('tr'); const r = st.rows[+tr.dataset.i]; const f = inp.dataset.f;
      if (f === 'amount' || f === 'balance') {
        const p = U.parseNum(inp.value);
        r[f] = p ? rnd(p.v) : (f === 'amount' ? 0 : null);
        if (f === 'amount') inp.className = 'num ' + (r.amount < 0 ? 'neg' : 'pos');
      } else r[f] = inp.value;
      recalcMismatch();
      root.querySelectorAll('tbody tr[data-i]').forEach(row => row.classList.toggle('mismatch', st.rows[+row.dataset.i].mismatch));
      refreshSummary(root);
    }));
    root.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      st.rows.splice(+b.dataset.del, 1); recalcMismatch(); App.rerender();
    }));
  }

  // Exposed for testing.
  return { render, mount, _onFiles: onFiles, _state: () => st };
})();
