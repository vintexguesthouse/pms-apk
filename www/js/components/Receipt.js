/**
 * js/components/Receipt.js
 * ─────────────────────────────────────────────────────
 * Builds a thermal-style (80mm) guest receipt as a real PDF, using
 * jsPDF, then either:
 *   - downloads it as a file (downloadReceiptPdf), or
 *   - sends it to the front-desk printer (printReceiptPhysical).
 *
 * Both paths share the exact same PDF — this matters. An earlier
 * version of printReceiptPhysical rendered HTML into a hidden layer
 * and called window.print(), relying on `@page { size: 80mm auto }`
 * to tell the browser/printer driver what page size to use. That's
 * only ever a *request*: many thermal printer drivers ignore or
 * renegotiate it (especially the continuous "auto" height), and when
 * they do, the browser scales the whole layout down to whatever page
 * it actually picked — producing exactly the "long printout, tiny
 * text" symptom this was rewritten to fix. A PDF's page size is baked
 * into the file itself, so there's nothing left to renegotiate: we
 * build the receipt as a real 80mm-wide PDF and hand the *finished
 * file* to either doc.save() or the print pipeline.
 *
 * Requires jsPDF (UMD) to be loaded globally as window.jspdf.jsPDF —
 * see the <script> tags in index.html.
 *
 * Exports:
 *  - downloadReceiptPdf(rooms)   → builds and downloads a receipt PDF
 *  - printReceiptPhysical(rooms) → builds the same PDF and sends it to
 *                                   the browser's print dialog (for the
 *                                   front-desk thermal printer)
 */

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

/** @param {number|null} n @returns {string} */
function _ksh(n) {
  if (n == null || isNaN(n)) return 'KSH 0';
  return `KSH ${Number(n).toLocaleString('en-KE')}`;
}

/** @returns {string} formatted "DD MMM YYYY  HH:MM" */
function _now() {
  const d = new Date();
  return d.toLocaleString('en-KE', {
    day:    '2-digit',
    month:  'short',
    year:   'numeric',
    hour:   '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** @param {string|null} iso @returns {string} */
function _fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-KE', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

/**
 * Maps a raw payment_method value to its display label. Mirrors the
 * labels used in payments.js / BookingHistory.js so the receipt says
 * the same thing the rest of the app does.
 * @param {string|null} method
 * @returns {string}
 */
function _paymentMethodLabel(method) {
  const labels = { cash: 'Cash', mpesa: 'M-Pesa', bank_transfer: 'Bank Transfer' };
  return labels[method] ?? method ?? '—';
}

/**
 * Maps a raw payment_status value to its display label.
 * @param {string|null} status
 * @returns {string}
 */
function _paymentStatusLabel(status) {
  if (status === 'paid') return 'PAID IN FULL';
  if (status === 'partial') return 'PARTIAL PAYMENT - BALANCE DUE';
  if (status === 'unpaid') return 'UNPAID - PAYMENT DUE';
  return '—';
}

/**
 * Generates a short human-readable receipt number.
 * Format: VGH-YYYYMMDD-XXXX
 */
function _receiptNo() {
  const d    = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `VGH-${date}-${rand}`;
}

/**
 * Calculates departure date based on check-in date and nights.
 * @param {string} iso - ISO date string
 * @param {number} nights
 */
function _calcDeparture(iso, nights) {
  if (!iso) return '—';
  const d = new Date(iso);
  d.setDate(d.getDate() + (parseInt(nights) || 1));
  return d.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─────────────────────────────────────────────────────
// Receipt "ops" builder — a flat list describing every line of the
// receipt (kind + content), independent of any rendering. Built once so
// we can measure its total height before creating the PDF page (so the
// page is exactly as tall as the receipt, like a real thermal print),
// then walked a second time to actually draw it.
// ─────────────────────────────────────────────────────

/** Height in mm each op kind takes up when drawn. */
const _OP_HEIGHT = {
  title: 5.5,
  sub: 3.6,
  divider: 3,
  gap: 2.2,
  label: 4.4,
  row: 4,
  note: 3.2,
  item: 3.6,
  total: 7,
  footer: 4.2,
  'footer-small': 3.6,
};

/**
 * Builds the flat list of receipt ops for one or multiple rooms.
 * @param {Array|Object} rooms
 * @returns {{ ops: Array, receiptNo: string }}
 */
function _buildReceiptOps(rooms) {
  const roomList = Array.isArray(rooms) ? rooms : [rooms];

  // 1. Calculations
  const roomTotals = roomList.map((r) => ({
    name: r.room_name,
    nights: Number(r.selected_nights ?? r.nights ?? 1),
    rate: Number(r.charged_rate ?? r.base_rate),
    base: Number(r.base_rate),
    total: Number(r.charged_rate ?? r.base_rate) * Number(r.selected_nights ?? r.nights ?? 1),
  }));

  const grandRoomTotal = roomTotals.reduce((sum, r) => sum + r.total, 0);
  const shopTotal = roomList.reduce((sum, r) => sum + Number(r.shop_total ?? 0), 0);
  const grandTotal = grandRoomTotal + shopTotal;

  // 1b. Amount already paid and what's still owed right now.
  const first0 = roomList[0];
  const amountPaid = Number(first0.amount_paid ?? first0.activeBooking?.amount_paid ?? 0);
  const balanceDueNow = Math.max(0, grandTotal - amountPaid);

  // 2. Shop items across all rooms
  const allShopItems = roomList.flatMap((r) => r.shop_items ?? []);

  // 3. Metadata (from the first room, since rooms share the booking)
  const first = roomList[0];
  const paymentMethod = first.payment_method ?? first.activeBooking?.payment_method ?? null;
  const paymentStatus = first.payment_status ?? first.activeBooking?.payment_status ?? null;
  const checkInIso = first.check_in ?? first.activeBooking?.check_in ?? null;
  const stayNights = Number(first.selected_nights ?? first.nights ?? first.activeBooking?.nights ?? 1);
  const receiptNo = _receiptNo();

  const ops = [];
  const push = (kind, data = {}) => ops.push({ kind, ...data });

  push('title', { text: 'VINTEX GUEST HOUSE' });
  push('sub', { text: 'Kimana, Kajiado County, Kenya', center: true });
  push('sub', { text: 'Tel: +254 702 863 059', center: true });
  push('divider', { style: 'dashed' });
  push('sub', { text: 'OFFICIAL RECEIPT', bold: true, center: true });
  push('sub', { text: `No: ${receiptNo}`, center: true });
  push('sub', { text: `Printed: ${_now()}`, center: true });
  push('gap');

  push('label', { text: 'GUEST DETAILS' });
  push('row', { label: 'Name', value: first.guest_name ?? '—', bold: true });
  push('row', { label: 'Check-in', value: _fmtDate(checkInIso) });
  push('row', { label: 'Check-out', value: _calcDeparture(checkInIso, stayNights) });
  roomList.forEach((r) => push('row', { label: 'Room', value: r.room_name }));
  push('divider', { style: 'dashed' });

  push('label', { text: 'ROOM CHARGES' });
  roomTotals.forEach((rt) => {
    push('row', { label: `${rt.name} (${rt.nights}n)`, value: _ksh(rt.total) });
    if (rt.rate < rt.base) push('note', { text: `* ${rt.name} reduced from ${_ksh(rt.base)}` });
  });
  push('divider', { style: 'dashed' });

  push('label', { text: 'SHOP / POS' });
  if (allShopItems.length > 0) {
    allShopItems.forEach((si) =>
      push('item', { name: `${si.name} x${si.qty ?? 1}`, value: _ksh((si.unit_price ?? si.price ?? 0) * (si.qty ?? 1)) })
    );
  } else {
    push('item', { name: 'None', value: '—', italic: true });
  }
  push('divider', { style: 'solid' });

  push('row', { label: 'Room subtotal', value: _ksh(grandRoomTotal), bold: true });
  push('row', { label: 'Shop subtotal', value: _ksh(shopTotal), bold: true });
  push('total', { label: 'GRAND TOTAL', value: _ksh(grandTotal) });

  if (amountPaid > 0) push('row', { label: 'Paid already', value: _ksh(amountPaid) });
  push('divider', { style: 'dashed' });
  push('total', { label: 'BALANCE DUE NOW', value: _ksh(balanceDueNow) });
  push('divider', { style: 'dashed' });

  push('row', { label: 'Payment method', value: _paymentMethodLabel(paymentMethod), small: true });
  push('row', { label: 'Status', value: _paymentStatusLabel(paymentStatus), small: true });
  push('gap');

  push('footer', { text: 'Thank you for your stay!' });
  push('footer-small', { text: 'Issued by Vintex Guest House PMS v1.0' });

  return { ops, receiptNo };
}

// ─────────────────────────────────────────────────────
// PDF rendering (shared by both download + physical print)
// ─────────────────────────────────────────────────────

// 80mm is the paper ROLL width, not the printable width. Every 80mm
// thermal print head has a mechanical dead zone on each edge (varies
// by model, but ~4mm/side is near-universal), so the actual printable
// strip is closer to 72mm. Sizing the PDF page to the full 80mm — as
// this used to — draws content that's centered on paper but clipped
// on print, because the printer simply can't mark that far out.
// Every position in this file (dividers, right-aligned values,
// centered titles) is computed relative to _PAGE_WIDTH_MM, so fixing
// this one constant re-centers and re-fits everything automatically.
const _PAGE_WIDTH_MM = 72;
const _MARGIN_MM = 3;
const _MARGIN_TOP_MM = 5;
const _MARGIN_BOTTOM_MM = 6;

/** Draws a dashed or solid horizontal divider line at the given y. */
function _drawDivider(doc, y, style) {
  doc.setLineWidth(0.15);
  doc.setDrawColor(style === 'solid' ? 0 : 130);
  if (style === 'dashed') doc.setLineDashPattern([0.8, 0.8], 0);
  else doc.setLineDashPattern([], 0);
  doc.line(_MARGIN_MM, y, _PAGE_WIDTH_MM - _MARGIN_MM, y);
  doc.setLineDashPattern([], 0);
}

/** Draws a label/value pair, label left-aligned, value right-aligned. */
function _drawRow(doc, y, { label, value, bold, small }) {
  doc.setFont('courier', bold ? 'bold' : 'normal');
  doc.setFontSize(small ? 7 : 8);
  doc.text(label, _MARGIN_MM, y);
  doc.text(String(value), _PAGE_WIDTH_MM - _MARGIN_MM, y, { align: 'right' });
}

/**
 * Builds the receipt PDF (jsPDF document) for one or multiple rooms.
 * This is the single source of truth for receipt layout — both
 * downloadReceiptPdf() and printReceiptPhysical() call this and just
 * do something different with the resulting document.
 * @param {Array|Object} rooms
 * @returns {{ doc: import('jspdf').jsPDF, receiptNo: string }}
 */
function _buildReceiptPdf(rooms) {
  const { jsPDF } = window.jspdf;
  const { ops, receiptNo } = _buildReceiptOps(rooms);

  const totalHeight =
    _MARGIN_TOP_MM + _MARGIN_BOTTOM_MM + ops.reduce((sum, op) => sum + _OP_HEIGHT[op.kind], 0);

  const doc = new jsPDF({ unit: 'mm', format: [_PAGE_WIDTH_MM, totalHeight] });

  let y = _MARGIN_TOP_MM;
  for (const op of ops) {
    y += _OP_HEIGHT[op.kind];
    switch (op.kind) {
      case 'title':
        doc.setFont('courier', 'bold');
        doc.setFontSize(12);
        doc.text(op.text, _PAGE_WIDTH_MM / 2, y - 1.5, { align: 'center' });
        break;
      case 'sub':
        doc.setFont('courier', op.bold ? 'bold' : 'normal');
        doc.setFontSize(8);
        doc.text(op.text, op.center ? _PAGE_WIDTH_MM / 2 : _MARGIN_MM, y - 1, op.center ? { align: 'center' } : {});
        break;
      case 'divider':
        _drawDivider(doc, y - _OP_HEIGHT.divider / 2, op.style);
        break;
      case 'gap':
        break;
      case 'label':
        doc.setFont('courier', 'bold');
        doc.setFontSize(7);
        doc.setTextColor(90);
        doc.text(op.text, _MARGIN_MM, y - 1);
        doc.setTextColor(0);
        break;
      case 'row':
        _drawRow(doc, y - 1, op);
        break;
      case 'note':
        doc.setFont('courier', 'italic');
        doc.setFontSize(6.5);
        doc.setTextColor(90);
        doc.text(op.text, _MARGIN_MM, y - 1);
        doc.setTextColor(0);
        break;
      case 'item':
        doc.setFont('courier', op.italic ? 'italic' : 'normal');
        doc.setFontSize(7.5);
        doc.text(op.name, _MARGIN_MM, y - 1);
        doc.text(op.value, _PAGE_WIDTH_MM - _MARGIN_MM, y - 1, { align: 'right' });
        break;
      case 'total':
        doc.setLineWidth(0.2);
        doc.setDrawColor(0);
        doc.setLineDashPattern([], 0);
        doc.line(_MARGIN_MM, y - _OP_HEIGHT.total + 2, _PAGE_WIDTH_MM - _MARGIN_MM, y - _OP_HEIGHT.total + 2);
        doc.setFont('courier', 'bold');
        doc.setFontSize(10);
        doc.text(op.label, _MARGIN_MM, y - 1.5);
        doc.text(op.value, _PAGE_WIDTH_MM - _MARGIN_MM, y - 1.5, { align: 'right' });
        break;
      case 'footer':
        doc.setFont('courier', 'bold');
        doc.setFontSize(8.5);
        doc.text(op.text, _PAGE_WIDTH_MM / 2, y - 1, { align: 'center' });
        break;
      case 'footer-small':
        doc.setFont('courier', 'normal');
        doc.setFontSize(6.5);
        doc.setTextColor(120);
        doc.text(op.text, _PAGE_WIDTH_MM / 2, y - 1, { align: 'center' });
        doc.setTextColor(0);
        break;
    }
  }

  return { doc, receiptNo };
}

function _jsPdfReady() {
  if (window.jspdf && typeof window.jspdf.jsPDF === 'function') return true;
  console.error('[Receipt] jsPDF failed to load — check your internet connection and try again.');
  return false;
}

// ─────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────

/**
 * Builds a receipt PDF for the given room(s) and downloads it as a
 * file (e.g. to hand a digital copy to a guest, or keep for records).
 * @param {Object|Array} rooms - The room/booking data for the receipt.
 */
export function downloadReceiptPdf(rooms) {
  if (!_jsPdfReady()) return;
  const { doc, receiptNo } = _buildReceiptPdf(rooms);
  doc.save(`receipt_${receiptNo}.pdf`);
}

/**
 * Builds the same receipt PDF and sends it to the browser's print
 * dialog, for the thermal printer connected to the front-desk PC.
 *
 * This loads the actual PDF into a hidden iframe and prints *that*,
 * rather than printing HTML via CSS @page rules. That matters: a PDF's
 * page size is embedded in the file itself, so the printer driver has
 * nothing to renegotiate. Printing HTML instead leaves the page size a
 * mere CSS request, which many thermal printer drivers ignore — the
 * driver picks its own (often much longer, continuous-roll) page and
 * the browser shrinks the whole layout to fit it, producing a long
 * printout with tiny text.
 *
 * @param {Object|Array} rooms - The room/booking data for the receipt.
 */
export function printReceiptPhysical(rooms) {
  if (!_jsPdfReady()) return;

  const { doc } = _buildReceiptPdf(rooms);
  const blobUrl = doc.output('bloburl');

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.src = blobUrl;

  const cleanup = () => {
    iframe.remove();
    URL.revokeObjectURL(blobUrl);
  };

  iframe.onload = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (err) {
      console.error('[Receipt] Failed to open the print dialog for the receipt.', err);
    }
    // There's no reliable 'afterprint' signal from inside a PDF-viewer
    // iframe across browsers, so clean up on a generous delay instead
    // of trying to detect when the dialog closed.
    setTimeout(cleanup, 60000);
  };

  document.body.appendChild(iframe);
}
