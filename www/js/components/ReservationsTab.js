/**
 * js/components/ReservationsTab.js
 * ─────────────────────────────────────────────────────
 * Renders the "Reservations" view — one card per reservation
 * submitted through the public website, each listing its
 * reservation_line_items (one row per room category requested).
 *
 * A pending line item gets an "Assign room" button that opens a small
 * inline picker, scoped to available rooms whose category_id matches
 * that line item's category_id. Confirming a pick hands the
 * (reservation, lineItem, room) triple back to the caller via
 * `onAssignRoom` — this component never imports state.js or api.js
 * directly, same ignorant-of-state pattern CheckInModal.js/
 * CheckOutModal.js already use with their getAvailableRooms /
 * getRelatedRooms callbacks.
 *
 * A reservation whose line items are ALL checked_in renders inside a
 * closed <details> (muted, collapsed) instead of being removed from
 * the DOM — it stays there to be found (native browser find expands
 * closed <details> automatically), same spirit as Booking History
 * keeping closed-out bookings visible/searchable.
 *
 * Exports:
 * - renderReservationsTab(reservations, lineItems, callbacks)
 */

// ─────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────
//
// Only one Reservations view is ever mounted at a time, so — same
// reasoning as CheckInModal.js's module-level _activeGroup — it's
// safe to keep the inline-picker's open/selected state here rather
// than threading it through every render call.

let _lastArgs = null; // { reservations, lineItems, callbacks } from the last render
let _openPickerLineItemId = null; // line_item_id currently showing its picker, or null
let _assigningLineItemId = null; // line_item_id mid-flight (button shows "Assigning…")

// Two-tap cancel confirm, same pattern as BookingHistory.js's delete
// button — a Cancel click flips the button to "Confirm?" for ~3s
// rather than a window.confirm() popup. Keys are "li:<id>" or
// "res:<id>" so both levels can share one Set.
let _pendingCancelKeys = new Set();

function _armPendingCancel(key) {
  _pendingCancelKeys.add(key);
  _render();
  setTimeout(() => {
    if (_pendingCancelKeys.has(key)) {
      _pendingCancelKeys.delete(key);
      _render();
    }
  }, 3000);
}

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function _fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-KE", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function _ksh(n) {
  if (n == null || isNaN(n)) return "—";
  return `KSH ${Number(n).toLocaleString("en-KE")}`;
}

function _statusBadge(status) {
  const map = {
    pending: { label: "Pending", cls: "bg-amber-900/50 text-amber-300 border-amber-700/40" },
    confirmed: { label: "Confirmed", cls: "bg-blue-900/50 text-blue-300 border-blue-700/40" },
    checked_in: { label: "Checked In", cls: "bg-emerald-900/50 text-emerald-300 border-emerald-700/40" },
    cancelled: { label: "Cancelled", cls: "bg-gray-800 text-gray-500 border-gray-700" }
  };
  const entry = map[status] ?? { label: status ?? "—", cls: "bg-gray-800 text-gray-400 border-gray-700" };
  return `<span class="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${entry.cls}">${entry.label}</span>`;
}

/** Groups line items by the reservation they belong to (Airtable link field → array of ids). */
function _lineItemsForReservation(reservation, lineItems) {
  return lineItems.filter((li) => (li.reservation_id ?? []).includes(reservation.airtable_id));
}

// ─────────────────────────────────────────────────────
// HTML builders
// ─────────────────────────────────────────────────────

function _buildLineItemRow(reservation, lineItem, getAvailableRoomsForCategory) {
  const isPending = lineItem.status === "pending";
  const isConfirmedLi = lineItem.status === "confirmed";
  const isCheckedIn = lineItem.status === "checked_in";
  const isCancelled = lineItem.status === "cancelled";
  const canAssign = isPending || isConfirmedLi; // a confirmed request still needs a physical room
  const isPickerOpen = _openPickerLineItemId === lineItem.line_item_id;
  const isAssigning = _assigningLineItemId === lineItem.line_item_id;
  const cancelKey = `li:${lineItem.line_item_id}`;
  const isCancelPending = _pendingCancelKeys.has(cancelKey);

  const rightHtml = isCheckedIn
    ? `<span class="text-xs font-mono text-emerald-400">${lineItem.assigned_room_name ?? "—"}</span>`
    : isCancelled
      ? `<span class="text-xs text-gray-600 italic">Cancelled</span>`
      : `
        <div class="flex items-center gap-1.5">
          ${isConfirmedLi ? `<span class="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full border bg-blue-900/40 text-blue-300 border-blue-700/40">Confirmed</span>` : ""}
          <button type="button" data-action="toggle-picker" data-line-item-id="${lineItem.line_item_id}"
            ${isAssigning ? "disabled" : ""}
            class="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-brand-700 border border-gray-700
                   hover:border-brand-500 text-gray-300 hover:text-white transition-colors disabled:opacity-50">
            ${isAssigning ? "Assigning…" : "Assign room"}
          </button>
          <button type="button" data-action="cancel-line-item" data-line-item-id="${lineItem.line_item_id}"
            class="text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition-colors
                   ${
                     isCancelPending
                       ? "bg-red-700 border-red-500 text-white"
                       : "bg-gray-800 hover:bg-red-900/40 border-gray-700 hover:border-red-700 text-gray-500 hover:text-red-400"
                   }">
            ${isCancelPending ? "Confirm?" : "Cancel"}
          </button>
        </div>
      `;

  const excludeNames = []; // rooms currently on-screen are already status-filtered to 'available'
  const candidates = isPickerOpen ? getAvailableRoomsForCategory?.(lineItem.category_id, excludeNames) ?? [] : [];

  const pickerHtml =
    canAssign && isPickerOpen
      ? `
      <div class="mt-2 flex items-center gap-2" data-picker-for="${lineItem.line_item_id}">
        ${
          candidates.length === 0
            ? `<p class="text-xs text-gray-600 italic">No available ${lineItem.category_name ?? "matching"} rooms right now.</p>`
            : `
              <select data-role="room-select" data-line-item-id="${lineItem.line_item_id}"
                class="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white
                       focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors">
                ${candidates.map((r) => `<option value="${r.room_name}">${r.room_name} — ${_ksh(r.base_rate)}</option>`).join("")}
              </select>
              <button type="button" data-action="confirm-assign" data-line-item-id="${lineItem.line_item_id}"
                class="px-3 py-2 rounded-lg text-xs font-semibold text-white bg-brand-700 hover:bg-brand-600
                       border border-brand-600 transition-colors whitespace-nowrap">
                Confirm
              </button>
            `
        }
        <button type="button" data-action="toggle-picker" data-line-item-id="${lineItem.line_item_id}"
          title="Cancel"
          class="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-500 hover:text-white transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
    `
      : "";

  return `
    <div class="py-2.5 border-t border-gray-800/70 first:border-t-0">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm text-white truncate">
            ${lineItem.category_name ?? lineItem.category_id ?? "Room"}
            ${Number(lineItem.quantity ?? 1) > 1 ? `<span class="text-gray-500 font-mono text-xs">× ${lineItem.quantity}</span>` : ""}
          </p>
          <p class="text-xs text-gray-600 font-mono">${_ksh(lineItem.price_per_night_at_booking)} / night at booking</p>
        </div>
        <div class="shrink-0">${rightHtml}</div>
      </div>
      ${pickerHtml}
    </div>
  `;
}

function _buildReservationCard(reservation, lineItems, callbacks) {
  const items = _lineItemsForReservation(reservation, lineItems);
  const allDone = items.length > 0 && items.every((li) => li.status === "checked_in" || li.status === "cancelled");

  const contactBits = [reservation.guest_phone, reservation.guest_email].filter(Boolean).join(" · ");

  const cancelResKey = `res:${reservation.airtable_id}`;
  const isCancelResPending = _pendingCancelKeys.has(cancelResKey);
  // Once a reservation is checked_in or already cancelled there's
  // nothing left to confirm/cancel at this level — the individual line
  // items (or the normal checkout flow) take over from here.
  const reservationActionsHtml =
    reservation.status === "pending" || reservation.status === "confirmed"
      ? `
        <div class="flex items-center gap-1.5">
          ${
            reservation.status === "pending"
              ? `
            <button type="button" data-action="confirm-reservation" data-reservation-id="${reservation.airtable_id}"
              class="text-[11px] font-semibold px-2.5 py-1 rounded-lg bg-blue-900/40 hover:bg-blue-800/60 border border-blue-700/40
                     text-blue-300 hover:text-white transition-colors">
              Confirm
            </button>`
              : ""
          }
          <button type="button" data-action="cancel-reservation" data-reservation-id="${reservation.airtable_id}"
            class="text-[11px] font-semibold px-2.5 py-1 rounded-lg border transition-colors
                   ${
                     isCancelResPending
                       ? "bg-red-700 border-red-500 text-white"
                       : "bg-gray-800 hover:bg-red-900/40 border-gray-700 hover:border-red-700 text-gray-500 hover:text-red-400"
                   }">
            ${isCancelResPending ? "Confirm?" : "Cancel"}
          </button>
        </div>
      `
      : "";

  const bodyHtml = `
    <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-3">
      <div class="min-w-0">
        <p class="text-sm font-semibold text-white truncate">${reservation.guest_name ?? "—"}</p>
        <p class="text-xs text-gray-500 truncate">${contactBits || "No contact on file"}</p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        ${_statusBadge(reservation.status)}
        ${reservationActionsHtml}
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-400 mb-3">
      <span><span class="text-gray-600">Check-in:</span> ${_fmtDate(reservation.check_in)}</span>
      <span><span class="text-gray-600">Check-out:</span> ${_fmtDate(reservation.check_out)}</span>
      <span><span class="text-gray-600">Guests:</span> ${reservation.num_guests ?? "—"}</span>
    </div>

    ${reservation.notes ? `<p class="text-xs text-gray-500 italic mb-3">"${_escapeHtml(reservation.notes)}"</p>` : ""}

    <div class="bg-gray-950/50 border border-gray-800 rounded-lg px-4">
      ${
        items.length === 0
          ? `<p class="text-xs text-gray-600 italic py-3">No rooms requested.</p>`
          : items.map((li) => _buildLineItemRow(reservation, li, callbacks.getAvailableRoomsForCategory)).join("")
      }
    </div>
  `;

  if (allDone) {
    return `
      <details class="reservation-card bg-gray-900/60 border border-gray-800 rounded-xl px-5 py-4 opacity-60 hover:opacity-90 transition-opacity"
        data-reservation-id="${reservation.airtable_id}">
        <summary class="cursor-pointer flex items-center justify-between gap-3 list-none">
          <div class="min-w-0">
            <span class="text-sm font-semibold text-gray-300">${reservation.guest_name ?? "—"}</span>
            <span class="text-xs text-gray-600 ml-2">${_fmtDate(reservation.check_in)} → ${_fmtDate(reservation.check_out)}</span>
          </div>
          <span class="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border bg-emerald-900/40 text-emerald-400 border-emerald-800/40 shrink-0">
            All checked in
          </span>
        </summary>
        <div class="mt-4">${bodyHtml}</div>
      </details>
    `;
  }

  return `
    <div class="reservation-card bg-gray-900/60 border border-gray-800 rounded-xl px-5 py-4" data-reservation-id="${reservation.airtable_id}">
      ${bodyHtml}
    </div>
  `;
}

function _escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ─────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────

function _render() {
  if (!_lastArgs) return;
  const { reservations, lineItems, callbacks } = _lastArgs;

  const container = document.getElementById("reservations-container");
  const emptyState = document.getElementById("reservations-empty-state");
  if (!container) return;

  if (!reservations || reservations.length === 0) {
    container.innerHTML = "";
    emptyState?.classList.remove("hidden");
    return;
  }
  emptyState?.classList.add("hidden");

  // Newest-created first, so freshly submitted website bookings surface at the top.
  const sorted = [...reservations].sort((a, b) => {
    const da = a.created_at ? new Date(a.created_at).getTime() : 0;
    const db = b.created_at ? new Date(b.created_at).getTime() : 0;
    return db - da;
  });

  container.innerHTML = `<div class="space-y-3">${sorted
    .map((r) => _buildReservationCard(r, lineItems, callbacks))
    .join("")}</div>`;
}

// ─────────────────────────────────────────────────────
// Event delegation (wired once)
// ─────────────────────────────────────────────────────

let _delegationWired = false;

function _wireDelegation() {
  if (_delegationWired) return;
  _delegationWired = true;

  const container = document.getElementById("reservations-container");
  if (!container) return;

  container.addEventListener("click", async (e) => {
    const toggleBtn = e.target.closest('[data-action="toggle-picker"]');
    const confirmBtn = e.target.closest('[data-action="confirm-assign"]');
    const cancelLineItemBtn = e.target.closest('[data-action="cancel-line-item"]');
    const confirmReservationBtn = e.target.closest('[data-action="confirm-reservation"]');
    const cancelReservationBtn = e.target.closest('[data-action="cancel-reservation"]');

    if (toggleBtn) {
      const id = toggleBtn.dataset.lineItemId;
      _openPickerLineItemId = _openPickerLineItemId === id ? null : id;
      _render();
      return;
    }

    if (confirmBtn) {
      const lineItemId = confirmBtn.dataset.lineItemId;
      const select = container.querySelector(`select[data-role="room-select"][data-line-item-id="${lineItemId}"]`);
      const roomName = select?.value;
      if (!roomName || !_lastArgs) return;

      const { reservations, lineItems, callbacks } = _lastArgs;
      const lineItem = lineItems.find((li) => li.line_item_id === lineItemId);
      const reservation = reservations.find((r) => (lineItem?.reservation_id ?? []).includes(r.airtable_id));
      const room = (callbacks.getAvailableRoomsForCategory?.(lineItem?.category_id, []) ?? []).find(
        (r) => r.room_name === roomName
      );
      if (!lineItem || !reservation || !room) return;

      _assigningLineItemId = lineItemId;
      _openPickerLineItemId = null;
      _render();

      try {
        await callbacks.onAssignRoom?.(reservation, lineItem, room);
      } finally {
        _assigningLineItemId = null;
        _render();
      }
      return;
    }

    if (cancelLineItemBtn) {
      const lineItemId = cancelLineItemBtn.dataset.lineItemId;
      const key = `li:${lineItemId}`;
      if (!_pendingCancelKeys.has(key)) {
        _armPendingCancel(key);
        return;
      }
      _pendingCancelKeys.delete(key);
      const lineItem = _lastArgs?.lineItems.find((li) => li.line_item_id === lineItemId);
      if (!lineItem) return;
      await _lastArgs.callbacks.onCancelLineItem?.(lineItem);
      return;
    }

    if (confirmReservationBtn) {
      const reservationId = confirmReservationBtn.dataset.reservationId;
      const reservation = _lastArgs?.reservations.find((r) => r.airtable_id === reservationId);
      if (!reservation) return;
      await _lastArgs.callbacks.onConfirmReservation?.(reservation);
      return;
    }

    if (cancelReservationBtn) {
      const reservationId = cancelReservationBtn.dataset.reservationId;
      const key = `res:${reservationId}`;
      if (!_pendingCancelKeys.has(key)) {
        _armPendingCancel(key);
        return;
      }
      _pendingCancelKeys.delete(key);
      const reservation = _lastArgs?.reservations.find((r) => r.airtable_id === reservationId);
      if (!reservation) return;
      await _lastArgs.callbacks.onCancelReservation?.(reservation);
      return;
    }
  });
}

/**
 * Renders the Reservations view into #reservations-container.
 *
 * @param {Object[]} reservations
 * @param {Object[]} lineItems
 * @param {{
 *   getAvailableRoomsForCategory: (categoryId: string, excludeNames: string[]) => Object[],
 *   onAssignRoom: (reservation: Object, lineItem: Object, room: Object) => Promise<void>,
 *   onCancelLineItem: (lineItem: Object) => Promise<void>,
 *   onConfirmReservation: (reservation: Object) => Promise<void>,
 *   onCancelReservation: (reservation: Object) => Promise<void>
 * }} callbacks
 */
export function renderReservationsTab(reservations, lineItems, callbacks) {
  _lastArgs = { reservations: reservations ?? [], lineItems: lineItems ?? [], callbacks: callbacks ?? {} };
  _wireDelegation();
  _render();
}