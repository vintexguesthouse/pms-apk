/**
 * js/components/CheckInModal_2.js
 * ─────────────────────────────────────────────────────
 * Dynamic-group check-in modal (v2 of CheckInModal.js).
 *
 * Differences from the original CheckInModal.js:
 * - The set of rooms being checked in is no longer fixed at open time.
 *   It lives in a local `activeGroup` array that can grow via an
 *   "Add Room" dropdown, or shrink via a per-room remove button,
 *   without closing the modal, losing the Guest Name / Nights values,
 *   or dropping focus from whichever field the user is typing in.
 * - Room blocks are rendered into a dedicated `#ci-rooms-list`
 *   container that gets swapped out on every group change; the shared
 *   fields (Guest Name, Nights, Payment) live outside that container
 *   and are never re-created, so they never lose focus or value.
 * - All per-room interactions (room-type toggle, remove button) are
 *   wired via a single pair of delegated listeners on #ci-rooms-list
 *   instead of one listener per room/button, so rooms added later are
 *   interactive immediately with no re-wiring step.
 *
 * The caller (main.js) supplies a `getAvailableRooms(excludedNames)`
 * callback so this component never has to import state.js directly —
 * it just asks "what else can I add?" and renders whatever comes back.
 *
 * Exports:
 * - openModal(rooms, callbacks)
 * - closeModal()
 */

import {
  renderPaymentFields,
  validatePayment,
  PAYMENT_METHOD_SELECT_ID,
  PAYMENT_REFERENCE_INPUT_ID,
  renderPaymentStatusFields,
  validatePaymentStatus,
  PAYMENT_STATUS_SELECT_ID,
  PAYMENT_DEPOSIT_INPUT_ID
} from "./payments.js";

// ─────────────────────────────────────────────────────
// Rate range constants
// ─────────────────────────────────────────────────────

const RATE_MIN = 1000;
const RATE_MAX = 6500;
const RATE_STEP = 100;

// ─────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────
//
// Only one instance of this modal is ever open at a time (it shares
// the #checkin-modal / #modal-overlay DOM nodes with CheckOutModal.js,
// same as the original), so module-level state is safe here and keeps
// the public API simple — same pattern as _roomTypeSelections used to
// be in CheckInModal.js, just promoted to also own the room list.

let _activeGroup = [];              // Object[] — rooms currently in this check-in
let _roomTypeSelections = {};       // room_name -> "Bed and Breakfast" | "Bed Only"
let _rateSelections = {};           // room_name -> currently chosen charged_rate (number)
let _onCheckInCallback = null;
let _getAvailableRoomsCallback = null;
let _getReservationConflictsCallback = null;
let _ownerMode = false;

// Two-tap confirm state for the Save button, mirroring CheckOutModal.js's
// delete-booking button: first click just warns (flips the label to
// "Check In Anyway"), second click within the window actually saves.
// Reset any time the underlying conflict list changes (nights edited,
// or a room added/removed) so a stale confirm can't slip through.
let _pendingCheckInConfirm = false;
let _conflictConfirmTimeout = null;

// ─────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────

/** @param {number} n @returns {string} */
function _ksh(n) {
  if (n == null) return "—";
  return `KSH ${Number(n).toLocaleString("en-KE")}`;
}

/** @returns {string} — option HTML for rate dropdown */
function _buildRateOptions(baseRate, selectedRate) {
  const target = selectedRate ?? baseRate;
  let html = "";
  for (let r = RATE_MIN; r <= RATE_MAX; r += RATE_STEP) {
    const selected = r === target ? "selected" : "";
    html += `<option value="${r}" ${selected}>${_ksh(r)}</option>`;
  }
  return html;
}

/** Turns a room_name into a DOM-id-safe fragment. */
function _safeId(roomName) {
  return String(roomName).replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Generates the single Client_Booking_Ref for a check-in group:
 * YYYYMMDD-GUESTNAME (e.g. "20260705-JOHN-DOE").
 *
 * This is the ONLY booking reference in the flow now — there is no
 * manual reference/M-Pesa-code/bank-code input for the group itself.
 * The same string gets stamped onto every room object in the group
 * (see the Save handler below) so state.js / CheckOutModal.js can
 * find siblings purely by matching this field, per the v4 state.js
 * grouping design.
 *
 * @param {string} guestName
 * @returns {string}
 */
function _generateClientBookingRef(guestName) {
  const now = new Date();
  const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}`;

  const namePart = String(guestName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\s-]/g, "") // strip punctuation, keep letters/digits/spaces/hyphens
    .split(/\s+/)
    .filter(Boolean)
    .join("-");

  return `${datePart}-${namePart || "GUEST"}`;
}

/** Names of rooms currently in the group, for exclusion + dedupe checks. */
function _activeGroupNames() {
  return _activeGroup.map((r) => r.room_name);
}

/** Today as an ISO date string — a fresh check-in's occupancy starts today. */
function _todayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────
// HTML builders
// ─────────────────────────────────────────────────────

/**
 * Builds a single room's type-toggle + rate-selector block.
 * Reads current selections from module state so re-renders don't
 * reset a room back to its default type/rate.
 * @param {Object} room
 * @returns {string}
 */
function _buildRoomBlock(room) {
  const id = _safeId(room.room_name);
  const roomType = _roomTypeSelections[room.room_name] ?? room.room_type;
  const chargedRate = _rateSelections[room.room_name] ?? room.base_rate;
  const canRemove = _activeGroup.length > 1;

  return `
    <div class="rounded-lg bg-gray-800/60 border border-gray-700 px-4 py-3 space-y-3" data-room="${room.room_name}">
      <div class="flex items-center justify-between">
        <p class="text-sm font-semibold text-white">${room.room_name}</p>
        <div class="flex items-center gap-2">
          <p class="text-xs text-gray-500">Base: ${_ksh(room.base_rate)}</p>
          ${
            canRemove
              ? `<button type="button" data-action="remove-room" data-room="${room.room_name}"
                   title="Remove room from this check-in"
                   class="w-6 h-6 flex items-center justify-center rounded-md bg-gray-800 hover:bg-red-900/60
                          text-gray-500 hover:text-red-400 border border-gray-700 hover:border-red-700 transition-colors">
                   <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                   </svg>
                 </button>`
              : ""
          }
        </div>
      </div>

      <div>
        <label class="block text-xs font-semibold text-gray-400 mb-1.5">Room Type</label>
        <div class="grid grid-cols-2 gap-2">
          <button type="button" data-action="room-type" data-room="${room.room_name}" data-type="Bed and Breakfast"
            class="room-type-btn py-2.5 px-3 rounded-lg border text-sm font-medium transition-colors
                   ${roomType === "Bed and Breakfast" ? "bg-brand-700 border-brand-500 text-white" : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500"}">
            Bed and Breakfast
          </button>
          <button type="button" data-action="room-type" data-room="${room.room_name}" data-type="Bed Only"
            class="room-type-btn py-2.5 px-3 rounded-lg border text-sm font-medium transition-colors
                   ${roomType === "Bed Only" ? "bg-brand-700 border-brand-500 text-white" : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500"}">
            Bed Only
          </button>
        </div>
      </div>

      <div>
        <label class="block text-xs font-semibold text-gray-400 mb-1.5" for="ci-rate-${id}">
          Charged Rate
          <span class="text-gray-600 font-normal ml-1">(base: ${_ksh(room.base_rate)})</span>
        </label>
        <select id="ci-rate-${id}" data-room="${room.room_name}"
          class="ci-rate-select w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
                 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors">
          ${_buildRateOptions(room.base_rate, chargedRate)}
        </select>
        <div class="ci-variance-container mt-2 ${chargedRate === room.base_rate ? "hidden" : ""}" data-room="${room.room_name}">
          <p class="text-[10px] uppercase font-bold tracking-wider text-gray-500">
            Variance: <span class="ci-variance-value ${chargedRate > room.base_rate ? "text-emerald-400" : "text-red-400"}">
              ${chargedRate - room.base_rate > 0 ? "+" : ""}${chargedRate - room.base_rate} KSH
            </span>
          </p>
        </div>
      </div>
    </div>
  `;
}

/** Builds the "Add Room" dropdown row from whatever the host app says is available. */
function _buildAddRoomRow() {
  const excluded = _activeGroupNames();
  const available = (_getAvailableRoomsCallback?.(excluded) ?? []).filter(
    (r) => !excluded.includes(r.room_name)
  );

  if (available.length === 0) {
    return `
      <div class="rounded-lg border border-dashed border-gray-800 px-4 py-3 text-xs text-gray-600 italic">
        No other available rooms to add.
      </div>
    `;
  }

  const optionsHtml = available
    .map((r) => `<option value="${r.room_name}">${r.room_name} — ${_ksh(r.base_rate)}</option>`)
    .join("");

  return `
    <div class="flex items-center gap-2">
      <select id="ci-add-room-select"
        class="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
               focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors">
        ${optionsHtml}
      </select>
      <button type="button" id="ci-btn-add-room"
        class="px-4 py-2.5 rounded-lg text-sm font-semibold text-white bg-gray-700 hover:bg-brand-700
               border border-gray-600 hover:border-brand-500 transition-colors whitespace-nowrap">
        + Add Room
      </button>
    </div>
  `;
}

/** Re-renderable inner markup: room blocks + add-room row. Guest/Nights/Payment live outside this. */
function _buildRoomsSection() {
  const isGroup = _activeGroup.length > 1;
  return `
    <p class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">
      ${isGroup ? "Rooms" : "Room Details"}
    </p>
    <div id="ci-rooms-list" class="space-y-3">
      ${_activeGroup.map(_buildRoomBlock).join("")}
    </div>
    <div class="mt-3">
      ${_buildAddRoomRow()}
    </div>
  `;
}

/**
 * Builds the full check-in form shell. Only called once, on open —
 * subsequent room-group changes go through `_refreshModalBody()`.
 * @returns {string}
 */
function _buildCheckInForm() {
  const isGroup = _activeGroup.length > 1;

  return `
    <div class="flex items-center justify-between px-5 py-4 border-b border-gray-800">
      <div>
        <p class="text-xs text-gray-500 uppercase tracking-widest font-medium">${isGroup ? "Group Check-In" : "Check-In"}</p>
        <h2 id="ci-header-title" class="text-xl font-bold text-white mt-0.5">${isGroup ? `${_activeGroup.length} Rooms` : _activeGroup[0].room_name}</h2>
      </div>
      <button id="modal-close-btn" type="button"
        class="w-8 h-8 rounded-lg bg-gray-800 hover:bg-gray-700 flex items-center justify-center text-gray-400 hover:text-white transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-5 py-5 space-y-5">

      <div>
        <label class="block text-xs font-semibold text-gray-400 mb-1.5" for="ci-guest-name">
          Guest Name <span id="ci-guest-name-hint">${isGroup ? "(whole group)" : ""}</span>
        </label>
        <input id="ci-guest-name" type="text" placeholder="Full name of guest"
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
                 placeholder-gray-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors" />
      </div>

      <div>
        <label class="block text-xs font-semibold text-gray-400 mb-1.5" for="ci-nights">
          Number of Nights <span id="ci-nights-hint">${isGroup ? "(applies to all rooms)" : ""}</span>
        </label>
        <input id="ci-nights" type="number" min="1" max="30" value="1"
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
                 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors" />
      </div>

      <div id="ci-rooms-section">
        ${_buildRoomsSection()}
      </div>

      <div>
        <p class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">
          ${isGroup ? "Group Payment" : "Payment"}
        </p>
        <div id="ci-payment-status-fields" class="mb-4"></div>
        <div id="ci-payment-fields"></div>
      </div>

    </div>

    <div class="px-5 py-4 border-t border-gray-800 space-y-2">
      <div id="ci-conflict-warning" class="hidden"></div>
      <div id="ci-validation-msg" class="text-xs text-red-400 hidden mb-1"></div>
      <button id="btn-save-checkin" type="button"
        class="w-full py-2.5 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-brand-600 to-brand-500
               hover:from-brand-500 hover:to-brand-400
               transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
        <span id="ci-save-btn-label">${isGroup ? `Check In ${_activeGroup.length} Rooms` : "Save Check-In"}</span>
      </button>
      <button id="modal-cancel-btn" type="button"
        class="w-full py-2 rounded-xl font-medium text-sm text-gray-500 hover:text-gray-300 transition-colors">
        Cancel
      </button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────
// Dynamic body refresh
// ─────────────────────────────────────────────────────

/**
 * Re-renders everything that depends on the current room group
 * (header title, room blocks, add-room dropdown, save button label)
 * WITHOUT touching #ci-guest-name, #ci-nights, or #ci-payment-fields.
 * Those nodes are never removed from the DOM, so whatever the user was
 * typing (and their cursor position/focus) survives a room being
 * added or removed.
 */
function _refreshModalBody() {
  const isGroup = _activeGroup.length > 1;

  const headerTitle = document.getElementById("ci-header-title");
  if (headerTitle) {
    headerTitle.textContent = isGroup ? `${_activeGroup.length} Rooms` : _activeGroup[0].room_name;
  }

  const guestHint = document.getElementById("ci-guest-name-hint");
  if (guestHint) guestHint.textContent = isGroup ? "(whole group)" : "";

  const nightsHint = document.getElementById("ci-nights-hint");
  if (nightsHint) nightsHint.textContent = isGroup ? "(applies to all rooms)" : "";

  const roomsSection = document.getElementById("ci-rooms-section");
  if (roomsSection) roomsSection.innerHTML = _buildRoomsSection();

  const saveLabel = document.getElementById("ci-save-btn-label");
  if (saveLabel) saveLabel.textContent = isGroup ? `Check In ${_activeGroup.length} Rooms` : "Save Check-In";

  _wireAddRoomRow();
  _validateSharedFields();
  _renderConflictBanner();
}

// ─────────────────────────────────────────────────────
// Reservation-conflict warning (pending website bookings)
// ─────────────────────────────────────────────────────

/**
 * Asks the host app (via the getReservationConflicts callback) whether
 * each room currently in the group would leave its category short on
 * inventory for pending/confirmed website reservations, given the
 * current Nights value. Rooms with no category_id are skipped — there's
 * nothing to check against.
 * @returns {Array<{ room: Object, conflict: { hasConflict, shortBy, reservations } }>}
 */
function _getActiveConflicts() {
  if (!_getReservationConflictsCallback) return [];

  const nightsInput = document.getElementById("ci-nights");
  const nights = Number(nightsInput?.value);
  if (!nights || nights < 1) return [];

  const checkInDate = _todayISO();
  const conflicts = [];

  for (const room of _activeGroup) {
    if (!room.category_id) continue;
    const conflict = _getReservationConflictsCallback({
      categoryId: room.category_id,
      checkInDate,
      nights,
      excludeRoomName: room.room_name
    });
    if (conflict?.hasConflict) conflicts.push({ room, conflict });
  }

  return conflicts;
}

/** Computes what the Save button's label should read right now. */
function _computeSaveLabel() {
  if (_pendingCheckInConfirm) return "Check In Anyway";
  return _activeGroup.length > 1 ? `Check In ${_activeGroup.length} Rooms` : "Save Check-In";
}

/** Re-applies the current save label to the DOM, if the button exists. */
function _updateSaveButtonLabel() {
  const label = document.getElementById("ci-save-btn-label");
  if (label) label.textContent = _computeSaveLabel();
}

/** Clears any pending two-tap confirm state and reverts the Save label. */
function _resetSaveConfirm() {
  _pendingCheckInConfirm = false;
  clearTimeout(_conflictConfirmTimeout);
  _conflictConfirmTimeout = null;
  _updateSaveButtonLabel();
}

/**
 * Recomputes conflicts for the current group + nights value and
 * refreshes the warning banner. Called on open, whenever Nights
 * changes, and whenever a room is added/removed — any of which can
 * change which rooms are short, so any half-confirmed "Check In
 * Anyway" state is reset rather than carried forward against a
 * conflict list that's no longer the one the attendant saw.
 */
function _renderConflictBanner() {
  const banner = document.getElementById("ci-conflict-warning");
  if (!banner) return;

  const conflicts = _getActiveConflicts();

  if (conflicts.length === 0) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
    _resetSaveConfirm();
    return;
  }

  const itemsHtml = conflicts
    .map(({ room, conflict }) => {
      const resSummary = conflict.reservations
        .map((r) => `${r.guestName} (${r.checkIn} → ${r.checkOut}, ${r.quantity} room${r.quantity !== 1 ? "s" : ""})`)
        .join("; ");
      return `<li><span class="font-semibold text-white">${room.room_name}</span> — short by ${conflict.shortBy} for: ${resSummary}</li>`;
    })
    .join("");

  banner.innerHTML = `
    <div class="rounded-lg bg-amber-950/40 border border-amber-700/60 px-3 py-2.5 text-xs text-amber-300 space-y-1.5">
      <p class="font-semibold text-amber-200">Pending website reservation may need this room</p>
      <ul class="list-disc list-inside space-y-0.5">${itemsHtml}</ul>
    </div>
  `;
  banner.classList.remove("hidden");
  _resetSaveConfirm();
}

// ─────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────

/** Evaluates the shared-field validity and en/disables the Save button. */
function _validateSharedFields() {
  const guestInput = document.getElementById("ci-guest-name");
  const nightsInput = document.getElementById("ci-nights");
  const saveBtn = document.getElementById("btn-save-checkin");
  const validationMsg = document.getElementById("ci-validation-msg");
  if (!guestInput || !nightsInput || !saveBtn) return;

  const hasGuest = guestInput.value.trim().length > 0;
  const hasNights = Number(nightsInput.value) >= 1;
  const valid = hasGuest && hasNights;

  saveBtn.disabled = !valid;

  if (!valid && (guestInput.value || nightsInput.value)) {
    validationMsg.textContent = !hasGuest ? "Guest name is required." : "Enter a valid number of nights.";
    validationMsg.classList.remove("hidden");
  } else {
    validationMsg.classList.add("hidden");
  }
}

/** Wires the "+ Add Room" button. Called after every refresh since the row is rebuilt each time. */
function _wireAddRoomRow() {
  const addBtn = document.getElementById("ci-btn-add-room");
  const addSelect = document.getElementById("ci-add-room-select");
  if (!addBtn || !addSelect) return;

  addBtn.addEventListener("click", () => {
    const roomName = addSelect.value;
    if (!roomName || _activeGroupNames().includes(roomName)) return;

    const candidates = _getAvailableRoomsCallback?.(_activeGroupNames()) ?? [];
    const room = candidates.find((r) => r.room_name === roomName);
    if (!room) return;

    _activeGroup.push(room);
    _roomTypeSelections[room.room_name] = room.room_type;
    _rateSelections[room.room_name] = room.base_rate;

    _refreshModalBody();
  });
}

/**
 * Delegated click handler for the rooms list — handles room-type
 * toggles and room-removal for every room currently rendered,
 * including ones added after the modal first opened.
 */
function _onRoomsListClick(e) {
  const typeBtn = e.target.closest('[data-action="room-type"]');
  if (typeBtn) {
    const roomName = typeBtn.dataset.room;
    const type = typeBtn.dataset.type;
    _roomTypeSelections[roomName] = type;

    document.querySelectorAll(`.room-type-btn[data-room="${roomName}"]`).forEach((b) => {
      const active = b.dataset.type === type;
      b.classList.toggle("bg-brand-700", active);
      b.classList.toggle("border-brand-500", active);
      b.classList.toggle("text-white", active);
      b.classList.toggle("bg-gray-800", !active);
      b.classList.toggle("border-gray-700", !active);
      b.classList.toggle("text-gray-400", !active);
    });
    return;
  }

  const removeBtn = e.target.closest('[data-action="remove-room"]');
  if (removeBtn) {
    const roomName = removeBtn.dataset.room;
    if (_activeGroup.length <= 1) return; // Never remove the last room — close the modal instead.

    _activeGroup = _activeGroup.filter((r) => r.room_name !== roomName);
    delete _roomTypeSelections[roomName];
    delete _rateSelections[roomName];

    _refreshModalBody();
  }
}

/** Delegated change handler for the rooms list — handles rate-select variance display. */
function _onRoomsListChange(e) {
  const rateSelect = e.target.closest(".ci-rate-select");
  if (!rateSelect) return;

  const roomName = rateSelect.dataset.room;
  const room = _activeGroup.find((r) => r.room_name === roomName);
  if (!room) return;

  const selectedRate = Number(rateSelect.value);
  _rateSelections[roomName] = selectedRate;

  const varianceContainer = document.querySelector(`.ci-variance-container[data-room="${roomName}"]`);
  const varianceValue = varianceContainer?.querySelector(".ci-variance-value");
  const variance = selectedRate - Number(room.base_rate);

  if (variance !== 0) {
    varianceContainer.classList.remove("hidden");
    varianceValue.textContent = `${variance > 0 ? "+" : ""}${variance} KSH`;
    varianceValue.className = `ci-variance-value ${variance > 0 ? "text-emerald-400" : "text-red-400"}`;
  } else {
    varianceContainer?.classList.add("hidden");
  }
}

/**
 * Wires up all interactive behaviour for the check-in form. Called
 * once per modal open — everything room-related after this point goes
 * through the two delegated listeners set up here, so it keeps
 * working after `_refreshModalBody()` swaps the rooms list HTML.
 */
function _wireCheckInForm() {
  const saveBtn = document.getElementById("btn-save-checkin");
  const guestInput = document.getElementById("ci-guest-name");
  const nightsInput = document.getElementById("ci-nights");
  const validationMsg = document.getElementById("ci-validation-msg");
  const paymentFieldsContainer = document.getElementById("ci-payment-fields");
  const roomsList = document.getElementById("ci-rooms-list")?.parentElement; // #ci-rooms-section

  // 1. Shared input listeners (guest name / nights never get re-created)
  guestInput.addEventListener("input", _validateSharedFields);
  nightsInput.addEventListener("input", () => {
    _validateSharedFields();
    _renderConflictBanner();
  });

  // 2. Event delegation for room-type + remove buttons, and rate selects.
  //    Attached once on the stable #ci-rooms-section wrapper, so rooms
  //    added later via _refreshModalBody() are interactive immediately —
  //    no re-wiring needed.
  roomsList.addEventListener("click", _onRoomsListClick);
  roomsList.addEventListener("change", _onRoomsListChange);

  // 3. Add-room dropdown (rebuilt each refresh, so wire it fresh here too)
  _wireAddRoomRow();

  // 4. Group payment fields (method + conditional reference, status + conditional deposit)
  renderPaymentFields("ci-payment-fields", "cash");
  renderPaymentStatusFields("ci-payment-status-fields", "paid");
  paymentFieldsContainer.addEventListener("input", () => validationMsg.classList.add("hidden"));
  paymentFieldsContainer.addEventListener("change", () => validationMsg.classList.add("hidden"));
  const paymentStatusContainer = document.getElementById("ci-payment-status-fields");
  paymentStatusContainer.addEventListener("input", () => validationMsg.classList.add("hidden"));
  paymentStatusContainer.addEventListener("payment-status-change", () => validationMsg.classList.add("hidden"));

  // 5. Final Save
  saveBtn.addEventListener("click", () => {
    // Reservation-conflict two-tap: a conflict never blocks the save
    // outright, it just requires a second tap — same in-place confirm
    // pattern as CheckOutModal.js's delete-booking button, rather than
    // a native window.confirm() popup.
    const conflicts = _getActiveConflicts();
    if (conflicts.length > 0 && !_pendingCheckInConfirm) {
      _pendingCheckInConfirm = true;
      _updateSaveButtonLabel();
      clearTimeout(_conflictConfirmTimeout);
      _conflictConfirmTimeout = setTimeout(() => {
        _pendingCheckInConfirm = false;
        _updateSaveButtonLabel();
      }, 3000);
      return;
    }
    _pendingCheckInConfirm = false;
    clearTimeout(_conflictConfirmTimeout);

    const guestName = guestInput.value.trim();
    const nights = Number(nightsInput.value);

    const paymentMethod = document.getElementById(PAYMENT_METHOD_SELECT_ID)?.value ?? "cash";
    const referenceInput = document.getElementById(PAYMENT_REFERENCE_INPUT_ID);
    const reference = referenceInput ? referenceInput.value.trim() : "";

    const paymentStatus = document.getElementById(PAYMENT_STATUS_SELECT_ID)?.value ?? "paid";
    const depositInput = document.getElementById(PAYMENT_DEPOSIT_INPUT_ID);
    const depositAmount = depositInput ? Number(depositInput.value) : 0;

    const { valid, message } = validatePayment(paymentMethod, reference);
    if (!valid) {
      validationMsg.textContent = message;
      validationMsg.classList.remove("hidden");
      referenceInput?.focus();
      return;
    }

    // Compute each room's grand_total up front so both the deposit
    // validation and the proportional split below use the exact same
    // numbers — grand_total = charged_rate × nights per room.
    const preliminaryRooms = _activeGroup.map((room) => {
      const chargedRate = Number(_rateSelections[room.room_name] ?? room.base_rate);
      return { room_name: room.room_name, grand_total: chargedRate * nights };
    });
    const groupGrandTotal = preliminaryRooms.reduce((sum, r) => sum + r.grand_total, 0);

    const statusCheck = validatePaymentStatus(paymentStatus, depositAmount, groupGrandTotal);
    if (!statusCheck.valid) {
      validationMsg.textContent = statusCheck.message;
      validationMsg.classList.remove("hidden");
      depositInput?.focus();
      return;
    }

    validationMsg.classList.add("hidden");

    // One Client_Booking_Ref per group, generated here and stamped onto
    // every room below — including rooms that were added mid-session via
    // "+ Add Room", since they're already in _activeGroup by the time
    // Save is clicked. This is what lets a multi-room stay be found again
    // later (e.g. CheckOutModal's sibling lookup) using a single shared
    // field instead of a manually-typed reference.
    const clientBookingRef = _generateClientBookingRef(guestName);

    // NOTE: rate_variance / grand_total are included here for any caller
    // that still wants them for local UI math (e.g. a receipt preview),
    // but api.js's bulkCheckIn() strips both before writing to Airtable,
    // since those are formula fields computed server-side.
    const roomsData = _activeGroup.map((room) => {
      const roomType = _roomTypeSelections[room.room_name] ?? room.room_type;
      const chargedRate = Number(_rateSelections[room.room_name] ?? room.base_rate);
      const baseRate = Number(room.base_rate);
      const grandTotal = chargedRate * nights;

      // Allocate a partial deposit across rooms proportionally by each
      // room's own grand_total share of the group total.
      const amountPaid =
        paymentStatus === "paid"
          ? grandTotal
          : paymentStatus === "unpaid"
            ? 0
            : Math.round((depositAmount * grandTotal) / groupGrandTotal);

      return {
        room_name: room.room_name,
        guest_name: guestName,
        nights,
        room_type: roomType,
        base_rate: baseRate,
        charged_rate: chargedRate,
        rate_variance: chargedRate - baseRate,
        grand_total: grandTotal,
        Client_Booking_Ref: clientBookingRef,
        payment_status: paymentStatus,
        amount_paid: amountPaid
      };
    });

    _onCheckInCallback?.({
      rooms: roomsData,
      payment_method: paymentMethod,
      payment_reference: reference || null,
      created_by: "system",
      Client_Booking_Ref: clientBookingRef
    });
  });

  // Initial state
  saveBtn.disabled = true;
}

// ─────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────

/**
 * Opens the slide-out modal for one or more AVAILABLE rooms, and lets
 * the user extend the group afterwards via an "Add Room" dropdown.
 *
 * @param {Object[]} rooms
 * @param {{
 *   onCheckIn: Function,          // ({ rooms, payment_method, payment_reference, created_by }) => void
 *   ownerMode?: boolean,          // Pass true to bypass explanation logs for lower rates
 *   getAvailableRooms: (excludedRoomNames: string[]) => Object[],
 *     // Returns the current list of rooms that could still be added —
 *     // main.js owns state.js, so it's the one deciding what "available"
 *     // means (status === 'available' and not already in the group).
 *   getReservationConflicts?: ({ categoryId, checkInDate, nights, excludeRoomName }) =>
 *     { hasConflict: boolean, shortBy: number, reservations: Object[] }
 *     // Optional. When supplied, backs the warning banner + two-tap
 *     // "Check In Anyway" Save button for rooms whose category is short
 *     // on inventory for pending website reservations.
 * }} callbacks
 */
export function openModal(rooms, { onCheckIn, ownerMode = false, getAvailableRooms, getReservationConflicts }) {
  const modal = document.getElementById("checkin-modal");
  const overlay = document.getElementById("modal-overlay");
  if (!modal || !overlay) return;
  if (!Array.isArray(rooms) || rooms.length === 0) return;

  // Reset module state for this open
  _activeGroup = [...rooms];
  _roomTypeSelections = {};
  _rateSelections = {};
  rooms.forEach((room) => {
    _roomTypeSelections[room.room_name] = room.room_type;
    _rateSelections[room.room_name] = room.base_rate;
  });
  _onCheckInCallback = onCheckIn;
  _getAvailableRoomsCallback = typeof getAvailableRooms === "function" ? getAvailableRooms : () => [];
  _getReservationConflictsCallback =
    typeof getReservationConflicts === "function" ? getReservationConflicts : null;
  _ownerMode = ownerMode;
  _pendingCheckInConfirm = false;
  clearTimeout(_conflictConfirmTimeout);
  _conflictConfirmTimeout = null;

  // Inject HTML
  modal.innerHTML = _buildCheckInForm();

  // Wire interactivity
  _wireCheckInForm();
  _renderConflictBanner();

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
  const modal = document.getElementById("checkin-modal");
  const overlay = document.getElementById("modal-overlay");
  if (!modal || !overlay) return;

  modal.classList.add("translate-x-full");
  overlay.classList.replace("opacity-100", "opacity-0");

  setTimeout(() => {
    overlay.classList.add("hidden");
    modal.innerHTML = "";
  }, 300);

  _activeGroup = [];
  _roomTypeSelections = {};
  _rateSelections = {};
  _onCheckInCallback = null;
  _getAvailableRoomsCallback = null;
  _getReservationConflictsCallback = null;
  _pendingCheckInConfirm = false;
  clearTimeout(_conflictConfirmTimeout);
  _conflictConfirmTimeout = null;
}