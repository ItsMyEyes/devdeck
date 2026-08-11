// Generates a self-contained, printable invoice document and triggers a
// browser download. No PDF dependency: the downloaded .html file opens (and
// prints to PDF via the browser's own "Save as PDF") without any extra libs.

import { fmtDate, fmtRupiah } from '@/lib/format'
import { INVST } from '@/lib/constants'
import { ISSUER } from '@/lib/issuer'
import type { Invoice } from '@/store/types'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildInvoiceHtml(iv: Invoice): string {
  const st = INVST[iv.status]
  const e = escapeHtml
  const itemRows = iv.items
    .map(
      (it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${e(it.description)}</td>
        <td class="amount">${it.quantity}</td>
        <td class="amount">${e(fmtRupiah(it.unitPrice))}</td>
        <td class="amount">${e(fmtRupiah(it.quantity * it.unitPrice))}</td>
      </tr>`,
    )
    .join('')
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>${e(iv.number)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif;
    color: #1a1c20;
    max-width: 720px;
    margin: 48px auto;
    padding: 0 24px;
  }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1a1c20; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .muted { color: #6b7280; font-size: 12.5px; }
  .status { display: inline-block; margin-top: 8px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; color: #fff; background: ${st.color}; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
  .meta-block h2 { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin: 0 0 6px; }
  .meta-block p { margin: 0; font-size: 13.5px; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 28px; }
  th, td { text-align: left; padding: 10px 8px; font-size: 13px; border-bottom: 1px solid #e5e7eb; }
  th { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
  td.amount, th.amount { text-align: right; }
  .total-row td { font-weight: 700; font-size: 15px; border-bottom: none; border-top: 2px solid #1a1c20; }
  .payment { background: #f7f7f8; border-radius: 10px; padding: 14px 16px; font-size: 13px; line-height: 1.7; margin-bottom: 28px; }
  .payment h2 { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin: 0 0 6px; }
  .payment ul { margin: 6px 0 0; padding-left: 18px; }
  .signature { font-size: 13.5px; line-height: 1.6; }
  @media print { body { margin: 0 auto; } }
</style>
</head>
<body>
  <header>
    <div>
      <h1>Invoice ${e(iv.number)}</h1>
      <span class="status">${e(st.label)}</span>
    </div>
    <div class="muted" style="text-align:right">
      Created ${e(fmtDate(iv.createdAt))}<br>
      Due ${e(fmtDate(iv.dueDate))}
    </div>
  </header>

  <div class="meta-grid">
    <div class="meta-block">
      <h2>From</h2>
      <p>
        ${e(ISSUER.name)}<br>
        ${e(ISSUER.title)}<br>
        ${e(ISSUER.location)}<br>
        Email: ${e(ISSUER.email)}<br>
        No. HP: ${e(ISSUER.phone)}
      </p>
    </div>
    <div class="meta-block">
      <h2>Bill To</h2>
      <p>
        ${e(iv.companyName || '—')}<br>
        ${e(iv.companyAddress || '')}
      </p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>No.</th>
        <th>Deskripsi Pekerjaan (Jasa Engineer)</th>
        <th class="amount">Kuantitas</th>
        <th class="amount">Harga Satuan (Rp)</th>
        <th class="amount">Total (Rp)</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
      <tr class="total-row">
        <td colspan="4">Total</td>
        <td class="amount">${e(fmtRupiah(iv.amount))}</td>
      </tr>
    </tbody>
  </table>

  <div class="payment">
    <h2>Metode Pembayaran</h2>
    Mohon agar pembayaran dapat dilakukan melalui transfer bank ke rekening berikut:
    <ul>
      <li>Nama Bank: ${e(iv.bankDetail.bankName || '—')}</li>
      <li>Nomor Rekening: ${e(iv.bankDetail.accountNumber || '—')}</li>
      <li>Atas Nama: ${e(iv.bankDetail.accountName || '—')}</li>
    </ul>
  </div>

  <div class="signature">
    Hormat saya,<br><br>
    ${e(ISSUER.name)}
  </div>
</body>
</html>`
}

/** Builds a printable invoice document and downloads it as an .html file. */
export function downloadInvoice(iv: Invoice): void {
  const blob = new Blob([buildInvoiceHtml(iv)], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${iv.number || 'invoice'}.html`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
