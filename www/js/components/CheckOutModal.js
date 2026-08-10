/**
 * js/components/CheckOutModal_2.js
 * ─────────────────────────────────────────────────────
 * Dynamic-group checkout modal (v2 of CheckOutModal.js).
 *
 * Handles financial closing for ONE OR MORE occupied rooms that
 * belong to the same stay, e.g. a family that booked three rooms
 * under one guest name and wants a single checkout + single payment.
 *
 * Differences from the original CheckOutModal.js:
 * - The set of rooms being checked out lives in a local `activeGroup`
 *   array, not a single `room` argument. It starts with the room the
 *   user clicked, and can grow via an "Add Room" dropdown that pulls
 *   in other occupied rooms sharing the same booking, without closing
 *   the modal or resetting anything already entered.
 * - Matching for "same booking" uses a dual anchor — Client_Booking_Ref
 *   AND guest_name — supplied by main.js via `getRelatedRooms(anchor, excludedNames)`.
 *   Two anchors instead of one avoids both false positives (two
 *   unrelated guests who happen to share a name) and false negatives
 *   (a group booking where each room got its own booking_id but the
 *   same guest_name). booking_id itself is per-room and can't be used
 *   as the group anchor — Client_Booking_Ref is what's shared across
 *   every room in the group.
 * - Per-room shop-item + subtotal blocks are rendered into a
 *   `#co-rooms-list` container that gets swapped out on group change.
 *   Payment fields live outside that container and are never
 *   re-created, so payment method / reference entry is never lost.
 * - Shop-item buttons, remove-room buttons, and per-room "Add shop
 *   item" buttons are all wired via delegated listeners on
 *   `#co-rooms-list`, so rooms added later are immediately interactive.
 *
 * Exports:
 * - openModal(room, callbacks)
 * - closeModal()
 * - refreshRoomTotals(updatedRoom)   // replaces refreshOccupiedTotals()
 */

import { printReceiptPhysical, downloadReceiptPdf } from "./Receipt.js";
import {
  renderPaymentFields,
  validatePayment,
  PAYMENT_METHOD_SELECT_ID,
  PAYMENT_REFERENCE_INPUT_ID
} from "./payments.js";

// ─────────────────────────────────────────────────────
// Shop menu
// ─────────────────────────────────────────────────────

const SHOP_ITEMS = [
  { name: "Water", price: 150 },
  { name: "Dasani 1L", price: 100 },
  { name: "Dasani 500ml", price: 50 },
  { name: "Soda", price: 50 },
  { name: "Predator Energy", price: 80 }
];

// ─────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────
//
// Same singleton-modal reasoning as CheckInModal_2.js: only one
// instance of this modal is ever open (shared #checkin-modal /
// #modal-overlay nodes), so module-level state is safe and keeps the
// exported functions simple.

let _activeGroup = []; // Object[] — rooms currently in this checkout
let _anchor = null; // { Client_Booking_Ref, guest_name } — used to find related rooms
let _onAddShopCallback = null; // (room, { item_name, item_price, quantity }) => void
let _onCheckOutCallback = null; // ({ rooms, payment_method, payment_reference }) => void
let _onExtendNightsCallback = null; // (room, newNights) => Promise<Object> — resolves to the updated room
let _getRelatedRoomsCallback = null; // (anchor, excludedRoomNames) => Object[]
let _onDeleteBookingCallback = null; // (room) => Promise<boolean>
let _pendingDeleteConfirm = new Set(); // room_name(s) currently in the "Confirm delete?" state

// ─────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────

/** @param {number} n @returns {string} */
function _ksh(n) {
  if (n == null) return "—";
  return `KSH ${Number(n).toLocaleString("en-KE")}`;
}

/** Turns a room_name into a DOM-id-safe fragment. */
function _safeId(roomName) {
  return String(roomName).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function _activeGroupNames() {
  return _activeGroup.map((r) => r.room_name);
}

/**
 * Room subtotal: what's still owed on the room charge for this stay.
 *   nights      = selected_nights (if the front desk edited it) ?? the
 *                 booking's nights ?? the room's own nights ?? 1
 *   roomTotal   = charged_rate (or base_rate as fallback) × nights
 *   alreadyPaid = amount_paid recorded at check-in (room-level, falling
 *                 back to the booking-level value)
 * Never negative — a room that's overpaid (e.g. rate was lowered after
 * a deposit) shows a zero balance, not a negative one.
 */
function _roomSubtotal(room) {
  const booking = room.activeBooking ?? {};
  const nights = room.selected_nights ?? booking.nights ?? room.nights ?? 1;
  const roomTotal = (room.charged_rate ?? room.base_rate ?? 0) * nights;
  const alreadyPaid = Number(room.amount_paid ?? booking.amount_paid ?? 0);
  return Math.max(0, roomTotal - alreadyPaid);
}

function _shopTotal(room) {
  return room.shop_total ?? 0;
}

function _groupGrandTotal() {
  return _activeGroup.reduce((sum, room) => sum + _roomSubtotal(room) + _shopTotal(room), 0);
}

// ─────────────────────────────────────────────────────
// HTML builders
// ─────────────────────────────────────────────────────

function _buildShopItemsHtml(room) {
  return SHOP_ITEMS.map(
    (item) => `
    <div class="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
      <div>
        <p class="text-sm font-medium text-white">${item.name}</p>
        <p class="text-xs text-gray-500 font-mono">${_ksh(item.price)}</p>
      </div>
      <div class="flex items-center gap-2">
        <input type="number" min="1" max="99" value="1"
          data-room="${room.room_name}" data-item-name="${item.name}" data-item-price="${item.price}"
          class="shop-qty w-14 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white
                 text-center focus:outline-none focus:border-brand-500 transition-colors" />
        <button type="button" data-action="add-shop"
          data-room="${room.room_name}" data-item-name="${item.name}" data-item-price="${item.price}"
          class="btn-add-shop text-xs px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-brand-700 text-gray-300 hover:text-white
                 border border-gray-600 hover:border-brand-500 transition-colors font-medium">
          Add
        </button>
      </div>
    </div>
  `
  ).join("");
}

function _buildExistingItemsHtml(room) {
  const items = Array.isArray(room.shop_items) ? room.shop_items : [];
  if (items.length === 0) {
    return `<p class="text-xs text-gray-600 italic">No shop items added yet.</p>`;
  }
  return items
    .map(
      (si) => `
      <div class="flex justify-between text-xs py-0.5">
        <span class="text-gray-400">${si.name} ×${si.qty ?? 1}</span>
        <span class="text-gray-300 font-mono">${_ksh((si.unit_price ?? si.price ?? 0) * (si.qty ?? 1))}</span>
      </div>
    `
    )
    .join("");
}

/**
 * Builds one room's full block: guest/stay info + shop items + POS add-item UI.
 * @param {Object} room
 * @returns {string}
 */
function _buildRoomBlock(room) {
  const booking = room.activeBooking ?? {};
  const canRemove = _activeGroup.length > 1;
  const subtotal = _roomSubtotal(room);

  return `
    <div class="rounded-lg bg-gray-800/60 border border-gray-700 px-4 py-3 space-y-3" data-room="${room.room_name}">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-sm font-semibold text-white">${room.room_name}</p>
          <p class="text-xs text-gray-400">${room.room_type ?? "Room"}</p>
        </div>
        ${
          canRemove
            ? `<button type="button" data-action="remove-room" data-room="${room.room_name}"
                 title="Remove room from this checkout"
                 class="w-6 h-6 flex items-center justify-center rounded-md bg-gray-800 hover:bg-red-900/60
                        text-gray-500 hover:text-red-400 border border-gray-700 hover:border-red-700 transition-colors">
                 <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                 </svg>
               </button>`
            : ""
        }
      </div>

      <button type="button" data-action="delete-booking" data-room="${room.room_name}"
        class="delete-booking-btn text-[10px] px-2 py-1 rounded-md border transition-colors font-medium
               ${
                 _pendingDeleteConfirm.has(room.room_name)
                   ? "bg-red-700 border-red-500 text-white"
                   : "bg-gray-800 hover:bg-red-900/60 text-gray-500 hover:text-red-400 border-gray-700 hover:border-red-700"
               }">
        ${_pendingDeleteConfirm.has(room.room_name) ? "Confirm delete?" : "Delete booking"}
      </button>

      <div class="flex justify-between items-center gap-2">
        <span class="text-xs text-gray-500">Nights</span>
        <div class="flex items-center gap-1.5">
          <input type="number"
           class="room-nights-input w-12 bg-gray-900 border border-gray-700 rounded px-1 text-right text-xs text-white"
           data-room-name="${room.room_name}"
           value="${room.selected_nights ?? booking.nights ?? 1}"
           min="1" />
          <button type="button" data-action="extend-nights" data-room="${room.room_name}"
            class="text-[10px] px-2 py-1 rounded-md bg-gray-700 hover:bg-brand-700 text-gray-300 hover:text-white
                   border border-gray-600 hover:border-brand-500 transition-colors font-medium">
            Update
          </button>
        </div>
      </div>
      <div class="flex justify-between">
        <span class="text-xs text-gray-500">Room rate</span>
        <span class="text-xs font-bold text-emerald-400 font-mono">${_ksh(room.charged_rate ?? room.base_rate)}</span>
      </div>
      <div class="flex justify-between border-t border-gray-700 pt-1.5">
        <span class="text-xs text-gray-500">Room subtotal</span>
        <span class="text-sm font-bold text-white font-mono" data-room-subtotal="${room.room_name}">${_ksh(subtotal)}</span>
      </div>

      <div>
        <p class="text-[11px] font-semibold text-gray-500 uppercase tracking-widest mb-1.5">Shop charges</p>
        <div class="existing-shop-items space-y-0.5" data-room="${room.room_name}">
          ${_buildExistingItemsHtml(room)}
        </div>
        <div class="flex justify-between mt-2 pt-2 border-t border-gray-800">
          <span class="text-xs text-gray-500">Shop total</span>
          <span class="shop-total-display text-xs font-bold text-white font-mono" data-room="${room.room_name}">${_ksh(_shopTotal(room))}</span>
        </div>
      </div>

      <details class="group">
        <summary class="text-xs font-semibold text-brand-400 cursor-pointer select-none list-none">
          + Add shop item
        </summary>
        <div class="mt-2 space-y-0">
          ${_buildShopItemsHtml(room)}
        </div>
      </details>
    </div>
  `;
}

/** Builds the "Add Room" dropdown — occupied siblings sharing this stay's anchor only. */
function _buildAddRoomRow() {
  const excluded = _activeGroupNames();

  // Related occupied rooms only. An earlier version also listed fresh
  // "available" rooms here, but nothing in this file ever created a
  // booking for one if picked — there's no check-in path inside
  // checkout — so selecting it was a silent no-op. Restricting the
  // source to getRelatedRooms() means every option this dropdown shows
  // is now actually addable.
  const related = _getRelatedRoomsCallback?.(_anchor, excluded) ?? [];

  if (related.length === 0) {
    return `
      <div class="rounded-lg border border-dashed border-gray-800 px-4 py-3 text-xs text-gray-600 italic">
        No other rooms in this stay to add.
      </div>
    `;
  }

  const optionsHtml = related.map((r) => `<option value="${r.room_name}">${r.room_name} (Sibling)</option>`).join("");

  return `
    <div class="flex items-center gap-2">
      <select id="co-add-room-select"
        class="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
               focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors">
        ${optionsHtml}
      </select>
      <button type="button" id="co-btn-add-room"
        class="px-4 py-2.5 rounded-lg text-sm font-semibold text-white bg-gray-700 hover:bg-brand-700
               border border-gray-600 hover:border-brand-500 transition-colors whitespace-nowrap">
        + Add Room
      </button>
    </div>
  `;
}

/** Re-renderable inner markup: room blocks + add-room row + grand total. */
function _buildRoomsSection() {
  const isGroup = _activeGroup.length > 1;
  return `
    <p class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">
      ${isGroup ? `Rooms (${_activeGroup.length})` : "Room"}
    </p>
    <div id="co-rooms-list" class="space-y-3">
      ${_activeGroup.map((r) => _buildRoomBlock(r)).join("")}
    </div>
    <div class="mt-3">${_buildAddRoomRow()}</div>
    <div class="flex justify-between mt-4 pt-3 border-t border-gray-800">
      <span class="text-xs font-semibold text-gray-400">Grand total</span>
      <span id="co-grand-total-display" class="text-sm font-bold text-amber-300 font-mono">${_ksh(_groupGrandTotal())}</span>
    </div>
  `;
}

/** Builds the full checkout panel shell. Called once on open. */
function _buildCheckOutPanel() {
  const isGroup = _activeGroup.length > 1;
  const first = _activeGroup[0];
  const booking = first.activeBooking ?? {};

  return `
    <div class="flex items-center justify-between px-5 py-4 border-b border-gray-800">
      <div>
        <p class="text-xs text-gray-500 uppercase tracking-widest font-medium">${isGroup ? "Group Check-Out" : "Occupied"}</p>
        <h2 id="co-header-title" class="text-xl font-bold text-white mt-0.5">
          ${isGroup ? `${_activeGroup.length} Rooms` : first.room_name}
        </h2>
      </div>
      <button id="modal-close-btn" type="button"
        class="w-8 h-8 rounded-lg bg-gray-800 hover:bg-gray-700 flex items-center justify-center text-gray-400 hover:text-white transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-5 py-5 space-y-5">

      <div class="rounded-lg bg-gray-800/60 border border-gray-700 px-4 py-3">
        <div class="flex justify-between">
          <span class="text-xs text-gray-500">Guest</span>
          <span class="text-sm font-semibold text-white">${booking.guest_name ?? "—"}</span>
        </div>
      </div>

      <div id="co-rooms-section">
        ${_buildRoomsSection()}
      </div>

      <div>
        <p class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">Payment</p>
        <div id="co-payment-fields"></div>
      </div>

    </div>

    <div class="px-5 py-4 border-t border-gray-800 space-y-2">
      <div id="co-validation-msg" class="text-xs text-red-400 hidden mb-1"></div>
      <div class="grid grid-cols-2 gap-2">
        <button id="btn-print-receipt" type="button"
          title="Send to the thermal receipt printer (front desk PC)"
          class="py-2.5 rounded-xl font-semibold text-sm bg-gray-700 hover:bg-gray-600 text-white transition-colors">
          🖨️ Print Receipt${isGroup ? "s" : ""}
        </button>
        <button id="btn-download-receipt" type="button"
          title="Download a PDF copy (works on any phone or computer)"
          class="py-2.5 rounded-xl font-semibold text-sm bg-gray-700 hover:bg-gray-600 text-white transition-colors">
          ⬇️ Download PDF
        </button>
      </div>
      <button id="btn-checkout" type="button"
        class="w-full py-2.5 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-red-700 to-red-600
               hover:from-red-600 hover:to-red-500 transition-colors">
        <span id="co-checkout-btn-label">${isGroup ? `Check Out ${_activeGroup.length} Rooms` : "Check Out"}</span>
      </button>
      <button id="modal-cancel-btn" type="button"
        class="w-full py-2 rounded-xl font-medium text-sm text-gray-500 hover:text-gray-300 transition-colors">
        Close
      </button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────
// Dynamic body refresh
// ─────────────────────────────────────────────────────

/**
 * Re-renders the room list, add-room dropdown, grand total, header,
 * and checkout-button label — WITHOUT touching #co-payment-fields, so
 * an in-progress?.addEventListener("click", () => { payment method / reference entry survives a room
 * being added or removed.
 */
function _refreshRoomsSection() {
  const isGroup = _activeGroup.length > 1;

  const headerTitle = document.getElementById("co-header-title");
  if (headerTitle) 
    headerTitle.textContent = isGroup ? `${_activeGroup.length} Rooms` : _activeGroup[0].room_name;
  

  const checkoutLabel = document.getElementById("co-checkout-btn-label");
  if (checkoutLabel) 
    checkoutLabel.textContent = isGroup ? `Check Out ${_activeGroup.length} Rooms` : "Check Out";
  
  // 2. Re-render the container
  const roomsSection = document.getElementById("co-rooms-section");
  if (roomsSection) {
    roomsSection.innerHTML = _buildRoomsSection();

    // 3. CRITICAL: Re-attach all listeners AFTER the HTML is replaced
    _wireAddRoomRow(); // Re-bind the Add Room button
    _wireRoomsSection(); // Re-bind the Nights inputs
  }
}

// ─────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────

/** Wires the "+ Add Room" button. Rebuilt (and re-wired) on every refresh. */
function _wireAddRoomRow() {
  const addBtn = document.getElementById("co-btn-add-room");
  const addSelect = document.getElementById("co-add-room-select");
  if (!addBtn || !addSelect) return;

  addBtn.addEventListener("click", () => {
    const roomName = addSelect.value;
    console.log("Attempting to add room:", roomName);
    if (!roomName || _activeGroupNames().includes(roomName)) return;

    const candidates = _getRelatedRoomsCallback?.(_anchor, _activeGroupNames()) ?? [];
    console.log("Current Candidates:", candidates);
    const room = candidates.find((r) => r.room_name === roomName);
    if (!room) {
      console.log("Room not found in candidates list!");
      return;
    }

    _activeGroup.push({
      ...room,
      selected_nights: room.activeBooking?.nights ?? room.nights ?? 1
    });
    _refreshRoomsSection();
  });
}

function _wireRoomsSection() {
  const inputs = document.querySelectorAll(".room-nights-input");
  inputs.forEach((input) => {
    input.addEventListener("change", (e) => {
      const roomName = e.target.getAttribute("data-room-name");
      const newNights = parseInt(e.target.value) || 1;

      // Update the data
      const room = _activeGroup.find((r) => r.room_name === roomName);
      if (room) {
        room.selected_nights = newNights;
      }

      // Update the Grand Total display and UI
      document.getElementById("co-grand-total-display").innerText = _ksh(_groupGrandTotal());
      // Optional: If you want individual row prices to update immediately,
      // call _refreshRoomsSection() here instead of just the total
      // 2. Refresh the individual subtotal for THIS room
      // We look for the subtotal element using the selector we defined in _buildRoomBlock
      const subtotalEl = document.querySelector(`[data-room-subtotal="${roomName}"]`);
      if (subtotalEl) {
        const subtotal = Number(room.charged_rate ?? room.base_rate) * newNights;
        subtotalEl.textContent = _ksh(subtotal);
      }
    });
  });
}

/**
 * Delegated click handler for the rooms list — handles "Add shop
 * item" and "remove room" for every room currently rendered,
 * including ones added after the modal first opened.
 */
function _onRoomsListClick(e) {
  const deleteBtn = e.target.closest('[data-action="delete-booking"]');
  if (deleteBtn) {
    _handleDeleteBookingClick(deleteBtn);
    return;
  }

  const extendBtn = e.target.closest('[data-action="extend-nights"]');
  if (extendBtn) {
    _handleExtendNightsClick(extendBtn);
    return;
  }

  const addShopBtn = e.target.closest('[data-action="add-shop"]');
  if (addShopBtn) {
    const roomName = addShopBtn.dataset.room;
    const room = _activeGroup.find((r) => r.room_name === roomName);
    if (!room) return;

    const itemName = addShopBtn.dataset.itemName;
    const itemPrice = Number(addShopBtn.dataset.itemPrice);
    const qtyInput = document.querySelector(`.shop-qty[data-room="${roomName}"][data-item-name="${itemName}"]`);
    const qty = Math.max(1, Number(qtyInput?.value ?? 1));

    _onAddShopCallback?.(room, { item_name: itemName, item_price: itemPrice, quantity: qty });
    return;
  }

  const removeBtn = e.target.closest('[data-action="remove-room"]');
  if (removeBtn) {
    const roomName = removeBtn.dataset.room;
    if (_activeGroup.length <= 1) return; // Never remove the last room — close the modal instead.

    _activeGroup = _activeGroup.filter((r) => r.room_name !== roomName);
    _refreshRoomsSection();
  }
}

/**
 * Handles a click on a room's "Update" (Extend Stay) button. Reads the
 * new nights value from that room's input, calls the injected
 * _onExtendNightsCallback, and on success syncs _activeGroup + the
 * on-screen totals for that room. On failure, shows the error in
 * #co-validation-msg and reverts the input back to its previous value.
 * @param {HTMLElement} triggerBtn
 */
async function _handleExtendNightsClick(triggerBtn) {
  const roomName = triggerBtn.dataset.room;
  const room = _activeGroup.find((r) => r.room_name === roomName);
  const input = document.querySelector(`.room-nights-input[data-room-name="${roomName}"]`);
  const validationMsg = document.getElementById("co-validation-msg");
  if (!room || !input) return;

  const previousValue = room.selected_nights ?? room.activeBooking?.nights ?? room.nights ?? 1;
  const newNights = parseInt(input.value, 10) || 1;

  if (newNights === previousValue) return; // nothing changed, no need to write

  triggerBtn.disabled = true;
  triggerBtn.textContent = "…";

  try {
    const updatedRoom = await _onExtendNightsCallback?.(room, newNights);

    if (!updatedRoom) {
      throw new Error("Could not extend stay — no response from server.");
    }

    const idx = _activeGroup.findIndex((r) => r.room_name === roomName);
    if (idx >= 0) {
      _activeGroup[idx] = { ...updatedRoom, selected_nights: newNights };
    }

    validationMsg?.classList.add("hidden");
    refreshRoomTotals(_activeGroup[idx] ?? updatedRoom);
  } catch (err) {
    if (validationMsg) {
      validationMsg.textContent = err?.message ?? "Could not extend stay. Please try again.";
      validationMsg.classList.remove("hidden");
    }
    input.value = previousValue;
  } finally {
    triggerBtn.disabled = false;
    triggerBtn.textContent = "Update";
  }
}

/**
 * Handles a click on a room's "Delete booking" button — an in-place
 * two-tap confirm (button text flips to "Confirm delete?" for ~3s,
 * reverts if not tapped again), matching the destructive-action
 * pattern used elsewhere instead of a native window.confirm() popup.
 * @param {HTMLElement} btn
 */
async function _handleDeleteBookingClick(btn) {
  const roomName = btn.dataset.room;
  const room = _activeGroup.find((r) => r.room_name === roomName);
  if (!room) return;

  if (!_pendingDeleteConfirm.has(roomName)) {
    _pendingDeleteConfirm.add(roomName);
    btn.textContent = "Confirm delete?";
    btn.classList.add("bg-red-700", "border-red-500", "text-white");
    setTimeout(() => {
      if (_pendingDeleteConfirm.has(roomName)) {
        _pendingDeleteConfirm.delete(roomName);
        btn.textContent = "Delete booking";
        btn.classList.remove("bg-red-700", "border-red-500", "text-white");
      }
    }, 3000);
    return;
  }

  _pendingDeleteConfirm.delete(roomName);
  btn.disabled = true;
  btn.textContent = "Deleting…";

  const success = await _onDeleteBookingCallback?.(room);
  if (!success) {
    btn.disabled = false;
    btn.textContent = "Delete booking";
    return;
  }

  _activeGroup = _activeGroup.filter((r) => r.room_name !== roomName);

  if (_activeGroup.length === 0) {
    closeModal();
    return;
  }

  _refreshRoomsSection();
}

/**
 * Wires up all interactive behaviour for the checkout panel. Called
 * once per modal open — room-related interactions after this point go
 * through the delegated listener set up here, so they keep working
 * after `_refreshRoomsSection()` swaps the rooms list HTML.
 */
function _wireCheckOutPanel() {
  const paymentFieldsContainer = document.getElementById("co-payment-fields");
  const validationMsg = document.getElementById("co-validation-msg");
  const roomsSection = document.getElementById("co-rooms-section");

  // Shared payment method dropdown + conditional reference field.
  renderPaymentFields("co-payment-fields", "cash");
  paymentFieldsContainer.addEventListener("input", () => validationMsg.classList.add("hidden"));
  paymentFieldsContainer.addEventListener("change", () => validationMsg.classList.add("hidden"));

  // Delegated listener for shop-item buttons + room removal, scoped to
  // the stable #co-rooms-section wrapper so it survives re-renders.
  roomsSection.addEventListener("click", _onRoomsListClick);

  // Add-room dropdown (rebuilt each refresh, wire it fresh here too)
  _wireAddRoomRow();

  // Nights inputs rendered by _buildRoomBlock() on the initial panel
  // build also need wiring here — _refreshRoomsSection() re-wires them
  // on later add/remove-room refreshes, but that doesn't cover the
  // very first render.
  _wireRoomsSection();

  document.getElementById("btn-print-receipt")?.addEventListener("click", () => {
    printReceiptPhysical(_activeGroup);
  });

  document.getElementById("btn-download-receipt")?.addEventListener("click", () => {
    downloadReceiptPdf(_activeGroup);
  });

  // Checkout
  document.getElementById("btn-checkout")?.addEventListener("click", () => {
    const paymentMethod = document.getElementById(PAYMENT_METHOD_SELECT_ID).value;
    const referenceInput = document.getElementById(PAYMENT_REFERENCE_INPUT_ID);
    const reference = referenceInput ? referenceInput.value.trim() : "";

    const { valid, message } = validatePayment(paymentMethod, reference);

    if (!valid) {
      validationMsg.textContent = message;
      validationMsg.classList.remove("hidden");
      referenceInput?.focus();
      return;
    }

    validationMsg.classList.add("hidden");

    _onCheckOutCallback?.({
      // Pass the rooms as objects (not bare ids) so main.js has each
      // room's computed balance_due alongside its booking_id — the
      // running balance the front desk collected at checkout time,
      // derived from the same _roomSubtotal() the panel displays.
      rooms: _activeGroup.map((room) => ({
        booking_id: room.booking_id,
        room_name: room.room_name,
        balance_due: _roomSubtotal(room)
      })),

      // Pass the payment details flat, so they can be merged into the PATCH payload
      payment_method: paymentMethod,
      payment_reference: reference || null,
      payment_status: "paid" // Ensure this is included!
    });
  });
}

// ─────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────

/**
 * Opens the slide-out modal for an OCCUPIED room, and lets the user
 * extend the session afterwards via an "Add Room" dropdown that pulls
 * in other rooms sharing the same Client_Booking_Ref + guest_name anchor.
 *
 * @param {Object} room
 * @param {{
 *   onAddShop:  Function,  // (room, { item_name, item_price, quantity }) => void
 *   onCheckOut: Function,  // ({ rooms: [{room_name, booking_id}], payment_method, payment_reference }) => void
 *   getRelatedRooms: (anchor: {Client_Booking_Ref, guest_name}, excludedRoomNames: string[]) => Object[]
 *     // Returns other occupied rooms belonging to the same stay —
 *     // main.js owns state.js, so it decides the matching rule
 *     // (getRelatedRooms() requires same Client_Booking_Ref AND same
 *     // guest_name, minus rooms already in the group).
 *   onDeleteBooking: (room) => Promise<boolean>,
 *     // Permanently deletes a room's booking (and its shop_line_items)
 *     // instead of checking it out. Resolves true on success, in which
 *     // case the room is dropped from _activeGroup (closing the modal
 *     // if it was the last one left).
 * }} callbacks
 */
export function openModal(room, callbacks) {
  const { onAddShop, onCheckOut, onExtendNights, getRelatedRooms, onDeleteBooking } = callbacks;

  const modal = document.getElementById("checkout-modal");
  const overlay = document.getElementById("modal-overlay");
  if (!modal || !overlay) return;
  if (!room) return;

  // Reset module state for this open
  _activeGroup = [room];
  _anchor = {
    // getRelatedRooms() in state.js filters on Client_Booking_Ref + guest_name.
    // booking_id is per-room, not shared across a group, so it can't anchor
    // the lookup — Client_Booking_Ref is the field every sibling shares.
    Client_Booking_Ref: room.Client_Booking_Ref ?? null,
    guest_name: room.activeBooking?.guest_name ?? null
  };
  _onAddShopCallback = onAddShop;
  _onCheckOutCallback = onCheckOut;
  _onExtendNightsCallback = typeof onExtendNights === "function" ? onExtendNights : null;
  _getRelatedRoomsCallback = typeof getRelatedRooms === "function" ? getRelatedRooms : () => [];
  _onDeleteBookingCallback = typeof onDeleteBooking === "function" ? onDeleteBooking : null;
  _pendingDeleteConfirm = new Set();

  // Inject HTML
  modal.innerHTML = _buildCheckOutPanel();

  // Wire interactivity
  _wireCheckOutPanel();

  // Close buttons
  document.getElementById("modal-close-btn")?.addEventListener("click", closeModal);
  document.getElementById("modal-cancel-btn")?.addEventListener("click", closeModal);

  // Animate in
  overlay.classList.add("backdrop-blur-sm", "bg-black/50");
  requestAnimationFrame(() => {
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => {
      overlay.classList.replace("opacity-0", "opacity-100");
      modal.classList.remove("translate-x-full");
    });
  });

  // Clicking overlay closes modal
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };
}

/**
 * Closes the slide-out modal with animation and clears module state
 * so the next open starts clean.
 */
export function closeModal() {
  const modal = document.getElementById("checkout-modal");
  const overlay = document.getElementById("modal-overlay");
  if (!modal || !overlay) return;

  modal.classList.add("translate-x-full");
  overlay.classList.replace("opacity-100", "opacity-0");

  setTimeout(() => {
    overlay.classList.add("hidden");
    modal.innerHTML = "";
  }, 300);

  _activeGroup = [];
  _anchor = null;
  _onAddShopCallback = null;
  _onCheckOutCallback = null;
  _onExtendNightsCallback = null;
  _getRelatedRoomsCallback = null;
  _onDeleteBookingCallback = null;
  _pendingDeleteConfirm = new Set();
}

/**
 * Updates one room's totals inside an already-open checkout panel.
 * Called after a successful add_shop POST for that room.
 *
 * @param {Object} updatedRoom - The patched room from state.
 */
export function refreshRoomTotals(updatedRoom) {
  // Keep our in-memory copy of this room's shop data current so a
  // later _refreshRoomsSection() (e.g. triggered by adding another
  // room) re-renders with the right numbers instead of stale ones.
  const idx = _activeGroup.findIndex((r) => r.room_name === updatedRoom.room_name);
  if (idx >= 0) _activeGroup[idx] = updatedRoom;

  const nightsInputEl = document.querySelector(`.room-nights-input[data-room-name="${updatedRoom.room_name}"]`);
  if (nightsInputEl) {
    const nights = updatedRoom.selected_nights ?? updatedRoom.activeBooking?.nights ?? updatedRoom.nights ?? 1;
    nightsInputEl.value = nights;
  }

  const subtotalEl = document.querySelector(`[data-room-subtotal="${updatedRoom.room_name}"]`);
  if (subtotalEl) subtotalEl.textContent = _ksh(_roomSubtotal(updatedRoom));

  const shopTotalEl = document.querySelector(`.shop-total-display[data-room="${updatedRoom.room_name}"]`);
  if (shopTotalEl) shopTotalEl.textContent = _ksh(_shopTotal(updatedRoom));

  const itemsEl = document.querySelector(`.existing-shop-items[data-room="${updatedRoom.room_name}"]`);
  if (itemsEl) itemsEl.innerHTML = _buildExistingItemsHtml(updatedRoom);

  const grandTotalEl = document.getElementById("co-grand-total-display");
  if (grandTotalEl) grandTotalEl.textContent = _ksh(_groupGrandTotal());
}
