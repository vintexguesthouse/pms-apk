/**
 * js/services/state.js
 * ─────────────────────────────────────────────────────
 * Centralized in-memory state for Vintex Guest House SPA.
 * Acts as a single source of truth — no localStorage, no
 * IndexedDB; all state lives for the session duration.
 *
 * Consumers should call getState() to read and setState()
 * to mutate, ensuring all subscribers are notified.
 *
 * v2 changes:
 *  - Added `expenses: []` to the root state tree.
 *  - Added setExpenses(), addExpense(), patchExpense(),
 *    removeExpense() convenience mutators.
 *
 * v3 changes:
 *  - Added `ui.selectedRooms: []` and `ui.isMultiSelectMode: false`
 *    to support multi-room group check-in.
 *  - Added toggleRoomSelection(), clearSelection() mutators.
 *
 * v4 changes (dynamic group bookings / bulk API):
 *  - Room shape gains `Client_Booking_Ref` — a group-level tag shared
 *    by every room in the same bulk check-in, distinct from
 *    `booking_id` (the per-room Airtable record id). This is what
 *    lets CheckOutModal_2's "Add Room" dropdown find siblings of a
 *    group booking even though each room has its own booking_id.
 *  - Room `status` gains an 'error' value, for rooms whose write
 *    failed inside a partial bulkCheckIn.
 *  - Added getRoomByName(), getAvailableRooms(), getRelatedRooms()
 *    read selectors — main.js hands these to the modals as the
 *    getAvailableRooms / getRelatedRooms callbacks so the modals
 *    never import state.js directly.
 *  - Added bulkPatchRooms() and markRoomsError() mutators so
 *    reconciling a bulkCheckIn (or a group checkOut) response updates
 *    every affected room in a single "change" emit instead of one
 *    emit per room.
 *
 * v5 changes (website reservations):
 *  - Added `reservations: []` and `reservationLineItems: []` to the
 *    root state tree, mirroring the rooms/expenses pattern.
 *  - Added setReservations(), setReservationLineItems(),
 *    patchReservationLineItem() mutators.
 *  - Added getPendingLineItemsCount() (nav badge) and
 *    getAvailableRoomsByCategory() (feeds ReservationsTab's inline
 *    room picker, same ignorant-of-state.js callback pattern
 *    getAvailableRooms/getRelatedRooms already use for the modals).
 */


/** @type {Map<string, Function[]>} event → listeners */
const _listeners = new Map();

/** @type {Object} The single state tree */
const _state = {
  /**
   * rooms: Array of room objects fetched from the backend.
   * Each room shape (as returned by the API):
   * {
   *   room_name:    string,
   *   room_type:    string,          // "Bed & Breakfast" | "Bed Only"
   *   base_rate:    number,          // Master rate in KSH
   *   status:       string,          // "available" | "occupied" | "error"
   *   guest_name:   string | null,
   *   check_in:     string | null,   // ISO date string
   *   booking_id:   string | null,   // this room's OWN Airtable booking record id
   *   Client_Booking_Ref: string | null,
   *     // Group-level tag shared by every room written in the same
   *     // bulkCheckIn call. Two rooms with the same booking_id are the
   *     // same room; two rooms with the same Client_Booking_Ref are the
   *     // same STAY. Null for legacy/solo bookings created before this
   *     // field existed, or via the single checkIn() path.
   *   charged_rate: number | null,
   *   shop_total:   number | null,
   *   shop_items:   Array  | null,   // [{name, qty, unit_price}]
   *   nights:       number | null,
   *   payment_status: string | null, // "unpaid" | "paid" — set at check-in
   *   error:        string | null,   // set when status === "error"
   * }
   */
  rooms: [],

  /**
   * activeRoom: The room currently open in the modal (or null).
   */
  activeRoom: null,

  /**
   * expenses: Array of expense objects fetched from / posted to the backend.
   * Each expense shape:
   * {
   *   expense_id:   string,          // Unique row ID from the sheet
   *   amount:       number,          // KSH
   *   category:     string,          // e.g. "Utilities", "Supplies"
   *   description:  string,
   *   created_by:   string,          // user ID who logged it
   *   created_at:   string,          // ISO date string
   * }
   */
  expenses: [],

  /**
   * reservations: Array of reservation objects (website bookings),
   * fetched from the `reservations` table.
   * Each reservation shape (as returned by the API):
   * {
   *   airtable_id:   string,
   *   guest_name:    string,
   *   guest_phone:   string,
   *   guest_email:   string | null,
   *   check_in:      string,          // ISO date string
   *   check_out:     string,          // ISO date string
   *   num_guests:    number,
   *   notes:         string | null,
   *   status:        string,          // "pending" | "confirmed" | "checked_in" | "cancelled"
   *   created_at:    string,          // ISO date string
   *   source:        string,          // "website"
   * }
   */
  reservations: [],

  /**
   * reservationLineItems: Array of reservation_line_items rows — one
   * per room category requested within a reservation. Each line item
   * shape (as returned by the API):
   * {
   *   line_item_id:   string,
   *   reservation_id: string[],       // Airtable link field → [reservation airtable_id]
   *   category_id:    string,         // matches rooms.category_id
   *   category_name:  string,
   *   quantity:       number,
   *   price_per_night_at_booking: number,
   *   status:         string,         // "pending" | "checked_in" | "cancelled"
   *   assigned_room_name:   string | null,
   *   assigned_booking_id:  string | null,  // bookings-table record id once checked in
   * }
   */
  reservationLineItems: [],

  /**
   * ui: Transient UI flags.
   */
  ui: {
    loading: true,       // Global rooms fetch-in-progress
    expensesLoading: false,
    reservationsLoading: false,
    modalOpen: false,
    activeView: 'dashboard',  // 'dashboard' | 'expenses' | 'history' | 'reservations'
    syncStatus: 'synced',
    selectedRooms: [],        // room_name[] currently selected for group check-in
    isMultiSelectMode: false, // true once at least one room has been selected
  },

  /**
   * lastSync: Timestamp (ms) of the most recent successful rooms API pull.
   */
  lastSync: null,

  /**
   * lastExpensesSync: Timestamp (ms) of the most recent successful expenses pull.
   */
  lastExpensesSync: null,

  /**
   * lastReservationsSync: Timestamp (ms) of the most recent successful
   * reservations/line-items API pull.
   */
  lastReservationsSync: null,
};

// ─────────────────────────────────────────────────────
// Core pub/sub engine
// ─────────────────────────────────────────────────────

/**
 * Subscribe to state events.
 * @param {string}   event    - Event name (e.g. "change")
 * @param {Function} callback - Receives the event payload.
 * @returns {Function}        - Unsubscribe function.
 */
export function on(event, callback) {
  if (!_listeners.has(event)) _listeners.set(event, []);
  _listeners.get(event).push(callback);

  return () => {
    const list = _listeners.get(event) ?? [];
    const idx  = list.indexOf(callback);
    if (idx !== -1) list.splice(idx, 1);
  };
}

/** @internal Emits an event to all registered listeners. */
function _emit(event, payload) {
  const list = _listeners.get(event) ?? [];
  list.forEach(fn => fn(payload));
}

// ─────────────────────────────────────────────────────
// Core mutator
// ─────────────────────────────────────────────────────

/**
 * Merges a partial state update into the tree and emits
 * a "change" event carrying the array of changed keys.
 *
 * @param {Object} partial  - Top-level keys to merge.
 * @param {string} [source] - Debug label for the caller.
 */
export function setState(partial, source = 'unknown') {
  const changedKeys = [];

  for (const [key, value] of Object.entries(partial)) {
    if (_state[key] !== value) {
      _state[key] = value;
      changedKeys.push(key);
    }
  }

  if (changedKeys.length > 0) {
    _emit('change', { changedKeys, source });
  }
}

// ─────────────────────────────────────────────────────
// Reader
// ─────────────────────────────────────────────────────

/**
 * Returns a shallow copy of the entire state tree.
 * Do not mutate nested arrays/objects directly.
 * @returns {Object}
 */
export function getState() {
  return { ..._state };
}

// ─────────────────────────────────────────────────────
// Rooms convenience mutators
// ─────────────────────────────────────────────────────

/**
 * Replaces the entire rooms array and marks sync time.
 * @param {Array} rooms
 */
export function setRooms(rooms) {
  setState(
    { rooms, lastSync: Date.now(), ui: { ..._state.ui, loading: false } },
    'setRooms'
  );
}

/**
 * Sets the room currently active in the slide-out panel.
 * Pass null to clear.
 * @param {Object|null} room
 */
export function setActiveRoom(room) {
  setState(
    { activeRoom: room, ui: { ..._state.ui, modalOpen: !!room } },
    'setActiveRoom'
  );
}

/**
 * Merges a patch object into a single room identified by room_name.
 * Also patches activeRoom if it is the same room.
 * @param {string} roomName
 * @param {Object} patch
 */
export function patchRoom(roomName, patch) {
  const rooms = _state.rooms.map(r =>
    r.room_name === roomName ? { ...r, ...patch } : r
  );
  setState({ rooms }, 'patchRoom');

  if (_state.activeRoom?.room_name === roomName) {
    setState(
      { activeRoom: { ..._state.activeRoom, ...patch } },
      'patchRoom:active'
    );
  }
}

/**
 * Merges a different patch into each of several rooms in a SINGLE
 * "change" emit, instead of calling patchRoom() in a loop (which would
 * fire one "change" event — and one grid re-render — per room).
 * Used by main.js to reconcile a bulkCheckIn response: successful
 * rooms get their booking_id / Client_Booking_Ref written in, failed
 * rooms get marked 'error', all in one state update.
 *
 * @param {Object.<string, Object>} patchesByRoomName - room_name -> patch
 */
export function bulkPatchRooms(patchesByRoomName) {
  if (!patchesByRoomName || Object.keys(patchesByRoomName).length === 0) return;

  const rooms = _state.rooms.map((r) =>
    patchesByRoomName[r.room_name] ? { ...r, ...patchesByRoomName[r.room_name] } : r
  );
  setState({ rooms }, 'bulkPatchRooms');

  const activeName = _state.activeRoom?.room_name;
  if (activeName && patchesByRoomName[activeName]) {
    setState(
      { activeRoom: { ..._state.activeRoom, ...patchesByRoomName[activeName] } },
      'bulkPatchRooms:active'
    );
  }
}

/**
 * Convenience wrapper over bulkPatchRooms() for the failure side of a
 * partial bulkCheckIn / group checkout: flags each named room 'error'
 * with an optional message, in one state update.
 *
 * @param {string[]} roomNames
 * @param {string|null} [errorMessage]
 */
export function markRoomsError(roomNames, errorMessage = null) {
  if (!Array.isArray(roomNames) || roomNames.length === 0) return;

  const patches = {};
  roomNames.forEach((name) => {
    patches[name] = { status: 'error', error: errorMessage };
  });
  bulkPatchRooms(patches);
}

// ─────────────────────────────────────────────────────
// Room selectors (read-only lookups for the modal data-bridge)
// ─────────────────────────────────────────────────────
//
// CheckInModal_2 and CheckOutModal_2 are deliberately kept ignorant of
// state.js — they ask main.js "what else can I add?" via callbacks and
// render whatever comes back. These selectors are what main.js wires
// those callbacks to.

/**
 * @param {string} roomName
 * @returns {Object|null}
 */
export function getRoomByName(roomName) {
  return _state.rooms.find((r) => r.room_name === roomName) ?? null;
}

/**
 * Rooms eligible to be added to an in-progress group check-in.
 * Backs CheckInModal_2's `getAvailableRooms(excludedRoomNames)` callback.
 *
 * @param {string[]} [excludeNames]
 * @returns {Object[]}
 */
export function getAvailableRooms(excludeNames = []) {
  const { rooms } = getState();
  return _state.rooms.filter(
    (r) => r.status === 'available' && !excludeNames.includes(r.room_name)
  );
}

/**
 * Available rooms scoped to a single category_id — backs
 * ReservationsTab's inline "Assign room" picker, which must only
 * offer rooms matching the line item's category_id (e.g. only
 * garden-double rooms for a garden-double line item). Same
 * ignorant-of-state.js callback pattern as getAvailableRooms().
 *
 * @param {string} categoryId
 * @param {string[]} [excludeNames]
 * @returns {Object[]}
 */
export function getAvailableRoomsByCategory(categoryId, excludeNames = []) {
  return getAvailableRooms(excludeNames).filter((r) => r.category_id === categoryId);
}

/**
 * Returns rooms that share the same Client_Booking_Ref AND guest_name.
 * This effectively groups rooms for bulk checkout even if they have 
 * different internal booking_ids.
 */
export function getRelatedRooms(anchor, excludeNames = []) {
  if (!anchor || !anchor.Client_Booking_Ref) return [];

  const { rooms } = getState();
  
  // We no longer need to find the 'seedRoom' by booking_id
  // We use the anchor object directly as the source of truth
  return _state.rooms.filter(
    (room) =>
      room.status === 'occupied' &&
      room.Client_Booking_Ref === anchor.Client_Booking_Ref &&
      room.guest_name === anchor.guest_name &&
      !excludeNames.includes(room.room_name)
  );
}

// ─────────────────────────────────────────────────────
// Expenses convenience mutators
// ─────────────────────────────────────────────────────

/**
 * Replaces the entire expenses array and marks sync time.
 * Triggers a "change" event with key "expenses".
 * @param {Array} expenses
 */
export function setExpenses(expenses) {
  setState(
    {
      expenses,
      lastExpensesSync: Date.now(),
      ui: { ..._state.ui, expensesLoading: false },
    },
    'setExpenses'
  );
}

/**
 * Prepends a single new expense to the front of the list
 * (most-recent-first order).
 * @param {Object} expense - A fully-formed expense object.
 */
export function addExpense(expense) {
  const expenses = [expense, ..._state.expenses];
  setState({ expenses }, 'addExpense');
}

/**
 * Merges a patch object into a single expense identified by expense_id.
 * @param {string} expenseId
 * @param {Object} patch
 */
export function patchExpense(expenseId, patch) {
  const expenses = _state.expenses.map(ex =>
    ex.expense_id === expenseId ? { ...ex, ...patch } : ex
  );
  setState({ expenses }, 'patchExpense');
}

/**
 * Removes a single expense from the list by expense_id.
 * @param {string} expenseId
 */
export function removeExpense(expenseId) {
  const expenses = _state.expenses.filter(ex => ex.expense_id !== expenseId);
  setState({ expenses }, 'removeExpense');
}

/**
 * Sets the active navigation view ('dashboard' | 'expenses').
 * Triggers re-render in the view controller.
 * @param {'dashboard'|'expenses'} view
 */
export function setActiveView(view) {
  setState(
    { ui: { ..._state.ui, activeView: view } },
    'setActiveView'
  );
}

/**
 * Convenience to update only the sync status in the UI tree.
 * @param {'synced' | 'saving' | 'error'} status 
 */
export function setSyncStatus(status) {
  // We keep the existing UI state (..._state.ui) and just overwrite syncStatus
  setState({ ui: { ..._state.ui, syncStatus: status } }, 'setSyncStatus');
}

// ─────────────────────────────────────────────────────
// Multi-select convenience mutators (group check-in)
// ─────────────────────────────────────────────────────

/**
 * Adds or removes a room from the current selection by room_name.
 * Also keeps isMultiSelectMode in sync: true whenever at least one
 * room is selected, false again once the selection is emptied.
 * @param {string} roomName
 */
export function toggleRoomSelection(roomName) {
  const current = _state.ui.selectedRooms ?? [];
  const isSelected = current.includes(roomName);
  const selectedRooms = isSelected
    ? current.filter((name) => name !== roomName)
    : [...current, roomName];

  setState(
    {
      ui: {
        ..._state.ui,
        selectedRooms,
        isMultiSelectMode: selectedRooms.length > 0
      }
    },
    'toggleRoomSelection'
  );
}

/**
 * Clears the room selection and exits multi-select mode.
 * Called after a successful group check-in, or when the
 * person cancels out of the floating action bar.
 */
export function clearSelection() {
  setState(
    {
      ui: {
        ..._state.ui,
        selectedRooms: [],
        isMultiSelectMode: false
      }
    },
    'clearSelection'
  );
}

// ─────────────────────────────────────────────────────
// Reservations convenience mutators (website bookings)
// ─────────────────────────────────────────────────────

/**
 * Replaces the entire reservations array and marks sync time.
 * Triggers a "change" event with key "reservations".
 * @param {Array} reservations
 */
export function setReservations(reservations) {
  setState(
    {
      reservations,
      lastReservationsSync: Date.now(),
      ui: { ..._state.ui, reservationsLoading: false },
    },
    'setReservations'
  );
}

/**
 * Replaces the entire reservationLineItems array.
 * Triggers a "change" event with key "reservationLineItems".
 * @param {Array} items
 */
export function setReservationLineItems(items) {
  setState({ reservationLineItems: items }, 'setReservationLineItems');
}

/**
 * Merges a patch object into a single reservation line item
 * identified by line_item_id — e.g. flipping it to 'checked_in' and
 * recording the room/booking it was assigned to once
 * patchReservationLineItem() (api.js) confirms the write.
 * @param {string} lineItemId
 * @param {Object} patch
 */
export function patchReservationLineItem(lineItemId, patch) {
  const reservationLineItems = _state.reservationLineItems.map((li) =>
    li.line_item_id === lineItemId ? { ...li, ...patch } : li
  );
  setState({ reservationLineItems }, 'patchReservationLineItem');
}

/**
 * Merges a patch object into a single reservation identified by
 * airtable_id — mirrors patchReservationLineItem() above, but for the
 * parent reservation record itself (Confirm/Cancel at that level).
 * @param {string} reservationId
 * @param {Object} patch
 */
export function patchReservation(reservationId, patch) {
  const reservations = _state.reservations.map((r) =>
    r.airtable_id === reservationId ? { ...r, ...patch } : r
  );
  setState({ reservations }, 'patchReservation');
}

/**
 * Count of reservation line items still awaiting a room — backs the
 * numeric badge on the Reservations nav link.
 * @returns {number}
 */
export function getPendingLineItemsCount() {
  return _state.reservationLineItems.filter((li) => li.status === 'pending').length;
}

// ─────────────────────────────────────────────────────
// Reservation-conflict check (PMS front-desk warning)
// ─────────────────────────────────────────────────────
//
// Backs CheckInModal_2's warning banner: before the front desk commits
// a room in a given category to a walk-in, this tells them whether
// doing so would leave too few rooms of that category free to cover
// pending/confirmed website reservations for overlapping dates. This
// is a WARNING only — see the two-tap "Check In Anyway" Save button in
// CheckInModal.js — never a hard block.

/** Normalizes an ISO date (or timestamp) string to a Date at local midnight. */
function _dateOnly(isoLike) {
  const datePart = String(isoLike).slice(0, 10);
  return new Date(`${datePart}T00:00:00`);
}

/** Returns a new Date `days` after `date`. */
function _addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + (Number(days) || 0));
  return d;
}

/**
 * Overlap test for two [start, end) date ranges. Same-day turnover is
 * free, so both sides use a strict inequality.
 */
function _rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Checks whether checking a room into `categoryId` for
 * [checkInDate, checkInDate + nights) would leave enough of that
 * category free to cover pending/confirmed website reservations that
 * overlap the same dates.
 *
 * Occupancy comes straight from `_state.rooms` (status === 'occupied',
 * using each room's own check_in/nights) — the same source
 * getAvailableRooms()/getRelatedRooms() already read — not a separate
 * bookings fetch.
 *
 * @param {{
 *   categoryId: string,
 *   checkInDate: string,       // ISO date, the day this room is being checked in
 *   nights: number,
 *   excludeRoomName?: string,  // the room currently being checked in
 * }} params
 * @returns {{
 *   hasConflict: boolean,
 *   shortBy: number,
 *   reservations: Array<{ guestName: string, checkIn: string, checkOut: string, quantity: number }>
 * }}
 */
export function getReservationConflicts({ categoryId, checkInDate, nights, excludeRoomName }) {
  const { rooms, reservations, reservationLineItems } = getState();

  const proposedStart = _dateOnly(checkInDate);
  const proposedEnd = _addDays(proposedStart, nights);

  const categoryRooms = rooms.filter((r) => r.category_id === categoryId);
  const totalUnits = categoryRooms.length;

  // This room itself (about to become occupied) takes one unit out of
  // the pool, plus any OTHER occupied room in the category whose stay
  // overlaps the same dates.
  const isRoomInCategory = categoryRooms.some((r) => r.room_name === excludeRoomName);
  const otherOccupiedOverlapping = categoryRooms.filter((r) => {
    if (r.room_name === excludeRoomName) return false;
    if (r.status !== 'occupied') return false;
    if (!r.check_in || !r.nights) return false;
    const occStart = _dateOnly(r.check_in);
    const occEnd = _addDays(occStart, r.nights);
    return _rangesOverlap(proposedStart, proposedEnd, occStart, occEnd);
  });

  const roomsLeft = Math.max(
    0,
    totalUnits - (isRoomInCategory ? 1 : 0) - otherOccupiedOverlapping.length
  );

  const reservationsById = new Map(reservations.map((r) => [r.airtable_id, r]));

  const overlappingLineItems = reservationLineItems.filter((li) => {
    if (li.category_id !== categoryId) return false;
    if (li.status !== 'pending' && li.status !== 'confirmed') return false;
    const reservationId = Array.isArray(li.reservation_id) ? li.reservation_id[0] : li.reservation_id;
    const reservation = reservationsById.get(reservationId);
    if (!reservation || !reservation.check_in || !reservation.check_out) return false;
    const resStart = _dateOnly(reservation.check_in);
    const resEnd = _dateOnly(reservation.check_out);
    return _rangesOverlap(proposedStart, proposedEnd, resStart, resEnd);
  });

  const quantityNeeded = overlappingLineItems.reduce((sum, li) => sum + (Number(li.quantity) || 0), 0);
  const shortBy = Math.max(0, quantityNeeded - roomsLeft);

  const reservationsList = overlappingLineItems.map((li) => {
    const reservationId = Array.isArray(li.reservation_id) ? li.reservation_id[0] : li.reservation_id;
    const reservation = reservationsById.get(reservationId);
    return {
      guestName: reservation?.guest_name ?? 'Unknown guest',
      checkIn: reservation?.check_in ?? null,
      checkOut: reservation?.check_out ?? null,
      quantity: Number(li.quantity) || 0
    };
  });

  return { hasConflict: shortBy > 0, shortBy, reservations: reservationsList };
}