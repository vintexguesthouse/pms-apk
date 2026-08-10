// services/api.js (PMS)
//
// Was: talks to Airtable directly, PAT shipped to every browser, and
// did its own batch-chunking / field-sanitizing client-side before
// writing to Airtable.
// Now: talks to the Cloudflare Worker gateway, which owns the PAT,
// the batching, and the field sanitizing. Every exported function
// here keeps its original name and return shape — nothing that calls
// these functions elsewhere in the PMS needs to change.

import { getSessionToken, clearSession } from "./auth.js";

// Must match the GATEWAY_URL used in services/auth.js.
const GATEWAY_URL = "https://api.vintexguesthouse.com";

function _logPayload(action, payload) {
  console.log(`%c[Vintex API] Outgoing Request: ${action}`, "color: #007bff; font-weight: bold;");
  console.log(JSON.stringify(payload, null, 2));
}

function _authHeaders() {
  const token = getSessionToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

/**
 * Shared fetch wrapper for every staff route. Returns the gateway's
 * response body as-is (already shaped like { ok, ...data } or
 * { ok: false, error }), so each exported function below is mostly
 * just "call this with the right path/method/body."
 *
 * A 401 means the session token is missing/expired/invalid — that's
 * handled here once, centrally, instead of in every caller: the stale
 * session is cleared and the page reloads back to the PIN screen,
 * same as a manual logout would.
 */
async function _apiFetch(path, options = {}) {
  try {
    const response = await fetch(`${GATEWAY_URL}${path}`, {
      ...options,
      headers: { ..._authHeaders(), ...(options.headers || {}) }
    });

    if (response.status === 401) {
      clearSession();
      window.location.reload();
      return { ok: false, error: "Session expired. Please log in again." };
    }

    const data = await response.json().catch(() => null);
    if (!data) return { ok: false, error: `HTTP ${response.status}: could not parse response.` };
    return data;
  } catch (err) {
    console.error("[Vintex API]", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Rooms / Bookings ──────────────────────────────────

// 1. FETCH ROOMS
export async function fetchRooms() {
  return _apiFetch("/api/rooms");
}

// 2. CHECK IN
export async function checkIn(payload) {
  return _apiFetch("/api/checkin", { method: "POST", body: JSON.stringify(payload) });
}

/**
 * Bulk-creates booking records for a group check-in. The Worker does
 * the 10-per-batch chunking against Airtable now — this just sends
 * the whole array in one request.
 * @param {Object[]} recordsArray
 */
export async function bulkCheckIn(recordsArray) {
  if (!Array.isArray(recordsArray) || recordsArray.length === 0) {
    return { ok: false, error: "bulkCheckIn requires a non-empty array of booking records." };
  }
  _logPayload("POST /api/checkin/bulk", recordsArray);
  return _apiFetch("/api/checkin/bulk", {
    method: "POST",
    body: JSON.stringify({ records: recordsArray })
  });
}

// 3. CHECK OUT
export async function checkOut(airtableId, payload) {
  return _apiFetch("/api/checkout", {
    method: "POST",
    body: JSON.stringify({ airtableId, ...payload })
  });
}

/**
 * Bulk-closes booking records for a group checkout. Same shared
 * `payload` fields applied to every id — the Worker chunks it.
 * @param {string[]} bookingIds
 * @param {Object} payload
 */
export async function bulkCheckOut(bookingIds, payload) {
  if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
    return { ok: false, error: "bulkCheckOut requires a non-empty array of booking ids." };
  }
  _logPayload("POST /api/checkout/bulk", { bookingIds, payload });
  return _apiFetch("/api/checkout/bulk", {
    method: "POST",
    body: JSON.stringify({ bookingIds, payload })
  });
}

// 4. FETCH BOOKINGS
export async function fetchBookings() {
  return _apiFetch("/api/bookings");
}

// EXTEND BOOKING — backs the "Extend Stay" action in CheckOutModal.js
export async function extendBooking(airtableId, nights) {
  return _apiFetch(`/api/bookings/${airtableId}/extend`, {
    method: "PATCH",
    body: JSON.stringify({ nights: Number(nights) })
  });
}

// ── Shop line items ───────────────────────────────────

// 5. ADD SHOP LINE ITEM
export async function addShopLineItem(payload) {
  _logPayload("POST /api/shop-line-items", payload);
  return _apiFetch("/api/shop-line-items", { method: "POST", body: JSON.stringify(payload) });
}

/**
 * Fetches shop line-item rows. With no arguments, fetches every row.
 * Pass `bookingId` to scope the fetch to a single booking.
 * @param {{ bookingId?: string }} [opts]
 */
export async function fetchShopLineItems({ bookingId } = {}) {
  const query = bookingId ? `?bookingId=${encodeURIComponent(bookingId)}` : "";
  return _apiFetch(`/api/shop-line-items${query}`);
}

/**
 * Deletes shop_line_items rows by id. The Worker chunks this into
 * batches of 10 against Airtable.
 * @param {string[]} lineItemIds
 */
export async function deleteShopLineItems(lineItemIds) {
  if (!Array.isArray(lineItemIds) || lineItemIds.length === 0) {
    return { ok: true, deleted_ids: [] };
  }
  return _apiFetch("/api/shop-line-items", {
    method: "DELETE",
    body: JSON.stringify({ ids: lineItemIds })
  });
}

// ── Delete booking ────────────────────────────────────

/**
 * Deletes a single booking record. Pair with deleteShopLineItems() for
 * its shop_line_items rows — same orchestration as before, still lives
 * in main.js's _deleteBookingAndCleanup().
 * @param {string} airtableId
 */
export async function deleteBooking(airtableId) {
  return _apiFetch(`/api/bookings/${airtableId}`, { method: "DELETE" });
}

// ── Reservations (website bookings) ──────────────────

// 10. FETCH RESERVATIONS
export async function fetchReservations() {
  return _apiFetch("/api/reservations");
}

// 11. FETCH RESERVATION LINE ITEMS
export async function fetchReservationLineItems() {
  return _apiFetch("/api/reservation-line-items");
}

// 12. PATCH RESERVATION LINE ITEM
export async function patchReservationLineItem(lineItemId, { status, ...rest }) {
  const fields = { ...rest };
  if (status !== undefined) fields.status = status; // translated to status_reading server-side
  return _apiFetch(`/api/reservation-line-items/${lineItemId}`, {
    method: "PATCH",
    body: JSON.stringify(fields)
  });
}

// 13. PATCH RESERVATION
export async function patchReservation(reservationId, { status, ...rest }) {
  const fields = { ...rest };
  if (status !== undefined) fields.status = status;
  return _apiFetch(`/api/reservations/${reservationId}`, {
    method: "PATCH",
    body: JSON.stringify(fields)
  });
}

// ── Expenses ──────────────────────────────────────────

// 6. FETCH EXPENSES
export async function fetchExpenses() {
  return _apiFetch("/api/expenses");
}

// 7. ADD EXPENSE
export async function addExpenseAPI(payload) {
  _logPayload("POST /api/expenses", payload);
  return _apiFetch("/api/expenses", { method: "POST", body: JSON.stringify(payload) });
}

// 8. PATCH EXPENSE
export async function patchExpenseAPI(expenseId, payload) {
  return _apiFetch(`/api/expenses/${expenseId}`, { method: "PATCH", body: JSON.stringify(payload) });
}

// 9. DELETE EXPENSE
export async function deleteExpenseAPI(expenseId) {
  return _apiFetch(`/api/expenses/${expenseId}`, { method: "DELETE" });
}