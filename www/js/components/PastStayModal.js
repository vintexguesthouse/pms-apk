/**
 * js/components/PastStayModal.js
 * ─────────────────────────────────────────────────────
 * Logs an already-completed stay (paper record entered late) — arrival
 * AND departure both already happened. This is deliberately a *separate*
 * flow from CheckInModal's backdated-check-in toggle:
 *
 * - CheckInModal's backdate toggle: guest is still in the room today.
 *   Flips live room state to occupied.
 * - This modal: the whole stay is over. NEVER touches live room state —
 *   no patchRoom, no bulkPatchRooms, no RoomCard re-render trigger. Its
 *   only side effect on success is telling the caller to refresh
 *   Booking History.
 *
 * Room selection here is a plain checklist of the 14 named rooms
 * (ROOM_DEFINITIONS, injected by main.js as `roomDefinitions` — this
 * file stays ignorant of state.js and main.js, same as CheckInModal.js,
 * and never touches the live RoomCard grid), NOT the live rooms grid —
 * a paper record from days ago has nothing to do with today's occupancy.
 *
 * Unlike CheckInModal, this component calls services/api.js's
 * logPastStay() directly on submit (rather than delegating the write to
 * a callback into main.js), since there is no live-state orchestration
 * needed on success — just a Booking History refetch.
 *
 * Exports:
 * - openModal(roomDefinitions, callbacks)
 * - closeModal()
 */

import { logPastStay } from "../services/api.js";
import { validateBackdateDate, generateClientBookingRef } from "./CheckInModal.js";
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
// Module-level state — only one instance of this modal is ever open at
// a time, same reasoning as CheckInModal.js.
// ─────────────────────────────────────────────────────

let _roomDefinitions = [];          // Object[] — the full 14-room catalog, from main.js
let _selectedRoomNames = new Set(); // room_name -> selected for this past stay
let _createdBy = "unknown";
let _onSuccessCallback = null;

// Two-tap in-place confirm for the submit button, same pattern used
// throughout the PMS (CheckOutModal's delete-booking button,
// CheckInModal's "Check In Anyway") — never window.confirm().
let _pendingSubmitConfirm = false;
let _submitConfirmTimeout = null;
let _touched = false; // becomes true on first interaction; suppresses the validation message on a freshly-opened, empty form

// ─────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────

function _ksh(n) {
  if (n == null || isNaN(n)) return "—";
  return `KSH ${Number(n).toLocaleString("en-KE")}`;
}

function _safeId(roomName) {
  return String(roomName).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function _todayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function _selectedRooms() {
  return _roomDefinitions.filter((r) => _selectedRoomNames.has(r.room_name));
}

// ─────────────────────────────────────────────────────
// HTML builders
// ─────────────────────────────────────────────────────

function _buildRoomChecklist() {
  return `
    <div id="ps-room-list" class="grid grid-cols-2 gap-2">
      ${_roomDefinitions
        .map((room) => {
          const id = _safeId(room.room_name);
          const checked = _selectedRoomNames.has(room.room_name);
          return `
            <label for="ps-room-${id}"
              class="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm cursor-pointer transition-colors
                     ${checked ? "bg-brand-700 border-brand-500 text-white" : "bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500"}">
              <input id="ps-room-${id}" type="checkbox" data-room="${room.room_name}"
                class="w-4 h-4 rounded border-gray-600 bg-gray-900 text-brand-500 focus:ring-brand-500 focus:ring-offset-0"
                ${checked ? "checked" : ""} />
              <span class="truncate">${room.room_name}</span>
            </label>
          `;
        })
        .join("")}
    </div>
  `;
}

function _buildForm() {
  return `
    <div class="flex items-center justify-between px-5 py-4 border-b border-gray-800">
      <div>
        <p class="text-xs text-gray-500 uppercase tracking-widest font-medium">Backfill</p>
        <h2 class="text-xl font-bold text-white mt-0.5">Log a Past Stay</h2>
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
        <label class="block text-xs font-semibold text-gray-400 mb-1.5" for="ps-guest-name">Guest Name</label>
        <input id="ps-guest-name" type="text" placeholder="Full name of guest"
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
                 placeholder-gray-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors" />
      </div>

      <div>
        <p class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">Rooms</p>
        ${_buildRoomChecklist()}
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-semibold text-gray-400 mb-1.5" for="ps-checkin-date">Check-in date</label>
          <input id="ps-checkin-date" type="date" value="${_todayISO()}"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
                   focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors" />
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-400 mb-1.5" for="ps-nights">Nights</label>
          <input id="ps-nights" type="number" min="1" max="30" value="1"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
                   focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors" />
        </div>
      </div>
      <p id="ps-date-error" class="text-xs text-red-400 hidden -mt-3"></p>

      <div>
        <p class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">Payment</p>
        <div id="ps-payment-status-fields" class="mb-4"></div>
        <div id="ps-payment-fields"></div>
      </div>

      <div>
        <label class="block text-xs font-semibold text-gray-400 mb-1.5" for="ps-reason">Reason for late entry</label>
        <input id="ps-reason" type="text" placeholder="e.g. Paper record found during weekly reconciliation"
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
                 placeholder-gray-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors" />
      </div>

    </div>

    <div class="px-5 py-4 border-t border-gray-800 space-y-2">
      <div id="ps-validation-msg" class="text-xs text-red-400 hidden mb-1"></div>
      <button id="ps-btn-submit" type="button"
        class="w-full py-2.5 rounded-xl font-semibold text-sm text-white bg-gradient-to-r from-brand-600 to-brand-500
               hover:from-brand-500 hover:to-brand-400
               transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
        <span id="ps-submit-btn-label">Log Past Stay</span>
      </button>
      <button id="modal-cancel-btn" type="button"
        class="w-full py-2 rounded-xl font-medium text-sm text-gray-500 hover:text-gray-300 transition-colors">
        Cancel
      </button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────

/** @returns {{ valid: boolean, message: string }} */
function _validateForm() {
  const guestName = document.getElementById("ps-guest-name")?.value.trim() ?? "";
  const nights = Number(document.getElementById("ps-nights")?.value);
  const dateStr = document.getElementById("ps-checkin-date")?.value ?? "";
  const reason = document.getElementById("ps-reason")?.value.trim() ?? "";

  if (!guestName) return { valid: false, message: "Guest name is required." };
  if (_selectedRoomNames.size === 0) return { valid: false, message: "Select at least one room." };
  if (!Number.isInteger(nights) || nights < 1) return { valid: false, message: "Enter a valid number of nights." };

  const dateCheck = validateBackdateDate(dateStr);
  if (!dateCheck.valid) return { valid: false, message: dateCheck.message };

  if (!reason) return { valid: false, message: "Enter a reason for the late entry." };

  return { valid: true, message: "" };
}

function _refreshValidationUI() {
  const submitBtn = document.getElementById("ps-btn-submit");
  const validationMsg = document.getElementById("ps-validation-msg");
  const dateError = document.getElementById("ps-date-error");
  if (!submitBtn || !validationMsg) return;

  const dateCheck = validateBackdateDate(document.getElementById("ps-checkin-date")?.value ?? "");
  if (dateError) {
    dateError.textContent = dateCheck.message;
    dateError.classList.toggle("hidden", dateCheck.valid);
  }

  const { valid, message } = _validateForm();
  submitBtn.disabled = !valid;

  if (!valid && !_pendingSubmitConfirm && _touched) {
    validationMsg.textContent = message;
    validationMsg.classList.remove("hidden");
  } else if (valid) {
    validationMsg.classList.add("hidden");
  }
}

// ─────────────────────────────────────────────────────
// Submit label / two-tap confirm
// ─────────────────────────────────────────────────────

function _updateSubmitLabel() {
  const label = document.getElementById("ps-submit-btn-label");
  if (label) label.textContent = _pendingSubmitConfirm ? "Confirm — Log Past Stay" : "Log Past Stay";
}

function _resetSubmitConfirm() {
  _pendingSubmitConfirm = false;
  clearTimeout(_submitConfirmTimeout);
  _submitConfirmTimeout = null;
  _updateSubmitLabel();
}

// ─────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────

function _wireForm() {
  const guestInput = document.getElementById("ps-guest-name");
  const nightsInput = document.getElementById("ps-nights");
  const dateInput = document.getElementById("ps-checkin-date");
  const reasonInput = document.getElementById("ps-reason");
  const roomList = document.getElementById("ps-room-list");
  const submitBtn = document.getElementById("ps-btn-submit");
  const paymentFieldsContainer = document.getElementById("ps-payment-fields");
  const paymentStatusContainer = document.getElementById("ps-payment-status-fields");
  const validationMsg = document.getElementById("ps-validation-msg");

  [guestInput, nightsInput, dateInput, reasonInput].forEach((el) => {
    el.addEventListener("input", () => {
      _touched = true;
      _resetSubmitConfirm();
      _refreshValidationUI();
    });
  });

  // Room checklist — delegated, so it stays interactive across the
  // form's whole life without per-checkbox listeners.
  roomList.addEventListener("change", (e) => {
    const checkbox = e.target.closest('input[type="checkbox"][data-room]');
    if (!checkbox) return;

    const roomName = checkbox.dataset.room;
    if (checkbox.checked) _selectedRoomNames.add(roomName);
    else _selectedRoomNames.delete(roomName);

    const label = checkbox.closest("label");
    if (label) {
      label.classList.toggle("bg-brand-700", checkbox.checked);
      label.classList.toggle("border-brand-500", checkbox.checked);
      label.classList.toggle("text-white", checkbox.checked);
      label.classList.toggle("bg-gray-800", !checkbox.checked);
      label.classList.toggle("border-gray-700", !checkbox.checked);
      label.classList.toggle("text-gray-300", !checkbox.checked);
    }

    _touched = true;
    _resetSubmitConfirm();
    _refreshValidationUI();
  });

  // Payment fields
  renderPaymentFields("ps-payment-fields", "cash");
  renderPaymentStatusFields("ps-payment-status-fields", "paid");
  paymentFieldsContainer.addEventListener("input", () => validationMsg.classList.add("hidden"));
  paymentFieldsContainer.addEventListener("change", () => validationMsg.classList.add("hidden"));
  paymentStatusContainer.addEventListener("input", () => validationMsg.classList.add("hidden"));
  paymentStatusContainer.addEventListener("payment-status-change", () => validationMsg.classList.add("hidden"));

  // Submit — two-tap in-place confirm, same pattern as CheckInModal's
  // conflict-override Save button and BookingHistory's delete button.
  submitBtn.addEventListener("click", async () => {
    const { valid, message } = _validateForm();
    if (!valid) {
      _touched = true;
      validationMsg.textContent = message;
      validationMsg.classList.remove("hidden");
      return;
    }

    if (!_pendingSubmitConfirm) {
      _pendingSubmitConfirm = true;
      _updateSubmitLabel();
      validationMsg.classList.add("hidden");
      clearTimeout(_submitConfirmTimeout);
      _submitConfirmTimeout = setTimeout(_resetSubmitConfirm, 3000);
      return;
    }

    clearTimeout(_submitConfirmTimeout);
    _submitConfirmTimeout = null;
    submitBtn.disabled = true;
    document.getElementById("ps-submit-btn-label").textContent = "Saving…";

    const guestName = guestInput.value.trim();
    const nights = Number(nightsInput.value);
    const checkInDateStr = dateInput.value;
    const reason = reasonInput.value.trim();

    const paymentMethod = document.getElementById(PAYMENT_METHOD_SELECT_ID)?.value ?? "cash";
    const referenceInput = document.getElementById(PAYMENT_REFERENCE_INPUT_ID);
    const reference = referenceInput ? referenceInput.value.trim() : "";

    const paymentStatus = document.getElementById(PAYMENT_STATUS_SELECT_ID)?.value ?? "paid";
    const depositInput = document.getElementById(PAYMENT_DEPOSIT_INPUT_ID);
    const depositAmount = depositInput ? Number(depositInput.value) : 0;

    const paymentCheck = validatePayment(paymentMethod, reference);
    if (!paymentCheck.valid) {
      _resetSubmitConfirm();
      submitBtn.disabled = false;
      validationMsg.textContent = paymentCheck.message;
      validationMsg.classList.remove("hidden");
      referenceInput?.focus();
      return;
    }

    const rooms = _selectedRooms();
    const preliminary = rooms.map((room) => ({
      room_name: room.room_name,
      grand_total: Number(room.base_rate) * nights
    }));
    const groupGrandTotal = preliminary.reduce((sum, r) => sum + r.grand_total, 0);

    const statusCheck = validatePaymentStatus(paymentStatus, depositAmount, groupGrandTotal);
    if (!statusCheck.valid) {
      _resetSubmitConfirm();
      submitBtn.disabled = false;
      validationMsg.textContent = statusCheck.message;
      validationMsg.classList.remove("hidden");
      depositInput?.focus();
      return;
    }

    // One Client_Booking_Ref shared across every selected room, same
    // as a normal group check-in — generated from the entered
    // check-in date so month-grouping in Booking History is correct.
    const clientBookingRef = generateClientBookingRef(guestName, checkInDateStr);

    const recordsArray = rooms.map((room) => {
      const baseRate = Number(room.base_rate);
      const grandTotal = baseRate * nights;
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
        check_in: checkInDateStr,
        room_type: room.room_type,
        base_rate: baseRate,
        charged_rate: baseRate,
        payment_status: paymentStatus,
        payment_method: paymentMethod,
        payment_reference: reference || null,
        amount_paid: amountPaid,
        shop_charge: 0,
        is_active: false,
        is_backdated: true,
        late_entry_reason: reason,
        created_by: _createdBy,
        Client_Booking_Ref: clientBookingRef
      };
    });

    const result = await logPastStay(recordsArray);

    if (!result.ok && !result.partial) {
      _resetSubmitConfirm();
      submitBtn.disabled = false;
      document.getElementById("ps-submit-btn-label").textContent = "Log Past Stay";
      validationMsg.textContent = result.error ?? "Failed to save. Please try again.";
      validationMsg.classList.remove("hidden");
      return;
    }

    closeModal();
    _onSuccessCallback?.(result);
  });
}

// ─────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────

/**
 * Opens the "Log a Past Stay" modal.
 *
 * @param {Object[]} roomDefinitions - The full 14-room catalog
 *   (main.js's ROOM_DEFINITIONS), used to render the checklist and to
 *   look up each selected room's room_type/base_rate on submit. This
 *   is intentionally the static catalog, not the live rooms grid — a
 *   fully-closed paper stay has no bearing on any room's status today.
 * @param {{
 *   createdBy?: string,
 *   onSuccess?: (result: Object) => void
 *     // Called after a successful (or partially successful) save.
 *     // The only thing this modal expects the caller to do with it is
 *     // refresh Booking History — this file never touches room state.
 * }} callbacks
 */
export function openModal(roomDefinitions, { createdBy, onSuccess } = {}) {
  const modal = document.getElementById("past-stay-modal");
  const overlay = document.getElementById("modal-overlay");
  if (!modal || !overlay) return;
  if (!Array.isArray(roomDefinitions) || roomDefinitions.length === 0) return;

  _roomDefinitions = roomDefinitions;
  _selectedRoomNames = new Set();
  _createdBy = createdBy ?? "unknown";
  _onSuccessCallback = typeof onSuccess === "function" ? onSuccess : null;
  _pendingSubmitConfirm = false;
  clearTimeout(_submitConfirmTimeout);
  _submitConfirmTimeout = null;
  _touched = false;

  modal.innerHTML = _buildForm();
  _wireForm();
  _refreshValidationUI();

  document.getElementById("modal-close-btn")?.addEventListener("click", closeModal);
  document.getElementById("modal-cancel-btn")?.addEventListener("click", closeModal);

  overlay.classList.add("backdrop-blur-sm", "bg-black/50");
  requestAnimationFrame(() => {
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => {
      overlay.classList.replace("opacity-0", "opacity-100");
      modal.classList.remove("translate-x-full");
    });
  });

  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };
}

/** Closes the modal with animation and clears module state. */
export function closeModal() {
  const modal = document.getElementById("past-stay-modal");
  const overlay = document.getElementById("modal-overlay");
  if (!modal || !overlay) return;

  modal.classList.add("translate-x-full");
  overlay.classList.replace("opacity-100", "opacity-0");

  setTimeout(() => {
    overlay.classList.add("hidden");
    modal.innerHTML = "";
  }, 300);

  _roomDefinitions = [];
  _selectedRoomNames = new Set();
  _createdBy = "unknown";
  _onSuccessCallback = null;
  _pendingSubmitConfirm = false;
  clearTimeout(_submitConfirmTimeout);
  _submitConfirmTimeout = null;
  _touched = false;
}
