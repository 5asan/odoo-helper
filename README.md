# Odoo Helper

Browser tools for Odoo 19 Accounting. Everything runs locally in the browser; files are never uploaded.

## Run it
Double-click `index.html` (Chrome or Edge). It needs internet the first time to load the PDF and Excel libraries from a CDN.

## Features
| Feature | Status |
|---|---|
| Bank statement (PDF/Excel/CSV) → Odoo file: Date, Label, Partner, Amount, Cumulative balance | Ready |
| Master data per company: Chart of Accounts, Contacts, Analytic Accounts | Ready |
| Multi-company + backup/share file | Ready |
| English / Arabic (RTL) | Ready |
| GL analysis (same label/ref on different accounts, duplicates) | Next |
| Outstanding payments/receipts reconciliation | Next |
| Vendor bills from PDFs/photos (OCR) | Later |

## Files
- `index.html` – page shell
- `css/app.css` – styles (light/dark, RTL)
- `js/i18n.js` – English/Arabic text
- `js/store.js` – browser storage (IndexedDB)
- `js/util.js` – number/date parsing, Excel/CSV read & write
- `js/masterdata.js` – Chart of Accounts / Contacts / Analytics import
- `js/bank.js` – bank statement converter
- `js/app.js` – navigation, companies, backup

## Notes
- Data is saved in the browser you use. To move it to another computer or teammate, use **Companies → Download backup** and **Import backup**.
- Scanned (image) PDF statements are not supported yet; they need OCR, which comes with the Vendor Bills feature.
