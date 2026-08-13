/**
 * js/components/BookingHistory.js
 * ─────────────────────────────────────────────────────
 * Renders the owner-only Booking History view: a searchable,
 * month-grouped, card-based list of past bookings (is_active: false),
 * with running totals — mobile-first, matching the visual language of
 * RoomCard.js / ReservationsTab.js.
 *
 * BREAKING CHANGE from the previous table-based version:
 * #history-container is now a plain <div>, NOT a <tbody>. This
 * component owns its entire subtree — search input, totals bar, month
 * headers, and booking cards are all rendered here, same
 * self-contained pattern ReservationsTab.js already uses for
 * #reservations-container. index.html should contain nothing but:
 *
 *   <div id="history-container"></div>
 *
 * Delete the old <table>/<thead>, and the standalone
 * #history-search-input / #history-total-badge / #history-empty-state
 * elements if they still live in index.html directly — this component
 * recreates all of them internally now.
 *
 * The search input is built once and never torn down on keystroke
 * (only the list below it re-renders) — same reasoning as the
 * ReservationModal.js fix: rebuilding an <input> on every 'input'
 * event drops focus/cursor position.
 *
 * Exports:
 * - renderBookingHistory(bookings, { onDelete }) → renders into
 *   #history-container and wires up search + delete.
 */

// ─────────────────────────────────────────────────────
// Module-level state (same pattern as ReservationsTab.js's _lastArgs)
// ─────────────────────────────────────────────────────

let _lastBookings = [];
let _onDelete = null;
let _onLogPastStay = null;
let _searchQuery = "";
let _dateFrom = "";
let _dateTo = "";
let _pendingDeleteIds = new Set();

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function _ksh(n) {
  if (n == null || isNaN(n)) return "—";
  return `KSH ${Number(n).toLocaleString("en-KE")}`;
}

function _fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-KE", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

/** Computes a display-formatted checkout date from check_in + nights. */
function _calcCheckOutLabel(iso, nights) {
  if (!iso) return "—";
  const d = new Date(iso);
  d.setDate(d.getDate() + (parseInt(nights, 10) || 1));
  return _fmtDate(d.toISOString());
}

function _monthKey(iso) {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function _monthLabel(key) {
  if (key === "unknown") return "Undated";
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-KE", { month: "long", year: "numeric" });
}

function _paymentStatusBadge(status) {
  const map = {
    paid:    { label: "Paid",    cls: "bg-emerald-900/50 text-emerald-300 border-emerald-700/40" },
    partial: { label: "Partial", cls: "bg-amber-900/50 text-amber-300 border-amber-700/40" },
    unpaid:  { label: "Unpaid",  cls: "bg-red-900/50 text-red-300 border-red-700/40" }
  };
  const entry = map[status] ?? { label: status ?? "—", cls: "bg-gray-800 text-gray-400 border-gray-700" };
  return `<span class="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${entry.cls}">${entry.label}</span>`;
}

function _escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

/**
 * Normalizes a raw booking record (from fetchBookings) into the shape
 * the cards need, tolerating slightly different field names that may
 * show up depending on how the booking was closed out.
 */
function _normalizeBooking(b) {
  const roomTotal = Number(b.charged_rate ?? 0) * Number(b.nights ?? 1);
  const shopTotal = Number(b.shop_charge ?? 0);
  const amountPaid = b.grand_total != null ? Number(b.grand_total) : roomTotal + shopTotal;

  return {
    id: b.airtable_id ?? b.id,
    check_in: b.check_in ?? null,
    nights: Number(b.nights ?? 1),
    sort_date: b.check_out ?? b.checked_out_at ?? b.updated_at ?? b.check_in ?? b.created_at ?? null,
    guest_name: b.guest_name ?? "—",
    room_name: b.room_name ?? "—",
    amount_paid: amountPaid,
    payment_status: b.payment_status ?? null,
    attendant: b.created_by ?? b.attendant ?? "—"
  };
}

function _matchesSearch(row, query) {
  if (!query) return true;
  return row.guest_name.toLowerCase().includes(query) || row.room_name.toLowerCase().includes(query);
}

/**
 * Checks a row's check_in date against the active from/to filter
 * (both optional, inclusive, "YYYY-MM-DD" strings from <input type="date">).
 */
function _matchesDateRange(row, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return true;
  if (!row.check_in) return false;

  const rowDate = row.check_in.slice(0, 10); // normalize to YYYY-MM-DD
  if (dateFrom && rowDate < dateFrom) return false;
  if (dateTo && rowDate > dateTo) return false;
  return true;
}

/** Combines the text search and date-range filters. */
function _matchesFilters(row, query, dateFrom, dateTo) {
  return _matchesSearch(row, query) && _matchesDateRange(row, dateFrom, dateTo);
}

/** Groups rows by month (based on sort_date), most recent month first. */
function _groupByMonth(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = _monthKey(row.sort_date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return b.localeCompare(a);
  });
  return sortedKeys.map((key) => [key, groups.get(key)]);
}

// ─────────────────────────────────────────────────────
// PDF export — built directly with jsPDF + autoTable (no browser print
// dialog involved). See the note in Receipt.js for why: window.print()
// is unreliable on mobile for dynamically-injected content, producing
// blank output. jsPDF builds real PDF bytes in JS and downloads them
// directly, which works the same on mobile as on desktop.
// ─────────────────────────────────────────────────────

function _reportNow() {
  return new Date().toLocaleString("en-KE", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
  });
}

/** Human-readable summary of the active filters, or null if none are set. */
function _describeFilters(query, dateFrom, dateTo) {
  const parts = [];
  if (query) parts.push(`matching "${query}"`);
  if (dateFrom && dateTo) parts.push(`${_fmtDate(dateFrom)} → ${_fmtDate(dateTo)}`);
  else if (dateFrom) parts.push(`from ${_fmtDate(dateFrom)}`);
  else if (dateTo) parts.push(`through ${_fmtDate(dateTo)}`);
  return parts.length ? parts.join(", ") : null;
}

/** Plain-text (non-HTML) version of the payment status label, for the PDF table. */
function _paymentStatusText(status) {
  const map = { paid: "Paid", partial: "Partial", unpaid: "Unpaid" };
  return map[status] ?? status ?? "—";
}

const _PDF_MARGIN_MM = 14;
const _PDF_PAGE_WIDTH_MM = 210; // A4 portrait

/** Builds the A4 booking-history PDF for the given (already-filtered) rows. */
function _buildHistoryPdf(rows, { query, dateFrom, dateTo }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const rightEdge = _PDF_PAGE_WIDTH_MM - _PDF_MARGIN_MM;

  let y = 18;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text("Vintex Guest House", _PDF_MARGIN_MM, y);
  y += 6;
  doc.setFontSize(11);
  doc.text("Booking History Report", _PDF_MARGIN_MM, y);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(100);
  doc.text("Kimana, Kajiado County, Kenya · Tel: +254 700 000 000", _PDF_MARGIN_MM, y + 5.5);

  const filterDesc = _describeFilters(query, dateFrom, dateTo);
  doc.text(`Generated ${_reportNow()}`, rightEdge, y - 6, { align: "right" });
  doc.text(filterDesc ? `Filtered: ${filterDesc}` : "All booking history", rightEdge, y - 1, { align: "right" });
  doc.setTextColor(0);

  const body = rows.map((r) => [
    r.guest_name,
    r.room_name,
    _fmtDate(r.check_in),
    _calcCheckOutLabel(r.check_in, r.nights),
    String(r.nights),
    _ksh(r.amount_paid),
    _paymentStatusText(r.payment_status),
    r.attendant,
  ]);

  doc.autoTable({
    startY: y + 10,
    margin: { left: _PDF_MARGIN_MM, right: _PDF_MARGIN_MM },
    head: [["Guest", "Room", "Check-in", "Check-out", "Nights", "Amount", "Status", "Attendant"]],
    body,
    styles: { font: "helvetica", fontSize: 8.5, cellPadding: 2, overflow: "linebreak" },
    headStyles: { fillColor: [26, 62, 50], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [247, 247, 247] },
    columnStyles: {
      4: { halign: "right" },
      5: { halign: "right" },
    },
  });

  const finalY = (doc.lastAutoTable && doc.lastAutoTable.finalY) || (doc.previousAutoTable && doc.previousAutoTable.finalY) || y + 20;
  const total = rows.reduce((sum, r) => sum + (Number(r.amount_paid) || 0), 0);
  const pageHeight = doc.internal.pageSize.getHeight();

  let summaryY = finalY + 9;
  if (summaryY > pageHeight - 20) {
    doc.addPage();
    summaryY = 20;
  }

  doc.setDrawColor(0);
  doc.setLineWidth(0.3);
  doc.line(rightEdge - 70, summaryY - 5, rightEdge, summaryY - 5);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text("Bookings", rightEdge - 70, summaryY);
  doc.text("Total revenue", rightEdge - 70, summaryY + 6);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(0);
  doc.text(String(rows.length), rightEdge, summaryY, { align: "right" });
  doc.text(_ksh(total), rightEdge, summaryY + 6, { align: "right" });

  return doc;
}

/** Builds a filename like booking-history_jane_2026-01-01_2026-07-30.pdf. */
function _buildExportFilename() {
  const parts = ["booking-history"];
  if (_searchQuery.trim()) parts.push(_searchQuery.trim().toLowerCase().replace(/\s+/g, "-"));
  if (_dateFrom) parts.push(_dateFrom);
  if (_dateTo) parts.push(_dateTo);
  if (!_dateFrom && !_dateTo) parts.push(new Date().toISOString().slice(0, 10));
  return `${parts.join("_")}.pdf`;
}

/** Briefly relabels the download button when there's nothing to export. */
function _flashDownloadBtnEmpty(btn) {
  const label = btn.querySelector("span");
  if (!label) return;
  const original = label.textContent;
  label.textContent = "Nothing to export";
  btn.classList.add("border-amber-700", "text-amber-400");
  setTimeout(() => {
    label.textContent = original;
    btn.classList.remove("border-amber-700", "text-amber-400");
  }, 1800);
}

/**
 * Builds a PDF from the currently-filtered (search + date range) rows
 * and downloads it. Returns false (without doing anything) if there's
 * nothing to export, or if jsPDF failed to load.
 */
function _exportVisibleRows() {
  const query = _searchQuery.trim().toLowerCase();
  const visibleRows = _lastBookings.filter((r) => _matchesFilters(r, query, _dateFrom, _dateTo));
  if (visibleRows.length === 0) return false;

  if (!window.jspdf || typeof window.jspdf.jsPDF !== "function") {
    console.error("[BookingHistory] jsPDF failed to load — check your internet connection and try again.");
    return false;
  }

  const doc = _buildHistoryPdf(visibleRows, { query, dateFrom: _dateFrom, dateTo: _dateTo });
  doc.save(_buildExportFilename());
  return true;
}

// ─────────────────────────────────────────────────────
// HTML builders
// ─────────────────────────────────────────────────────

function _buildCard(row) {
  const isPending = _pendingDeleteIds.has(String(row.id));
  return `
    <div class="bh-card bg-gray-900/60 border border-gray-800 rounded-xl px-4 py-3.5
                hover:border-gray-700 transition-colors"
         data-booking-id="${row.id}">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-semibold text-white truncate">${_escapeHtml(row.guest_name)}</p>
          <p class="text-xs text-gray-500 mt-0.5">
            <span class="font-mono">${_escapeHtml(row.room_name)}</span>
            <span class="text-gray-700 mx-1">·</span>
            ${_fmtDate(row.check_in)} → ${_calcCheckOutLabel(row.check_in, row.nights)}
          </p>
        </div>
        <div class="text-right shrink-0">
          <p class="text-sm font-mono font-semibold text-emerald-400">${_ksh(row.amount_paid)}</p>
          <div class="mt-1">${_paymentStatusBadge(row.payment_status)}</div>
        </div>
      </div>
      <div class="flex items-center justify-between mt-2.5 pt-2.5 border-t border-gray-800/70">
        <p class="text-[11px] text-gray-600">Attended by <span class="text-gray-500">${_escapeHtml(row.attendant)}</span></p>
        <button type="button" data-action="delete-booking" data-booking-id="${row.id}"
          class="bh-delete-btn text-[10px] px-2 py-1 rounded-md border transition-colors font-medium
                 ${isPending
                   ? "bg-red-700 border-red-500 text-white"
                   : "bg-gray-800 hover:bg-red-900/40 text-gray-500 hover:text-red-400 border-gray-700 hover:border-red-700"}">
          ${isPending ? "Confirm?" : "Delete"}
        </button>
      </div>
    </div>
  `;
}

function _buildMonthGroup(monthKey, rows) {
  const total = rows.reduce((sum, r) => sum + (Number(r.amount_paid) || 0), 0);
  return `
    <div class="bh-month-group" data-month="${monthKey}">
      <div class="flex items-center justify-between gap-3 sticky top-0 z-10
                  bg-gray-950/95 backdrop-blur-sm py-2 mb-2 border-b border-gray-800">
        <h3 class="text-xs font-semibold uppercase tracking-wider text-gray-400">${_monthLabel(monthKey)}</h3>
        <div class="flex items-center gap-2 text-[11px] font-mono text-gray-500">
          <span>${rows.length} booking${rows.length === 1 ? "" : "s"}</span>
          <span class="text-gray-700">·</span>
          <span class="text-emerald-400/80">${_ksh(total)}</span>
        </div>
      </div>
      <div class="space-y-2 mb-5">
        ${rows.map(_buildCard).join("")}
      </div>
    </div>
  `;
}

/** Builds the search input + stat boxes shell. Rendered exactly once. */
function _buildShell() {
  return `
    <div class="mb-4 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold text-gray-300">Booking History</h2>
        <button type="button" id="history-log-past-stay-btn"
          class="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-800 bg-gray-900
                 hover:bg-gray-800 hover:border-brand-500 text-xs font-medium text-gray-300 hover:text-white transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
          </svg>
          <span>Log a Past Stay</span>
        </button>
      </div>
      <div class="relative">
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <input id="history-search-input" type="text" placeholder="Search by guest or room…"
          class="w-full bg-gray-900 border border-gray-800 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white
                 placeholder-gray-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors" />
      </div>
      <div class="flex items-center gap-2">
        <input id="history-date-from" type="date"
          class="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-2 text-xs text-gray-300
                 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors" />
        <span class="text-xs text-gray-600 shrink-0">to</span>
        <input id="history-date-to" type="date"
          class="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-2 text-xs text-gray-300
                 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors" />
        <button type="button" id="history-download-btn" title="Download filtered results as PDF"
          class="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-800 bg-gray-900
                 hover:bg-gray-800 hover:border-gray-700 text-xs font-medium text-gray-300 transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"/>
          </svg>
          <span class="hidden sm:inline">Download</span>
        </button>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div class="bg-gray-900/60 border border-gray-800 rounded-lg px-3 py-2.5">
          <p class="text-[10px] uppercase tracking-wider text-gray-600 font-semibold">Bookings</p>
          <p id="history-total-badge" class="text-lg font-mono font-semibold text-white mt-0.5">—</p>
        </div>
        <div class="bg-gray-900/60 border border-gray-800 rounded-lg px-3 py-2.5">
          <p class="text-[10px] uppercase tracking-wider text-gray-600 font-semibold">Total revenue</p>
          <p id="history-grand-total" class="text-lg font-mono font-semibold text-emerald-400 mt-0.5">—</p>
        </div>
      </div>
    </div>
    <div id="history-list-root"></div>
  `;
}

// ─────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────

/**
 * Re-renders only the list + stat numbers, never the search <input>
 * itself, so typing doesn't lose focus/cursor position.
 */
function _renderList() {
  const listRoot = document.getElementById("history-list-root");
  const countEl = document.getElementById("history-total-badge");
  const totalEl = document.getElementById("history-grand-total");
  if (!listRoot) return;

  const query = _searchQuery.trim().toLowerCase();
  const visibleRows = _lastBookings.filter((r) => _matchesFilters(r, query, _dateFrom, _dateTo));
  const visibleTotal = visibleRows.reduce((sum, r) => sum + (Number(r.amount_paid) || 0), 0);
  const isFiltered = Boolean(query || _dateFrom || _dateTo);

  if (countEl) countEl.textContent = isFiltered ? `${visibleRows.length} of ${_lastBookings.length}` : `${_lastBookings.length}`;
  if (totalEl) totalEl.textContent = _ksh(visibleTotal);

  if (_lastBookings.length === 0) {
    listRoot.innerHTML = `
      <div class="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <svg class="w-10 h-10 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
        <p class="text-sm text-gray-500">No booking history yet.</p>
      </div>
    `;
    return;
  }

  if (visibleRows.length === 0) {
    const msg = query
      ? `No bookings match "${_escapeHtml(_searchQuery)}".`
      : "No bookings in the selected date range.";
    listRoot.innerHTML = `<p class="text-sm text-gray-600 italic text-center py-10">${msg}</p>`;
    return;
  }

  const groups = _groupByMonth(visibleRows);
  listRoot.innerHTML = groups.map(([key, rows]) => _buildMonthGroup(key, rows)).join("");
}

function _render() {
  const container = document.getElementById("history-container");
  if (!container) return;

  // Build the shell (search input + stat boxes) exactly once. Rebuilding
  // it on every render would destroy and recreate the <input>, dropping
  // focus/cursor position mid-keystroke.
  if (!container.dataset.shellBuilt) {
    container.innerHTML = _buildShell();
    container.dataset.shellBuilt = "true";

    const input = container.querySelector("#history-search-input");
    input.addEventListener("input", (e) => {
      _searchQuery = e.target.value;
      _renderList();
    });

    const dateFromInput = container.querySelector("#history-date-from");
    const dateToInput = container.querySelector("#history-date-to");
    dateFromInput.addEventListener("change", (e) => {
      _dateFrom = e.target.value;
      _renderList();
    });
    dateToInput.addEventListener("change", (e) => {
      _dateTo = e.target.value;
      _renderList();
    });

    const downloadBtn = container.querySelector("#history-download-btn");
    downloadBtn.addEventListener("click", () => {
      const exported = _exportVisibleRows();
      if (!exported) _flashDownloadBtnEmpty(downloadBtn);
    });

    const logPastStayBtn = container.querySelector("#history-log-past-stay-btn");
    logPastStayBtn?.addEventListener("click", () => _onLogPastStay?.());
  }

  _renderList();
}

// ─────────────────────────────────────────────────────
// Delete wiring (event delegation on the container, wired once — it
// survives #history-list-root's innerHTML swaps since the listener
// lives on the stable parent, not the rows themselves)
// ─────────────────────────────────────────────────────

function _wireDeleteDelegation(container) {
  if (container.dataset.deleteWired) return;
  container.dataset.deleteWired = "true";

  container.addEventListener("click", async (e) => {
    const btn = e.target.closest('[data-action="delete-booking"]');
    if (!btn || typeof _onDelete !== "function") return;

    const id = String(btn.dataset.bookingId);
    const row = _lastBookings.find((r) => String(r.id) === id);
    if (!row) return;

    if (!_pendingDeleteIds.has(id)) {
      _pendingDeleteIds.add(id);
      setTimeout(() => {
        if (_pendingDeleteIds.has(id)) {
          _pendingDeleteIds.delete(id);
          _renderList();
        }
      }, 3000);
      _renderList();
      return;
    }

    _pendingDeleteIds.delete(id);
    btn.disabled = true;
    btn.textContent = "…";

    const success = await _onDelete(row);
    if (!success) {
      _renderList();
      return;
    }

    _lastBookings = _lastBookings.filter((r) => String(r.id) !== id);
    _renderList();
  });
}

// ─────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────

/**
 * Renders the booking history view (past bookings only) into
 * #history-container — search bar, totals, month-grouped cards, all
 * owned by this component.
 *
 * @param {Array<Object>} bookings - Raw bookings from fetchBookings().
 *   Only records with is_active === false are shown.
 * @param {{
 *   onDelete?: (row: Object) => Promise<boolean>,
 *   onLogPastStay?: () => void
 * }} [callbacks]
 *   onDelete is called with the normalized row ({ id, guest_name,
 *   room_name, ... }) after the second confirm tap, and should resolve
 *   true on success (removes the card from the list) or false on
 *   failure (reverts the button so the user can retry).
 *   onLogPastStay is called when the "+ Log a Past Stay" button is
 *   clicked — this component never opens PastStayModal itself, it just
 *   asks the caller to (same callback-injection pattern as every other
 *   modal trigger in this app).
 */
export function renderBookingHistory(bookings, { onDelete, onLogPastStay } = {}) {
  const container = document.getElementById("history-container");
  if (!container) {
    console.error("[BookingHistory] #history-container not found in DOM.");
    return;
  }

  _onDelete = onDelete ?? null;
  _onLogPastStay = onLogPastStay ?? null;
  _lastBookings = (Array.isArray(bookings) ? bookings : [])
    .filter((b) => !b.is_active)
    .map(_normalizeBooking)
    .sort((a, b) => new Date(b.sort_date ?? 0) - new Date(a.sort_date ?? 0));

  _render();
  _wireDeleteDelegation(container);
}
