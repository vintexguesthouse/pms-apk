/**
 * js/main.js
 * ─────────────────────────────────────────────────────
 * Vintex Guest House — Main Application Entry Point v2
 *
 * Responsibilities:
 * 1.  Bootstrap behind the auth gate (initAuthGate)
 * 2.  Pull rooms + expenses from the API → push into state
 * 3.  Subscribe to state changes → re-render the active view
 * 4.  Route between Dashboard and Expenses views via nav buttons
 * 5.  Orchestrate check-in / POS / checkout callbacks (rooms)
 * 6.  Expenses view controller:
 * Attendant  → filtered list (own rows only) + add form
 * Owner      → full list + add + edit + delete
 * 7.  Inject active user ID into every API write payload
 */

import {
  getState,
  setState,
  setRooms,
  setActiveRoom,
  patchRoom,
  bulkPatchRooms,
  markRoomsError,
  setExpenses,
  addExpense,
  patchExpense,
  removeExpense,
  setActiveView,
  setSyncStatus,
  clearSelection,
  on,
  getAvailableRooms,
  getRelatedRooms,
  setReservations,
  setReservationLineItems,
  patchReservationLineItem as patchReservationLineItemState,
  patchReservation as patchReservationState,
  getPendingLineItemsCount,
  getAvailableRoomsByCategory,
  getReservationConflicts
} from "./services/state.js";

import { checkForUpdate, downloadAndInstallUpdate } from "./services/updateCheck.js";

// ADDED: Added clean D1-backed CRUD operations here
import {
  fetchRooms,
  fetchBookings,
  checkIn,
  bulkCheckIn,
  bulkCheckOut,
  extendBooking,
  addShopLineItem,
  fetchShopLineItems,
  deleteBooking,
  deleteShopLineItems,
  fetchExpenses,
  addExpenseAPI,
  patchExpenseAPI,
  deleteExpenseAPI,
  fetchReservations,
  fetchReservationLineItems,
  patchReservationLineItem as patchReservationLineItemAPI,
  patchReservation as patchReservationAPI
} from "./services/api.js";

import { initAuthGate, getActiveUser, getActiveRole, clearSession } from "./services/auth.js";
import { initLockScreen } from "./services/lockScreen.js";
import { showToast } from "./services/toast.js";

import { renderRoomsGrid } from "./components/RoomCard.js";
import { renderReservationsTab } from "./components/ReservationsTab.js";
import { openModal as openCheckInModal, closeModal as closeCheckInModal } from "./components/CheckInModal.js";
import { openModal as openPastStayModal } from "./components/PastStayModal.js";
import {
  openModal as openCheckOutModal,
  closeModal as closeCheckOutModal,
  refreshRoomTotals
} from "./components/CheckOutModal.js";

let CURRENT_ROLE = null;
let _activeRoomFilter = "all";
let _reservationsLoaded = false;

// ─────────────────────────────────────────────────────
// Room definitions (canonical local list)
// ─────────────────────────────────────────────────────

const ROOM_DEFINITIONS = [
  { room_name: "Charity", room_type: "Bed and Breakfast", base_rate: 2500 },
  { room_name: "Chastity", room_type: "Bed and Breakfast", base_rate: 4000 },
  { room_name: "Faithfulness", room_type: "Bed and Breakfast", base_rate: 5000 },
  { room_name: "Generosity", room_type: "Bed and Breakfast", base_rate: 2500 },
  { room_name: "Goodness", room_type: "Bed and Breakfast", base_rate: 4000 },
  { room_name: "Grace", room_type: "Bed and Breakfast", base_rate: 2500 },
  { room_name: "Joy", room_type: "Bed and Breakfast", base_rate: 2500 },
  { room_name: "Kindness", room_type: "Bed and Breakfast", base_rate: 2500 },
  { room_name: "Love", room_type: "Bed and Breakfast", base_rate: 4000 },
  { room_name: "Mercy", room_type: "Bed and Breakfast", base_rate: 4000 },
  { room_name: "Modesty", room_type: "Bed and Breakfast", base_rate: 4000 },
  { room_name: "Patience", room_type: "Bed and Breakfast", base_rate: 6000 },
  { room_name: "Self-Control", room_type: "Bed and Breakfast", base_rate: 2500 },
  { room_name: "Peace", room_type: "Bed and Breakfast", base_rate: 4000 }
];

// ─────────────────────────────────────────────────────
// Utility formatters
// ─────────────────────────────────────────────────────

function _ksh(n) {
  return `KSH ${Number(n ?? 0).toLocaleString("en-KE")}`;
}

function _fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-KE", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

// ─────────────────────────────────────────────────────
// Header / stats
// ─────────────────────────────────────────────────────

function _updateHeaderStats(rooms) {
  const occupied = rooms.filter((r) => r.status === "occupied").length;
  const available = rooms.length - occupied;
  document.getElementById("stat-available").textContent = available;
  document.getElementById("stat-occupied").textContent = occupied;
  document.getElementById("stat-total").textContent = rooms.length;
}

function _updateHeaderDate() {
  const el = document.getElementById("header-date");
  if (el) {
    el.textContent = new Date().toLocaleDateString("en-KE", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
    });
  }
}

function _startClock() {
  const el = document.getElementById("sidebar-clock");
  const tick = () => {
    if (el)
      el.textContent = new Date().toLocaleTimeString("en-KE", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      });
  };
  tick();
  setInterval(tick, 1000);
}

// ─────────────────────────────────────────────────────
// View routing
// ─────────────────────────────────────────────────────

const VIEW_IDS = {
  dashboard: "view-dashboard",
  expenses: "view-expenses",
  history: "view-history", // ADDED
  reservations: "view-reservations"
};

const VIEW_TITLES = {
  dashboard: "Room Dashboard",
  expenses: "Expenses Log",
  history: "Booking History", // ADDED
  reservations: "Reservations"
};

function _switchView(view) {
  Object.values(VIEW_IDS).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });

  const target = document.getElementById(VIEW_IDS[view]);
  if (target) target.classList.remove("hidden");

  const titleEl = document.getElementById("page-title");
  if (titleEl) titleEl.textContent = VIEW_TITLES[view] ?? "";

  const statsBar = document.getElementById("occupancy-stats");
  if (statsBar) {
    statsBar.style.display = view === "dashboard" ? "" : "none";
  }

  if (view === "history") {
    _renderHistoryView();
  }

  if (view === "reservations") {
    if (_reservationsLoaded) {
      _renderReservationsView();
    } else {
      _loadReservations();
    }
  }

  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });

  if (view === "expenses") {
    _loadExpenses();
  }

  setActiveView(view);
}

function _wireNavLinks() {
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      _switchView(/** @type {any} */ (btn.dataset.view));
    });
  });
}

// ─────────────────────────────────────────────────────
// Refresh button
// ─────────────────────────────────────────────────────

function _wireRefreshButton() {
  const btn = document.getElementById("btn-refresh");
  const icon = document.getElementById("refresh-icon");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    icon?.classList.add("spin-once");
    setTimeout(() => icon?.classList.remove("spin-once"), 650);

    const { ui } = getState();
    if (ui.activeView === "expenses") {
      await _loadExpenses();
    } else {
      await _loadRooms();
    }
  });
}

// ─────────────────────────────────────────────────────
// Sidebar drawer (mobile hamburger menu)
// ─────────────────────────────────────────────────────

function _wireSidebarDrawer() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  const openBtn = document.getElementById("btn-open-drawer");
  const closeBtn = document.getElementById("btn-close-drawer");
  if (!sidebar || !overlay || !openBtn) return;

  const openDrawer = () => {
    sidebar.classList.remove("-translate-x-full");
    overlay.classList.remove("hidden");
    document.body.classList.add("drawer-open");
    requestAnimationFrame(() => overlay.classList.remove("opacity-0"));
    openBtn.setAttribute("aria-expanded", "true");
  };

  const closeDrawer = () => {
    sidebar.classList.add("-translate-x-full");
    overlay.classList.add("opacity-0");
    document.body.classList.remove("drawer-open");
    openBtn.setAttribute("aria-expanded", "false");
    setTimeout(() => overlay.classList.add("hidden"), 300);
  };

  openBtn.addEventListener("click", openDrawer);
  closeBtn?.addEventListener("click", closeDrawer);
  overlay.addEventListener("click", closeDrawer);

  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (window.innerWidth < 768) closeDrawer();
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sidebar.classList.contains("-translate-x-full")) {
      closeDrawer();
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth >= 768) closeDrawer();
  });
}

function _syncHeaderHeightVar() {
  const header = document.getElementById("app-header");
  if (!header) return;
  document.documentElement.style.setProperty("--header-height", `${header.offsetHeight}px`);
}

// ─────────────────────────────────────────────────────
// Status-first filter bar
// ─────────────────────────────────────────────────────

function _applyRoomFilter(filter) {
  _activeRoomFilter = filter;
  const grid = document.getElementById("rooms-grid");
  if (!grid) return;

  grid.querySelectorAll(".room-card").forEach((card) => {
    const matches = filter === "all" || card.dataset.status === filter;
    card.classList.toggle("hidden", !matches);
  });
}

function _wireRoomFilterBar() {
  const bar = document.getElementById("room-filter-bar");
  if (!bar) return;

  bar.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      bar.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      _applyRoomFilter(btn.dataset.filter);
    });
  });
}

// ─────────────────────────────────────────────────────
// Room data loading & reconciliation
// ─────────────────────────────────────────────────────

/** Case/whitespace-insensitive key for matching a room name across
 * ROOM_DEFINITIONS (Title Case) and D1's rooms table (ALL CAPS). */
function _normalizeRoomKey(name) {
  return String(name ?? "")
    .trim()
    .toUpperCase();
}

function _mergeData(rooms, bookings, shopLineItems) {
  // D1's `rooms.room_name` is stored ALL CAPS ("CHARITY") while
  // ROOM_DEFINITIONS below uses Title Case ("Charity") — a plain Map
  // lookup between the two silently missed every single room, which is
  // why category_id (and therefore the Reservations tab's room picker)
  // always came back empty. Normalize both sides before comparing.
  const roomsByName = new Map((rooms ?? []).map((r) => [_normalizeRoomKey(r.room_name), r]));
  const activeBookingsByRoom = new Map();
  // Same normalization as roomsByName above: bookings.room_name is
  // written ALL CAPS by the gateway (sanitizeBookingFields), while
  // def.room_name below is ROOM_DEFINITIONS' Title Case. Without this,
  // the lookup a few lines down NEVER matches, so activeBooking is
  // always null and every occupied room renders as available on any
  // device other than the one that made the booking (that device only
  // looks "correct" because the local-cache fallback below happens to
  // mask the broken lookup with its own optimistic state).
  (bookings ?? [])
    .filter((b) => b.is_active === true)
    .forEach((b) => activeBookingsByRoom.set(_normalizeRoomKey(b.room_name), b));

  // Group shop line items by the booking_id they belong to, so each
  // occupied room can look up its own items in O(1) instead of
  // filtering the whole line-items array per room.
  const lineItemsByBooking = new Map();
  (shopLineItems ?? []).forEach((item) => {
    const key = item.booking_id;
    if (!key) return;
    if (!lineItemsByBooking.has(key)) lineItemsByBooking.set(key, []);
    lineItemsByBooking.get(key).push(item);
  });

  const { rooms: currentState } = getState();

  return ROOM_DEFINITIONS.map((def) => {
    const liveRoom = roomsByName.get(_normalizeRoomKey(def.room_name));
    const activeBooking = activeBookingsByRoom.get(_normalizeRoomKey(def.room_name)) ?? null;
    const local = currentState.find((r) => r.room_name === def.room_name);

    if (local && local.status === "occupied" && !activeBooking && !(liveRoom && liveRoom.status === "occupied")) {
      return local;
    }

    if (activeBooking) {
      const itemsForRoom = lineItemsByBooking.get(activeBooking.airtable_id) ?? [];
      const shopItems = itemsForRoom.map((i) => ({ name: i.item_name, qty: i.qty, unit_price: i.unit_price }));
      const shopTotal = itemsForRoom.reduce((s, i) => s + Number(i.qty ?? 0) * Number(i.unit_price ?? 0), 0);

      return {
        ...def,
        ...(liveRoom ?? {}),
        status: "occupied",
        booking_id: activeBooking.airtable_id,
        guest_name: activeBooking.guest_name,
        nights: Number(activeBooking.nights || 1),
        charged_rate: Number(activeBooking.charged_rate || def.base_rate),
        payment_status: activeBooking.payment_status || "unpaid",
        amount_paid: Number(activeBooking.amount_paid || 0),
        check_in: activeBooking.check_in || activeBooking.created_at || new Date().toISOString(),
        shop_total: shopTotal,
        shop_items: shopItems,
        // Top-level, not just nested in activeBooking — getRelatedRooms()
        // in state.js filters on room.Client_Booking_Ref directly, so it
        // has to live here or every sibling lookup silently returns [].
        Client_Booking_Ref: activeBooking.Client_Booking_Ref ?? null,
        activeBooking
      };
    }

    return {
      status: "available",
      guest_name: null,
      check_in: null,
      booking_id: null,
      charged_rate: null,
      shop_total: 0,
      shop_items: [],
      nights: null,
      payment_status: null,
      amount_paid: null,
      activeBooking: null,
      // category_id lives on the rooms table (added for the website
      // reservations feature) and isn't part of ROOM_DEFINITIONS, so
      // it has to come from the live D1 room record explicitly here —
      // ReservationsTab's per-category room picker depends on it.
      category_id: liveRoom?.category_id ?? null,
      ...def
    };
  });
}

async function _loadRooms() {
  setState({ ui: { ...getState().ui, loading: true } }, "loadRooms");
  const [roomsResult, bookingsResult, shopLineItemsResult] = await Promise.all([
    fetchRooms(),
    fetchBookings(),
    fetchShopLineItems()
  ]);

  if (!roomsResult.ok) {
    setRooms(_mergeData([], [], []));
    showToast("error", "Sync failed", roomsResult.error ?? "Could not reach the server.");
    return;
  }

  if (!bookingsResult.ok) {
    setRooms(_mergeData(roomsResult.rooms, [], []));
    showToast("error", "Bookings sync failed", bookingsResult.error ?? "Could not reach the server.");
    return;
  }

  if (!shopLineItemsResult.ok) {
    // Shop line items are supplementary — don't block the room grid on
    // them, but do surface that shop totals may be stale this cycle.
    setRooms(_mergeData(roomsResult.rooms, bookingsResult.bookings, []));
    showToast("error", "Shop items sync failed", shopLineItemsResult.error ?? "Could not reach the server.");
    return;
  }

  setRooms(_mergeData(roomsResult.rooms, bookingsResult.bookings, shopLineItemsResult.items));
}

// ─────────────────────────────────────────────────────
// Expense data loading
// ─────────────────────────────────────────────────────

async function _loadExpenses() {
  setState({ ui: { ...getState().ui, expensesLoading: true } }, "loadExpenses");

  const result = await fetchExpenses();

  if (result.ok && Array.isArray(result.expenses)) {
    setExpenses(result.expenses);
  } else {
    setExpenses([]);
    showToast("error", "Expenses sync failed", result.error ?? "Could not reach the server.");
  }
}

// ─────────────────────────────────────────────────────
// Reservations data loading (website bookings)
// ─────────────────────────────────────────────────────

async function _loadReservations() {
  setState({ ui: { ...getState().ui, reservationsLoading: true } }, "loadReservations");

  const [reservationsResult, lineItemsResult] = await Promise.all([fetchReservations(), fetchReservationLineItems()]);

  if (!reservationsResult.ok) {
    setReservations([]);
    showToast("error", "Reservations sync failed", reservationsResult.error ?? "Could not reach the server.");
    return;
  }

  if (!lineItemsResult.ok) {
    setReservations(reservationsResult.reservations);
    showToast("error", "Reservation line items sync failed", lineItemsResult.error ?? "Could not reach the server.");
    return;
  }

  _reservationsLoaded = true;
  setReservations(reservationsResult.reservations);
  setReservationLineItems(lineItemsResult.items);
}

// ─────────────────────────────────────────────────────
// Expenses view renderer
// ─────────────────────────────────────────────────────

function _renderExpenses() {
  const container = document.getElementById("expenses-container");
  if (!container) return;

  const isOwner = CURRENT_ROLE === "owner";
  const { expenses } = getState();

  const scopeLabel = document.getElementById("expenses-scope-label");
  if (scopeLabel) {
    scopeLabel.textContent = isOwner ? "(Owner View)" : "(Attendant View)";
  }

  const visible = isOwner
    ? expenses
    : expenses.filter((ex) => ex.created_by === "attendant_1" || ex.created_by === "attendant");

  const total = visible.reduce((sum, ex) => sum + Number(ex.amount ?? 0), 0);
  const totalBadge = document.getElementById("expenses-total-badge");
  if (totalBadge) {
    totalBadge.textContent = visible.length > 0 ? `Total: ${_ksh(total)}` : "";
  }

  if (visible.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center justify-center py-16 gap-3 text-center">
        <svg class="w-10 h-10 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
            d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0
               00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
        </svg>
        <p class="text-sm text-gray-600">
          ${isOwner ? "No expenses have been logged yet." : "You have not logged any expenses yet."}
        </p>
      </div>`;
    return;
  }

  container.innerHTML = visible
    .map((ex) => {
      const amount = Number(ex.amount ?? 0);
      const category = ex.category ?? "—";
      const description = ex.description ?? "—";
      const createdBy = ex.created_by ?? "—";
      const createdAt = _fmtDate(ex.created_at);

      const ownerActions = isOwner
        ? `
      <div class="flex items-center gap-1.5 ml-3 shrink-0">
        <button
          type="button"
          data-expense-id="${ex.expense_id}"
          data-action="edit"
          title="Edit expense"
          class="expense-action-btn w-7 h-7 flex items-center justify-center rounded-lg
                 bg-gray-700 hover:bg-brand-700 text-gray-400 hover:text-white
                 border border-gray-600 hover:border-brand-500 transition-colors">
          <svg class="w-3.5 h-3.5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2
                 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
        <button
          type="button"
          data-expense-id="${ex.expense_id}"
          data-action="delete"
          title="Delete expense"
          class="expense-action-btn w-7 h-7 flex items-center justify-center rounded-lg
                 bg-gray-700 hover:bg-red-800 text-gray-400 hover:text-red-300
                 border border-gray-600 hover:border-red-700 transition-colors">
          <svg class="w-3.5 h-3.5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5
                 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>`
        : "";

      return `
      <div
        data-expense-row="${ex.expense_id}"
        class="flex items-start bg-gray-900 border border-gray-800 rounded-xl px-4 py-3
               hover:border-gray-700 transition-colors">

        <div class="shrink-0 text-right min-w-[90px] mr-4">
          <p class="text-sm font-bold text-white font-mono">${_ksh(amount)}</p>
          <span class="inline-block mt-1 text-[10px] font-semibold uppercase tracking-wider
                       px-2 py-0.5 rounded-full bg-brand-900/50 text-brand-300 border border-brand-800/40">
            ${category}
          </span>
        </div>

        <div class="flex-1 min-w-0">
          <p class="text-sm text-gray-200 truncate">${description}</p>
          <div class="flex items-center gap-3 mt-1.5">
            <span class="text-xs text-gray-500 font-mono">${createdAt}</span>
            ${isOwner ? `<span class="text-xs text-gray-600">by <span class="text-gray-500">${createdBy}</span></span>` : ""}
          </div>
        </div>

        ${ownerActions}
      </div>`;
    })
    .join("");

  container.querySelectorAll(".expense-action-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const expenseId = btn.dataset.expenseId;
      const action = btn.dataset.action;
      if (action === "edit") _openEditExpenseModal(expenseId);
      if (action === "delete") _handleDeleteExpense(expenseId);
    });
  });
}

// ─────────────────────────────────────────────────────
// Expenses form — Save new expense
// ─────────────────────────────────────────────────────

function _wireExpensesForm() {
  const saveBtn = document.getElementById("btn-save-expense");
  const indicator = document.getElementById("expense-saving-indicator");
  const errorBox = document.getElementById("expense-form-error");

  if (!saveBtn) return;

  saveBtn.addEventListener("click", async () => {
    const amountEl = document.getElementById("exp-amount");
    const categoryEl = document.getElementById("exp-category");
    const descriptionEl = document.getElementById("exp-description");

    const amount = Number(amountEl?.value ?? 0);
    const category = categoryEl?.value?.trim() ?? "";
    const description = descriptionEl?.value?.trim() ?? "";

    if (amount <= 0 || !category || !description) {
      if (errorBox) {
        errorBox.textContent = "Please fill in all fields: Amount, Category, and Description.";
        errorBox.classList.remove("hidden");
      }
      return;
    }

    if (errorBox) errorBox.classList.add("hidden");

    saveBtn.disabled = true;
    if (indicator) indicator.classList.remove("hidden");

    setSyncStatus("saving");
    const activeUser = getActiveUser();

    try {
      // 1. Define it first so it's not undefined
      // Inside your add expense logic in main.js
      const expenseData = {
        amount: Number(amount),
        category: category,
        description: description,
        date: new Date().toISOString().split("T")[0],
        // 1. Auto-identify the user
        created_by: getActiveUser(),
        // 2. Add a temp ID for immediate UI feedback
        expense_id: `local_${Date.now()}`
      };

      // 2. Now you can safely log it
      console.table(expenseData);

      // 3. Now send it
      const result = await addExpenseAPI(expenseData);

      if (result.ok) {
        setSyncStatus("synced");

        addExpense({
          expense_id: result.expense_id ?? `local_${Date.now()}`,
          ...expenseData // This contains amount, category, description, and date
        });

        if (amountEl) amountEl.value = "";
        if (categoryEl) categoryEl.value = "";
        if (descriptionEl) descriptionEl.value = "";

        showToast("success", "Expense saved", `${_ksh(amount)} — ${category}`);
        _renderExpenses();
      } else {
        setSyncStatus("error");
        if (errorBox) {
          errorBox.textContent = result.error ?? "Failed to save expense.";
          errorBox.classList.remove("hidden");
        }
        showToast("error", "Save failed", result.error);
      }
    } catch (err) {
      setSyncStatus("error");
      if (errorBox) {
        errorBox.textContent = err.message;
        errorBox.classList.remove("hidden");
      }
      showToast("error", "Network error", err.message);
    } finally {
      saveBtn.disabled = false;
      if (indicator) indicator.classList.add("hidden");
    }
  });
}

// ─────────────────────────────────────────────────────
// Edit expense modal (Owner only)
// ─────────────────────────────────────────────────────

function _openEditExpenseModal(expenseId) {
  const { expenses } = getState();
  const expense = expenses.find((ex) => ex.expense_id === expenseId);
  if (!expense) return;

  const overlay = document.getElementById("edit-expense-overlay");
  const modal = document.getElementById("edit-expense-modal");

  document.getElementById("edit-expense-id").value = expense.expense_id;
  document.getElementById("edit-exp-amount").value = expense.amount;
  document.getElementById("edit-exp-category").value = expense.category;
  document.getElementById("edit-exp-description").value = expense.description;

  overlay?.classList.remove("hidden");
  modal?.classList.remove("hidden");
  requestAnimationFrame(() => overlay?.classList.replace("opacity-0", "opacity-100"));
}

function _closeEditExpenseModal() {
  const overlay = document.getElementById("edit-expense-overlay");
  const modal = document.getElementById("edit-expense-modal");
  overlay?.classList.replace("opacity-100", "opacity-0");
  setTimeout(() => {
    overlay?.classList.add("hidden");
    modal?.classList.add("hidden");
  }, 200);
}

function _wireEditExpenseModal() {
  document.getElementById("edit-expense-close")?.addEventListener("click", _closeEditExpenseModal);
  document.getElementById("edit-expense-close-btn")?.addEventListener("click", _closeEditExpenseModal);

  document.getElementById("btn-save-edit-expense")?.addEventListener("click", async () => {
    const expenseId = document.getElementById("edit-expense-id")?.value;
    const amount = Number(document.getElementById("edit-exp-amount")?.value ?? 0);
    const category = document.getElementById("edit-exp-category")?.value?.trim() ?? "";
    const description = document.getElementById("edit-exp-description")?.value?.trim() ?? "";

    if (!expenseId || amount <= 0 || !category || !description) {
      showToast("error", "Validation failed", "All fields are required.");
      return;
    }

    const saveBtn = document.getElementById("btn-save-edit-expense");
    if (saveBtn) saveBtn.disabled = true;

    try {
      // CHANGED: Swapped out old post payload with the D1 patch engine
      const result = await patchExpenseAPI(expenseId, {
        amount,
        category,
        description,
        edited_by: getActiveUser(),
        edited_at: new Date().toISOString()
      });

      if (result.ok) {
        patchExpense(expenseId, { amount, category, description });
        _closeEditExpenseModal();
        _renderExpenses();
        showToast("success", "Expense updated", `${_ksh(amount)} — ${category}`);
      } else {
        showToast("error", "Update failed", result.error);
      }
    } catch (err) {
      showToast("error", "Network error", err.message);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  });
}

// ─────────────────────────────────────────────────────
// Delete expense (Owner only)
// ─────────────────────────────────────────────────────

async function _handleDeleteExpense(expenseId) {
  if (!expenseId) return;

  const { expenses } = getState();
  const expense = expenses.find((ex) => ex.expense_id === expenseId);
  if (!expense) return;

  removeExpense(expenseId);
  _renderExpenses();
  showToast("info", "Deleting expense…", _ksh(expense.amount));

  try {
    // CHANGED: Connected delete flow straight to D1 clean record removal
    const result = await deleteExpenseAPI(expenseId);

    if (result.ok) {
      showToast("success", "Expense deleted", _ksh(expense.amount));
    } else {
      addExpense(expense);
      _renderExpenses();
      showToast("error", "Delete failed", result.error);
    }
  } catch (err) {
    addExpense(expense);
    _renderExpenses();
    showToast("error", "Network error", err.message);
  }
}

// ─────────────────────────────────────────────────────
// Room card click → modal
// ─────────────────────────────────────────────────────

function _onCardClick(room) {
  setActiveRoom(room);

  if (room.status === "available") {
    openCheckInModal([room], {
      onCheckIn: _handleCheckIn,
      // Inject the selector so the modal can find other available rooms
      getAvailableRooms: (excluded) => getAvailableRooms(excluded),
      // Lets the modal warn if this room's category is short on
      // inventory for pending website reservations.
      getReservationConflicts: (params) => getReservationConflicts(params),
      ownerMode: getActiveRole() === "owner"
    });
  } else if (room.status === "occupied") {
    openCheckOutModal(room, {
      onAddShop: _handleAddShop,
      onCheckOut: _handleCheckOut,
      onExtendNights: _handleExtendNights,
      onDeleteBooking: _handleDeleteBooking,
      // Inject the selectors
      getRelatedRooms: (anchor, excluded) => getRelatedRooms(anchor, excluded),
      getAvailableRooms: (excluded) => getAvailableRooms(excluded)
    });
  } else if (room.status === "error") {
    // A failed check-in/checkout write — not a modal-worthy state yet,
    // just point the attendant at what to do next.
    showToast(
      "info",
      "This room needs attention",
      room.error ?? "The last write to the server failed. Refresh, then retry."
    );
  }
}

// ─────────────────────────────────────────────────────
// Check-in handler
// ─────────────────────────────────────────────────────
async function _handleCheckIn(groupFormData) {
  const { rooms: roomsData, payment_method, payment_reference, checkInDate } = groupFormData;
  const created_by = getActiveUser() ?? "unknown";
  const isGroup = roomsData.length > 1;

  // Payment status/amount now come from CheckInModal.js per room (paid
  // in full / partial deposit / pay-at-checkout) instead of being
  // hardcoded — see payments.js's renderPaymentStatusFields().
  //
  // checkInDate comes from CheckInModal's backdate toggle — it's just
  // today's date for a normal check-in, or the attendant-chosen date
  // when "This check-in actually happened earlier" is on. Either way
  // the room is occupied *now*, so live room state below still flips
  // to occupied immediately regardless of which date this resolves to.
  const checkInTimestamp = checkInDate ? new Date(`${checkInDate}T00:00:00`).toISOString() : new Date().toISOString();

  setSyncStatus("saving");

  // Optimistic UI update for every room in this check-in, as a single
  // atomic state emit (one grid re-render, not one per room).
  const optimisticPatches = {};
  roomsData.forEach((formData) => {
    const paymentStatus = formData.payment_status ?? "paid";
    const amountPaid = Number(formData.amount_paid ?? 0);
    optimisticPatches[formData.room_name] = {
      status: "occupied",
      error: null,
      guest_name: formData.guest_name,
      nights: formData.nights,
      room_type: formData.room_type,
      charged_rate: formData.charged_rate,
      payment_status: paymentStatus,
      amount_paid: amountPaid,
      payment_method,
      payment_reference,
      check_in: checkInTimestamp,
      shop_total: 0,
      shop_items: [],
      // Top-level, so getRelatedRooms() can match siblings immediately —
      // same room comes back with this field from the database via
      // _mergeData() on the next poll, so it's consistent before/after sync.
      Client_Booking_Ref: formData.Client_Booking_Ref,
      activeBooking: {
        room_name: formData.room_name,
        guest_name: formData.guest_name,
        nights: formData.nights,
        room_type: formData.room_type,
        charged_rate: formData.charged_rate,
        payment_status: paymentStatus,
        amount_paid: amountPaid,
        payment_method,
        payment_reference,
        check_in: checkInTimestamp,
        shop_charge: 0,
        grand_total: formData.grand_total,
        Client_Booking_Ref: formData.Client_Booking_Ref,
        is_active: true
      }
    };
  });
  bulkPatchRooms(optimisticPatches);

  closeCheckInModal();
  clearSelection();

  const guestLabel = roomsData[0]?.guest_name ?? "guest";
  showToast("info", isGroup ? `Saving check-in for ${roomsData.length} rooms…` : "Saving check-in…", guestLabel);

  // Write the whole group via bulkCheckIn — the gateway runs this as a
  // single atomic D1 batch (all rooms succeed or none do), not chunked
  // sequential requests the way the old Airtable-backed version worked.
  // Still one request instead of firing N individual checkIn() calls.
  // NOTE: because it's now all-or-nothing, `result.failedBatches` below
  // can never actually be populated — the ok:false branch above already
  // covers every failure case. That handling is kept as a harmless no-op
  // rather than ripped out, since removing it is a separate cleanup.
  const recordsArray = roomsData.map((formData) => ({
    room_name: formData.room_name,
    guest_name: formData.guest_name,
    nights: Number(formData.nights),
    check_in: checkInTimestamp.split("T")[0], // This sends "2026-06-30" instead of the full timestamp
    room_type: formData.room_type,
    base_rate: Number(formData.base_rate),
    charged_rate: Number(formData.charged_rate),
    shop_charge: 0,
    payment_status: formData.payment_status ?? "paid",
    amount_paid: Number(formData.amount_paid ?? 0),
    payment_method,
    payment_reference,
    is_active: true,
    created_by,
    // Same ref CheckInModal generated for the whole group — this is
    // the anchor state.js/CheckOutModal use to find sibling rooms.
    Client_Booking_Ref: formData.Client_Booking_Ref,
    // Only present when CheckInModal's backdate toggle was on — omit
    // rather than send is_backdated: false, matching the field's
    // hasOwnProperty-gated pass-through in sanitizeBookingFields.
    ...(formData.is_backdated ? { is_backdated: true, late_entry_reason: formData.late_entry_reason } : {})
  }));

  const result = await bulkCheckIn(recordsArray);

  if (!result.ok) {
    // Total failure — nothing in the group landed in the database.
    // Flag every room 'error' rather than quietly reverting to
    // 'available', since the front desk needs to see and retry these.
    setSyncStatus("error");
    markRoomsError(
      roomsData.map((fd) => fd.room_name),
      result.error ?? "Check-in failed to save."
    );
    showToast("error", "Check-in failed", result.error ?? `${roomsData.length} room(s) could not be saved.`);
    setTimeout(_loadRooms, 3000);
    return;
  }

  // bulkCheckIn processes batches in order and only omits a room's id
  // from booking_ids if its batch failed — so filtering roomsData down
  // to the names NOT reported in any failedBatches gives back the exact
  // subset that succeeded, still in original order, ready to zip
  // against booking_ids positionally.
  const failedRoomNames = new Set((result.failedBatches ?? []).flatMap((b) => b.rooms ?? []));
  const succeededFormData = roomsData.filter((fd) => !failedRoomNames.has(fd.room_name));
  const failedFormData = roomsData.filter((fd) => failedRoomNames.has(fd.room_name));

  // Write the real booking_id into each successful room, one emit.
  const successPatches = {};
  succeededFormData.forEach((formData, idx) => {
    const bookingId = result.booking_ids?.[idx];
    if (!bookingId) return;
    const { rooms } = getState();
    const current = rooms.find((r) => r.room_name === formData.room_name);
    successPatches[formData.room_name] = {
      booking_id: bookingId,
      activeBooking: { ...(current?.activeBooking ?? {}), airtable_id: bookingId }
    };
  });
  if (Object.keys(successPatches).length > 0) bulkPatchRooms(successPatches);

  if (failedFormData.length > 0) {
    markRoomsError(
      failedFormData.map((fd) => fd.room_name),
      "Check-in failed to save — please retry."
    );
  }

  if (failedFormData.length === 0) {
    setSyncStatus("synced");
    showToast(
      "success",
      "Checked in!",
      isGroup ? `${roomsData.length} rooms → ${guestLabel}` : `${roomsData[0].room_name} → ${guestLabel}`
    );
  } else if (succeededFormData.length === 0) {
    setSyncStatus("error");
    showToast("error", "Check-in failed", result.error ?? "All rooms failed to save.");
  } else {
    setSyncStatus("error");
    showToast(
      "error",
      "Partial check-in failure",
      `${failedFormData.length} of ${roomsData.length} room(s) failed to save.`
    );
  }

  setTimeout(_loadRooms, 3000);
}

// ─────────────────────────────────────────────────────
// Extend Stay handler
// ─────────────────────────────────────────────────────

/**
 * Handles the "Update" (Extend Stay) action from CheckOutModal.js.
 * PATCHes the new nights value straight to the database, then patches
 * local state so the grid/receipt/other open views stay consistent.
 *
 * @param {Object} room
 * @param {number} newNights
 * @returns {Promise<Object|null>} the updated room, or null on failure
 */
async function _handleExtendNights(room, newNights) {
  if (!room?.booking_id) return null;

  const result = await extendBooking(room.booking_id, newNights);
  if (!result.ok) {
    throw new Error(result.error ?? "Could not extend stay.");
  }

  patchRoom(room.room_name, { nights: newNights });

  const { rooms } = getState();
  return rooms.find((r) => r.room_name === room.room_name) ?? { ...room, nights: newNights };
}

// ─────────────────────────────────────────────────────
// Delete booking handlers
// ─────────────────────────────────────────────────────

/**
 * Deletes a booking record plus any shop_line_items tied to it, so
 * deleting a booking never leaves orphaned shop rows behind. Shared by
 * both delete entry points (occupied-room checkout panel + Booking
 * History), which otherwise only differ in how they patch local state
 * afterwards.
 *
 * @param {string} bookingId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function _deleteBookingAndCleanup(bookingId) {
  const itemsResult = await fetchShopLineItems({ bookingId });
  if (itemsResult.ok && itemsResult.items.length > 0) {
    await deleteShopLineItems(itemsResult.items.map((i) => i.line_item_id));
  }
  return deleteBooking(bookingId);
}

/**
 * Deletes an ACTIVE/occupied room's booking entirely (as opposed to
 * checking it out). Called from CheckOutModal's per-room "Delete
 * booking" button. Flips the room back to "available" locally on
 * success, with no page refresh needed.
 *
 * @param {Object} room
 * @returns {Promise<boolean>}
 */
async function _handleDeleteBooking(room) {
  const bookingId = room.booking_id;
  if (!bookingId) {
    showToast("error", "Cannot delete", "This room has no booking id.");
    return false;
  }

  showToast("info", "Deleting booking…", room.room_name);
  const result = await _deleteBookingAndCleanup(bookingId);

  if (!result.ok) {
    showToast("error", "Could not delete booking", result.error);
    return false;
  }

  patchRoom(room.room_name, {
    status: "available",
    booking_id: null,
    activeBooking: null,
    guest_name: null,
    nights: null,
    charged_rate: null,
    Client_Booking_Ref: null,
    amount_paid: 0,
    payment_status: null,
    shop_items: [],
    shop_total: 0
  });

  showToast("success", "Booking deleted", `${room.room_name} is now available.`);
  return true;
}

/**
 * Deletes a HISTORICAL (already checked-out) booking. Called from
 * BookingHistory's per-row "Delete" button. Bookings aren't tracked in
 * state.js — the history table is fetched and rendered fresh each time
 * (_renderHistoryView()) — so on success this just reports back to
 * BookingHistory.js, which removes the row itself; there's no state
 * patch needed here.
 *
 * @param {Object} bookingRow - the normalized row from BookingHistory.js ({ id, guest_name, room_name, ... })
 * @returns {Promise<boolean>}
 */
async function _handleDeleteHistoryBooking(bookingRow) {
  const result = await _deleteBookingAndCleanup(bookingRow.id);

  if (!result.ok) {
    showToast("error", "Could not delete booking", result.error);
    return false;
  }

  showToast("success", "Booking deleted", `${bookingRow.guest_name} — ${bookingRow.room_name}`);
  return true;
}

// ─────────────────────────────────────────────────────
// Shop item handler
// ─────────────────────────────────────────────────────

/**
 * Shop item handler (Group-Aware, line-item backed)
 * Called by CheckOutModal.js when an item is added to a specific room.
 * Each "Add" click becomes its own row in shop_line_items — no more
 * client-computed running total PATCHed onto the booking record, which
 * used to lose updates when two "Add" clicks landed close together.
 */
async function _handleAddShop(room, { item_name, item_price, quantity }) {
  if (!room) return;
  showToast("info", "Adding item…", `${quantity}× ${item_name}`);

  const result = await addShopLineItem({
    booking_id: room.booking_id,
    Client_Booking_Ref: room.Client_Booking_Ref ?? null,
    item_name,
    qty: quantity,
    unit_price: item_price,
    created_by: getActiveUser() ?? "unknown",
    created_at: new Date().toISOString()
  });

  if (!result.ok) {
    showToast("error", "Could not add item", result.error);
    return;
  }

  const newItem = { name: item_name, unit_price: item_price, qty: quantity };
  const updatedItems = [...(room.shop_items ?? []), newItem];
  const updatedTotal = updatedItems.reduce((s, i) => s + i.qty * i.unit_price, 0);

  patchRoom(room.room_name, { shop_items: updatedItems, shop_total: updatedTotal });

  const { rooms } = getState();
  const updatedRoom = rooms.find((r) => r.room_name === room.room_name);
  if (updatedRoom) {
    refreshRoomTotals(updatedRoom);
    showToast("success", "Item added", `${quantity}× ${item_name} — ${_ksh(item_price * quantity)}`);
  }
}

// ─────────────────────────────────────────────────────
// Checkout handler
// ─────────────────────────────────────────────────────

async function _handleCheckOut(payload) {
  console.log("Processing Group Checkout:", payload);

  const { rooms: roomPayloads, payment_method, payment_reference, payment_status } = payload;

  if (!roomPayloads || roomPayloads.length === 0) return;

  // CheckOutModal.js now sends rooms as { booking_id, room_name,
  // balance_due } objects (balance_due = that room's computed
  // _roomSubtotal() at the moment checkout was submitted), not bare
  // booking_id strings — bulkCheckOut() itself still just needs the id list.
  const bookingIds = roomPayloads.map((r) => r.booking_id).filter(Boolean);
  const totalBalanceCollected = roomPayloads.reduce((sum, r) => sum + Number(r.balance_due ?? 0), 0);

  if (bookingIds.length === 0) return;

  showToast("info", `Checking out ${bookingIds.length} room${bookingIds.length !== 1 ? "s" : ""}...`);
  setSyncStatus("saving");

  // Snapshot now — used purely to map booking_id -> room_name below, and
  // that mapping doesn't change while these awaits are in flight.
  const stateRooms = getState().rooms;

  // Mirrors bulkCheckIn: the gateway runs this as a single atomic D1
  // batch (all rooms close or none do), replacing the old sequential-
  // PATCH-loop that used to bail on the first failure and leave
  // already-closed rooms stuck showing 'occupied' in local state.
  // Same note as bulkCheckIn above: `result.failedBatches` below can
  // never actually be populated now that this is all-or-nothing.
  const result = await bulkCheckOut(bookingIds, {
    payment_method,
    payment_reference,
    payment_status: payment_status ?? "paid"
  });

  if (!result.ok) {
    // Total failure — nothing in the group actually closed in the
    // database. Flag every room 'error' so the front desk sees it needs
    // a retry, instead of leaving them looking like a normal occupied room.
    setSyncStatus("error");
    const roomNames = bookingIds.map((id) => stateRooms.find((r) => r.booking_id === id)?.room_name).filter(Boolean);
    markRoomsError(roomNames, result.error ?? "Checkout failed to save.");
    showToast("error", "Checkout failed", result.error ?? "Could not check out any rooms.");
    return;
  }

  const failedIds = new Set((result.failedBatches ?? []).flatMap((b) => b.bookingIds ?? []));
  const succeededIds = bookingIds.filter((id) => !failedIds.has(id));
  const failedRoomNames = bookingIds
    .filter((id) => failedIds.has(id))
    .map((id) => stateRooms.find((r) => r.booking_id === id)?.room_name)
    .filter(Boolean);

  // Reset every successfully-closed room to 'available' in one atomic emit.
  const successPatches = {};
  succeededIds.forEach((id) => {
    const room = stateRooms.find((r) => r.booking_id === id);
    if (!room) return;
    successPatches[room.room_name] = {
      status: "available",
      error: null,
      guest_name: null,
      check_in: null,
      booking_id: null,
      charged_rate: null,
      payment_status: null,
      amount_paid: null,
      shop_total: 0,
      shop_items: [],
      nights: null,
      // Clear the group anchor too — otherwise this room sits
      // "available" while still carrying its previous stay's ref.
      Client_Booking_Ref: null,
      activeBooking: null
    };
  });
  if (Object.keys(successPatches).length > 0) bulkPatchRooms(successPatches);

  if (failedRoomNames.length > 0) {
    // The write for these didn't confirm — they're still occupied in
    // the database, so 'error' (not 'available') is the honest state.
    markRoomsError(failedRoomNames, "Checkout failed to save — please retry.");
  }

  closeCheckOutModal();

  if (failedRoomNames.length === 0) {
    setSyncStatus("synced");
    showToast("success", "Checked out!", `Balance collected: ${_ksh(totalBalanceCollected)}`);
  } else if (succeededIds.length === 0) {
    setSyncStatus("error");
    showToast("error", "Checkout failed", result.error ?? "No rooms were checked out.");
  } else {
    setSyncStatus("error");
    showToast(
      "error",
      "Partial checkout failure",
      `${failedRoomNames.length} of ${bookingIds.length} room(s) failed to check out.`
    );
  }

  await _loadRooms(); // Refresh the list from the source of truth
}

// ─────────────────────────────────────────────────────
// Multi-select floating action bar (group check-in)
// ─────────────────────────────────────────────────────

function _renderMultiSelectBar(selectedRooms) {
  let bar = document.getElementById("multi-select-bar");

  if (!selectedRooms || selectedRooms.length === 0) {
    bar?.remove();
    return;
  }

  if (!bar) {
    bar = document.createElement("div");
    bar.id = "multi-select-bar";
    bar.className =
      "fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 " +
      "bg-gray-900 border border-brand-600 rounded-2xl shadow-2xl px-5 py-3 animate-fade-in";
    document.body.appendChild(bar);
  }

  const count = selectedRooms.length;
  const label = `${count} room${count !== 1 ? "s" : ""}`;

  bar.innerHTML = `
    <span class="text-sm font-semibold text-white">${label} selected</span>
    <button id="btn-group-checkin" type="button"
      class="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-brand-600 to-brand-500
             hover:from-brand-500 hover:to-brand-400 transition-colors">
      Check In ${label}
    </button>
    <button id="btn-cancel-selection" type="button" title="Clear selection"
      class="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    </button>
  `;

  document.getElementById("btn-group-checkin").onclick = () => {
    const { rooms } = getState();
    const roomsToCheckIn = rooms.filter((r) => selectedRooms.includes(r.room_name) && r.status === "available");

    if (roomsToCheckIn.length === 0) {
      showToast("error", "No rooms to check in", "Selected rooms are no longer available.");
      clearSelection();
      return;
    }

    openCheckInModal(roomsToCheckIn, {
      onCheckIn: _handleCheckIn,
      // Same callbacks as the single-room check-in call site above.
      getAvailableRooms: (excluded) => getAvailableRooms(excluded),
      getReservationConflicts: (params) => getReservationConflicts(params),
      ownerMode: getActiveRole() === "owner"
    });
  };

  document.getElementById("btn-cancel-selection").onclick = () => {
    clearSelection();
  };
}

// ─────────────────────────────────────────────────────
// State subscription → re-render
// ─────────────────────────────────────────────────────

function _subscribeToState() {
  on("change", ({ changedKeys }) => {
    if (changedKeys.includes("rooms")) {
      const { rooms } = getState();
      renderRoomsGrid(rooms, _onCardClick);
      _applyRoomFilter(_activeRoomFilter);
      _updateHeaderStats(rooms);
    }

    if (changedKeys.includes("expenses")) {
      const { ui } = getState();
      console.log("State change detected. Active view:", ui.activeView);
      if (ui.activeView === "expenses") {
        _renderExpenses();
      }
    }

    if (changedKeys.includes("reservations") || changedKeys.includes("reservationLineItems")) {
      _renderReservationsBadge();
      const { ui } = getState();
      if (ui.activeView === "reservations") {
        _renderReservationsView();
      }
    }

    if (changedKeys.includes("ui")) {
      const { ui, rooms } = getState();
      _renderSyncIndicator(ui.syncStatus);
      _renderMultiSelectBar(ui.selectedRooms ?? []);

      // Selection state is drawn as a ring on each card, so re-render
      // the grid whenever ui changes to keep cards in sync.
      renderRoomsGrid(rooms, _onCardClick);
      _applyRoomFilter(_activeRoomFilter);
    }
  });
}

// ─────────────────────────────────────────────────────
// Main init (called after auth passes)
// ─────────────────────────────────────────────────────

async function _init() {
  CURRENT_ROLE = getActiveRole();

  _updateHeaderDate();
  _startClock();
  _wireNavLinks();
  _wireRefreshButton();
  _wireExpensesForm();
  _wireEditExpenseModal();
  _wireSidebarDrawer();
  _wireRoomFilterBar();
  _wireLogoutButton();
  _subscribeToState();
  _wireUpdateCheckButton();

  initLockScreen();

  if (CURRENT_ROLE === "owner") {
    _maybeCheckForUpdate(); // ← new, only owner ever triggers the GitHub call
  }

  _syncHeaderHeightVar();
  window.addEventListener("load", _syncHeaderHeightVar);
  window.addEventListener("resize", _syncHeaderHeightVar);

  _switchView("dashboard");

  await _loadRooms();
  await _loadExpenses();
  await _loadReservations();

  setInterval(() => {
    _loadRooms();
    _loadExpenses();
    _loadReservations();
  }, 30 * 1000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      _loadRooms();
      _renderExpenses();
      _loadReservations();
    }
  });
}

/**
 * Wires the sidebar Logout button. Replaces the previous inline
 * onclick, which cleared sessionStorage — a bucket auth.js never
 * actually writes to, so the button silently did nothing. Real
 * session data lives in localStorage via auth.js's clearSession().
 */
function _wireLogoutButton() {
  const btn = document.getElementById("btn-logout");
  if (!btn) return;
  btn.addEventListener("click", () => {
    clearSession();
    window.location.reload();
  });
}

async function _maybeCheckForUpdate() {
  const update = await checkForUpdate();
  const btn = document.getElementById("update-available-btn");
  if (!btn || !update) return;

  btn.dataset.downloadUrl = update.downloadUrl;
  btn.title = `v${update.latestVersion} available — you're on v${update.currentVersion}`;
  btn.classList.remove("hidden");
}

function _wireUpdateCheckButton() {
  const btn = document.getElementById("update-available-btn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const url = btn.dataset.downloadUrl;
    if (!url) return;

    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Downloading…";

    try {
      await downloadAndInstallUpdate(url);
    } catch (err) {
      showToast("error", "Update failed", err instanceof Error ? err.message : "Could not download the update.");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

// ─────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initAuthGate(_init);
});

function _renderSyncIndicator(status) {
  const icon = document.getElementById("sync-indicator");
  if (!icon) return;

  const colors = {
    synced: "bg-green-500",
    saving: "bg-yellow-500 animate-pulse",
    error: "bg-red-500"
  };

  icon.className = `w-3 h-3 rounded-full ${colors[status] || colors.synced}`;
  icon.title = `Status: ${status}`;
}

// Import the component
import { renderBookingHistory } from "./components/BookingHistory.js";

async function _renderHistoryView() {
  const container = document.getElementById("history-container");
  if (!container) return;

  // #history-container is now a plain <div> — BookingHistory.js owns its
  // entire subtree (search bar, totals, month groups), so loading/error
  // states here are plain markup too, no longer <tr><td> scaffolding.
  container.innerHTML = '<p class="text-gray-500 text-center py-10">Loading history...</p>';
  delete container.dataset.shellBuilt; // reset so BookingHistory.js rebuilds the shell it just wiped

  // Reuse the existing fetchBookings API call
  const result = await fetchBookings();

  if (result.ok) {
    // Pass the raw bookings array to the component
    renderBookingHistory(result.bookings, {
      onDelete: _handleDeleteHistoryBooking,
      onLogPastStay: _handleOpenPastStayModal
    });
  } else {
    container.innerHTML = '<p class="text-red-500 text-center py-10">Failed to load history.</p>';
  }
}

/**
 * Opens the "Log a Past Stay" modal. This flow never touches live room
 * state — PastStayModal.js writes directly to /api/checkin/past via
 * api.js and, on success, this only refreshes the Booking History list
 * (same fetchBookings() call _renderHistoryView already uses).
 */
function _handleOpenPastStayModal() {
  openPastStayModal(ROOM_DEFINITIONS, {
    createdBy: getActiveUser() ?? "unknown",
    onSuccess: () => {
      showToast("success", "Past stay logged", "Booking History has been updated.");
      _renderHistoryView();
    }
  });
}

// ─────────────────────────────────────────────────────
// Reservations view (website bookings)
// ─────────────────────────────────────────────────────

function _renderReservationsView() {
  const { reservations, reservationLineItems } = getState();
  renderReservationsTab(reservations, reservationLineItems, {
    getAvailableRoomsForCategory: (categoryId, excludeNames) => getAvailableRoomsByCategory(categoryId, excludeNames),
    onAssignRoom: _handleAssignReservationRoom,
    onCancelLineItem: _handleCancelLineItem,
    onConfirmReservation: _handleConfirmReservation,
    onCancelReservation: _handleCancelReservation
  });
}

function _renderReservationsBadge() {
  const badge = document.getElementById("nav-reservations-badge");
  if (!badge) return;

  const count = getPendingLineItemsCount();
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
}

/**
 * Assigns a specific room to a reservation line item: checks the
 * guest in for real (reusing the existing single-room checkIn() —
 * no duplicated check-in logic here), then marks the line item
 * checked_in and records the room/booking it landed on.
 *
 * @param {Object} reservation
 * @param {Object} lineItem
 * @param {Object} room
 */
async function _handleAssignReservationRoom(reservation, lineItem, room) {
  const created_by = getActiveUser() ?? "unknown";

  const checkInDate = new Date();
  const checkOutDate = reservation.check_out ? new Date(reservation.check_out) : null;
  const reservationCheckIn = reservation.check_in ? new Date(reservation.check_in) : checkInDate;
  const rawNights = checkOutDate ? Math.round((checkOutDate.getTime() - reservationCheckIn.getTime()) / 86400000) : 1;
  const nights = Math.max(1, rawNights || 1);

  setSyncStatus("saving");

  const result = await checkIn({
    room_name: room.room_name,
    guest_name: reservation.guest_name,
    nights,
    check_in: checkInDate.toISOString().split("T")[0],
    room_type: room.room_type,
    base_rate: Number(room.base_rate),
    // Room rates stay staff-adjustable at check-in time, independent
    // of the website's fixed category price — default to the room's
    // own base rate here; front desk can adjust it later the same way
    // as any other booking, via the normal checkout flow.
    charged_rate: Number(room.base_rate),
    payment_status: "unpaid",
    amount_paid: 0,
    is_active: true,
    created_by
  });

  if (!result.ok) {
    setSyncStatus("error");
    showToast(
      "error",
      "Check-in failed",
      result.error ?? `Could not check ${reservation.guest_name} into ${room.room_name}.`
    );
    return;
  }

  const patchResult = await patchReservationLineItemAPI(lineItem.line_item_id, {
    status: "checked_in",
    assigned_room_name: room.room_name,
    assigned_booking_id: result.booking_id
  });

  if (!patchResult.ok) {
    // The booking itself landed fine — only the reservation-tracking
    // row failed to update. Don't roll back the check-in for this;
    // surface it so the front desk knows the reservation card may
    // look stale until they retry/refresh.
    setSyncStatus("error");
    showToast(
      "error",
      "Room assigned, but reservation update failed",
      patchResult.error ?? "The room was checked in, but the reservation record didn't save. Refresh and retry."
    );
  } else {
    setSyncStatus("synced");
    showToast("success", "Room assigned", `${room.room_name} → ${reservation.guest_name}`);
  }

  patchReservationLineItemState(lineItem.line_item_id, {
    status: "checked_in",
    assigned_room_name: room.room_name,
    assigned_booking_id: result.booking_id
  });

  await _loadRooms(); // Refresh the grid so the newly-occupied room shows up.
}

/**
 * Confirm/cancel handlers for the Reservations tab.
 * ─────────────────────────────────────────────────────
 * These fill the gap _handleAssignReservationRoom() doesn't cover: it
 * only ever moves a line item straight from "pending" to "checked_in".
 * Nothing previously let staff drop a request ("cancelled") at the
 * line-item level, or confirm/cancel the whole reservation, without
 * going all the way to a physical room assignment. Same
 * optimistic-then-reconcile pattern as the rest of main.js: PATCH the
 * API, then mirror the same patch into local state so the UI updates
 * immediately.
 *
 * Note: there is no line-item-level "confirm" — only "cancelled" and
 * "checked_in" are valid statuses for the reservation_line_items
 * table in the database, so confirmation only ever happens at the
 * reservation level (_handleConfirmReservation below). A line-item
 * Confirm button existed briefly but was removed after it threw 422s
 * trying to write a "confirmed" value the schema doesn't accept there.
 */

async function _handleCancelLineItem(lineItem) {
  setSyncStatus("saving");
  const result = await patchReservationLineItemAPI(lineItem.line_item_id, { status: "cancelled" });
  if (!result.ok) {
    setSyncStatus("error");
    showToast("error", "Couldn't cancel room request", result.error ?? "Please try again.");
    return;
  }
  patchReservationLineItemState(lineItem.line_item_id, { status: "cancelled" });
  setSyncStatus("synced");
  showToast("success", "Room request cancelled", lineItem.category_name ?? "Line item cancelled.");
}

async function _handleConfirmReservation(reservation) {
  setSyncStatus("saving");
  const result = await patchReservationAPI(reservation.airtable_id, { status: "confirmed" });
  if (!result.ok) {
    setSyncStatus("error");
    showToast("error", "Couldn't confirm reservation", result.error ?? "Please try again.");
    return;
  }
  patchReservationState(reservation.airtable_id, { status: "confirmed" });
  setSyncStatus("synced");
  showToast("success", "Reservation confirmed", reservation.guest_name ?? "");
}

/**
 * Cancelling a reservation also cascades to any of its line items that
 * are still pending/confirmed (not yet checked_in) — a cancelled
 * reservation shouldn't leave dangling room requests still showing an
 * "Assign room" button for a booking that no longer exists. Already
 * checked_in line items are left alone; that room is genuinely
 * occupied and needs the normal checkout flow, not a silent cancel.
 */
async function _handleCancelReservation(reservation) {
  setSyncStatus("saving");

  const result = await patchReservationAPI(reservation.airtable_id, { status: "cancelled" });
  if (!result.ok) {
    setSyncStatus("error");
    showToast("error", "Couldn't cancel reservation", result.error ?? "Please try again.");
    return;
  }
  patchReservationState(reservation.airtable_id, { status: "cancelled" });

  const { reservationLineItems } = getState();
  const toCascade = reservationLineItems.filter(
    (li) =>
      (li.reservation_id ?? []).includes(reservation.airtable_id) &&
      li.status !== "checked_in" &&
      li.status !== "cancelled"
  );

  for (const li of toCascade) {
    const liResult = await patchReservationLineItemAPI(li.line_item_id, { status: "cancelled" });
    if (liResult.ok) {
      patchReservationLineItemState(li.line_item_id, { status: "cancelled" });
    }
    // A single line item failing to cascade isn't worth blocking on —
    // the reservation itself is already cancelled; surface it quietly
    // via the console and let a refresh catch anything left behind.
    else {
      console.error(`[_handleCancelReservation] Failed to cascade-cancel line item ${li.line_item_id}`, liResult.error);
    }
  }

  setSyncStatus("synced");
  showToast("success", "Reservation cancelled", reservation.guest_name ?? "");
}

// ─────────────────────────────────────────────────────
// Add this helper function at the bottom of main.js
// ─────────────────────────────────────────────────────
function _cleanDate(isoString) {
  return isoString.split("T")[0]; // Converts 2026-07-01T12:00:00Z to 2026-07-01
}

// Add this in main.js
function _prepareExpensePayload(amount, category, description) {
  return {
    amount: Number(amount),
    category: category,
    description: description,
    date: new Date().toISOString().split("T")[0] // Standardized format
  };
}