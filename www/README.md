# Vintex Guest House — Property Management System (PMS)

A single-page, front-desk dashboard for a small guest house. Staff use it to see live room occupancy, check guests in and out, track shop/POS charges, log expenses, and process bookings that arrive from the guest house's public booking website. It runs entirely in the browser with no backend server of its own — **Airtable is the database**, accessed directly from client-side JS.

> This README documents the PMS (attendant/owner dashboard). The guest-facing booking website that feeds the "Reservations" tab is a separate, external system — its write path into this PMS is the `reservations` / `reservation_line_items` Airtable tables described below.

---

## 1. What this system does

| Area | What staff can do |
|---|---|
| **Dashboard** | See every room as a live-status card (Available / Occupied / Needs Attention), filter by status, check a guest in (single room or a multi-room group), and click into an occupied room to check out. |
| **Reservations** | Review bookings placed on the website before they're on-property yet. Confirm or cancel a reservation (and cascade that to its rooms), or assign an actual physical room to a pending room request. |
| **Expenses Log** | Record day-to-day operating expenses (utilities, supplies, salaries, etc.), edit or categorize them, and see a running total. |
| **Booking History** | Search past (checked-out) stays, see what was paid and by whom, print/re-print a receipt, and delete erroneous records. |
| **Auth** | A lightweight PIN gate distinguishes **attendant** vs **owner** sessions; owner-only controls (e.g. deleting history) are hidden from attendants. |

The whole app is role-aware, mobile-responsive (collapsible drawer sidebar), and optimized for a tablet/PC at a front desk — including 80mm thermal-printer receipts.

---

## 2. Tech stack

- **No build step.** Plain ES modules (`<script type="module">`), loaded directly by the browser.
- **Styling:** Tailwind CSS via the CDN script (`cdn.tailwindcss.com`) + a small hand-written `style.css` for print rules, scrollbars, and a few custom animations/transitions Tailwind doesn't cover out of the box.
- **Fonts:** Inter (UI) and JetBrains Mono (numbers/currency) via Google Fonts.
- **Data layer:** [Airtable](https://airtable.com) as the underlying database, reached through a **Cloudflare Worker gateway** (`api.js` calls the gateway; the gateway is the only thing holding Airtable credentials). No Node/Express/Python backend of the PMS's own — the gateway is a thin, purpose-built proxy, not a general backend.
- **State:** A small hand-rolled in-memory store (`state.js`) — no Redux/Zustand/etc.
- **Persistence across reloads:** `localStorage` for auth (a signed session token, plus the active user/role) — switched from `sessionStorage` so a session survives a tab reload mid-shift rather than logging staff out. All business data always comes fresh from Airtable via the gateway.

> ⚠️ **Deployment TODO:** `api.js` and `auth.js` both point at a `GATEWAY_URL` placeholder (`https://vintex-gateway.YOUR-SUBDOMAIN.workers.dev`) until the Worker is actually deployed. Swap that constant for the real `*.workers.dev` URL (or custom domain) in both files once `wrangler deploy` has run — see the gateway's own README for setup steps. Until that's done, login and every data call will fail.

> ⚠️ **Known production issue:** the app currently loads Tailwind via the CDN script tag, which Tailwind explicitly warns against for production use (it compiles CSS in the browser on every load, which is slow and non-cacheable). Migrating to the Tailwind CLI or a PostCSS build is a known follow-up — see [§8 Known issues](#8-known-issues--roadmap).

---

## 3. Architecture at a glance

```
index.html                  ← shell: sidebar, header, all 4 views, all modals, login screen
  └── js/main.js             ← app entry point: routing, event wiring, orchestration
        ├── js/services/
        │     ├── api.js     ← every gateway call (fetch wrappers, bearer-authed)
        │     ├── state.js   ← in-memory store + mutators, mirrors api.js writes optimistically
        │     └── auth.js    ← PIN → gateway login, session token storage, role-based UI toggling
        └── js/components/   ← pure(ish) render functions, one per view/widget
              ├── RoomCard.js         (dashboard room grid)
              ├── ReservationsTab.js  (website bookings)
              ├── CheckInModal.js     (check-in slide-over, single or group)
              ├── CheckOutModal.js    (checkout slide-over, single or group)
              ├── BookingHistory.js   (past-bookings table)
              ├── Receipt.js          (80mm thermal receipt + window.print())
              └── payments.js         (shared payment-method / payment-status form fields)
```

### The core pattern: optimistic write, then reconcile

Nearly every mutating action in `main.js` follows the same shape:

1. `setSyncStatus("saving")` — turns the sidebar sync dot amber/spinning.
2. `await someThingAPI(...)` — a `fetch()` PATCH/POST/DELETE to Airtable via `api.js`.
3. On failure → `setSyncStatus("error")` + `showToast("error", ...)`, and stop (no state mutation, so the UI doesn't lie about what happened).
4. On success → mirror the exact same change into local state via the matching `*State()` function in `state.js`, `setSyncStatus("synced")`, then a success toast.
5. Re-render whatever view is visible.

This keeps `api.js` and `state.js` deliberately symmetric — for almost every `xAPI()` function in `api.js` there's an `xState()` function in `state.js` that applies the same logical change to the in-memory copy, so the UI updates instantly without waiting for a full refetch.

### Components are dumb, `main.js` is not

Everything under `js/components/` renders HTML strings/DOM and emits **callbacks** — it never imports `api.js` directly and never decides *what happens* on a click, only *that* a click happened. `main.js` supplies the callbacks (`onConfirmReservation`, `onAssignRoom`, `onDelete`, etc.) and owns all business logic and Airtable calls. This is why, e.g., `ReservationsTab.js` has no idea what Airtable field name a "confirm" maps to — it just calls `callbacks.onConfirmReservation(reservation)` and waits.

### Event delegation, not per-element listeners

Every list/grid component (`ReservationsTab.js`, `BookingHistory.js`, the modals' room lists) wires **one** delegated click listener on a stable parent container and reads `data-action` / `data-*-id` attributes off `e.target.closest(...)`. This means rows/cards can be freely re-rendered (added, removed, reordered) without ever needing to re-attach listeners — a big reason the group check-in/checkout modals can let you add or remove rooms mid-flow without anything going stale.

### Two-tap destructive confirm, not `window.confirm()`

Cancel/Delete buttons across the app (Booking History delete, Reservations cancel) use the same in-place pattern: first click turns the button red and its label to **"Confirm?"** for ~3 seconds; a second click within that window actually performs the action. This avoids native browser confirm dialogs, which look inconsistent with the rest of the UI and are easy to dismiss by accident.

---

## 4. File-by-file reference

### `index.html`
The entire app shell in one file: login overlay, sidebar nav (`data-view` buttons drive routing), the sticky header (with the live occupancy stat pills), all four page-content views (`#view-dashboard`, `#view-reservations`, `#view-expenses`, `#view-history`), the check-in/checkout modal mount points, the edit-expense modal, the hidden receipt print layer, and the toast container. `main.js` is loaded as the sole `<script type="module">` entry point; everything else is imported from there.

### `js/main.js`
The orchestrator. Responsibilities:
- View routing (`data-view` clicks → show/hide the right `#view-*` div, update `#page-title`)
- Loading rooms/reservations/expenses/history from Airtable on boot and on refresh
- All the `_handle*` action handlers (check-in, checkout, confirm/cancel reservation, assign room, add/edit/delete expense, delete history row) — see [§5](#5-reservationsconfirmcancel-flow) for the reservations flow specifically
- Wiring every component's callbacks
- Sync-status indicator + toast notifications
- Room-name normalization between Airtable's raw values and the app's canonical `ROOM_DEFINITIONS` (see `_normalizeRoomKey()` — this fixed a bug where category-based room matching silently failed due to casing differences, e.g. `"CHARITY"` vs `"Charity"`)

### `js/services/api.js`
Every network call now goes to the Cloudflare Worker gateway, not Airtable directly — no Airtable URL, table/field name, or credential appears in this file anymore. Every function kept its original name and return shape (`{ ok: true, ...data }` or `{ ok: false, error }`), so nothing else in the PMS needed to change. Each call attaches `Authorization: Bearer <token>` (the token comes from `auth.js`'s `getSessionToken()`); a `401` response is handled centrally here — it clears the stale session and reloads straight back to the PIN screen, rather than every caller having to know what a 401 means.

Key functions include (non-exhaustive): `fetchRooms`, `checkIn`, `checkOut`, `fetchReservations`, `fetchReservationLineItems`, `patchReservationLineItem`, `patchReservation`, expense CRUD, and history fetch/delete.

App-facing status values (e.g. `"confirmed"`, `"cancelled"`, `"checked_in"`) are still translated to Airtable's real field name, `status_reading` — that translation now happens at the gateway's boundary instead of in this file, but the effect on callers is identical: components and `main.js` never need to know the underlying Airtable schema field name.

The batch-chunking this file used to do client-side for group check-in/checkout and bulk shop-item deletes (Airtable's API caps batch writes at 10 records) has moved into the gateway too — `bulkCheckIn`/`bulkCheckOut`/`deleteShopLineItems` now send one request regardless of group size, and the gateway splits it into Airtable-sized batches.

### `js/services/state.js`
The in-memory store: rooms, reservations, reservation line items, expenses, UI flags (selected rooms, multi-select mode, etc.). Exposes `getState()` plus a mutator per concept (`patchReservationState`, `patchReservationLineItemState`, `toggleRoomSelection`, ...). Mutators here are what get called *after* an `api.js` call succeeds — see the optimistic-write pattern in §3.

### `js/services/auth.js`
The PIN is now checked server-side: on submit, the PIN is sent to the gateway's `POST /api/auth/login`, which holds the real PIN → `{ userId, role }` map as a Worker secret (never shipped to the browser). On success, the gateway returns an HMAC-signed session token (12-hour expiry), which this file stores in `localStorage` alongside `vintex_user` / `vintex_role` — switched from `sessionStorage` so a session survives a page reload mid-shift. Every subsequent `api.js` call reads that token via `getSessionToken()` and sends it as `Authorization: Bearer <token>`. The login screen UI itself — fade-out, sidebar avatar/name/role-badge application, wrong-PIN inline error + shake — is unchanged from before.

### `js/components/RoomCard.js`
Renders the dashboard's room grid. Each card is a `<button>` with a status ring/badge (green = available, red = occupied, amber = "Needs Attention" for a room stuck mid-failed-write). Clicking an available room opens check-in; clicking occupied opens checkout. Double-clicking (or single-clicking while already in multi-select mode) toggles that room into a **group selection** for a shared group check-in.

### `js/components/ReservationsTab.js`
Renders website bookings as reservation cards, each containing one or more line items (room requests). Supports, at both the **reservation** and **line-item** level, Confirm/Cancel actions (reservation-level only — line items only support Assign-room / Cancel; see [§5](#5-reservationsconfirmcancel-flow) for why there's no line-item-level Confirm), plus a room-assignment picker per line item that's scoped to that line item's room category.

### `js/components/CheckInModal.js` (a.k.a. "v2" — dynamic group check-in)
A slide-over panel for checking a guest into one **or more** rooms at once. The set of rooms being checked in lives in a local `activeGroup` array that can grow (via an "Add Room" dropdown, fed by `main.js`'s `getAvailableRooms()` callback) or shrink (per-room remove button) without closing the modal or losing anything already typed into the shared Guest Name / Nights / Payment fields. Per-room blocks re-render into a dedicated sub-container so the shared fields never get torn down.

### `js/components/CheckOutModal.js` (a.k.a. "v2" — dynamic group checkout)
The checkout equivalent: financial closing for one or more occupied rooms belonging to the same stay (e.g. a family that booked 3 rooms). Rooms are matched into the same group by **two anchors** — `Client_Booking_Ref` *and* `guest_name` — supplied via `main.js`'s `getRelatedRooms()` callback, which avoids both false positives (two different guests who happen to share a name) and false negatives (a group booking where each room got its own `booking_id`). Handles shop/POS item entry per room, computes subtotals, and on completion calls `Receipt.js` to print.

### `js/components/BookingHistory.js`
Renders past (`is_active: false`) bookings as `<tr>` rows into an existing `<tbody>` (it never writes anything but `<tr>`s into that container — Booking history's table markup and search input live directly in `index.html`). Wires the live search box (`#history-search-input`) and a two-tap delete-confirm per row.

### `js/components/Receipt.js`
Builds an 80mm-thermal-optimized receipt (room charges, shop items, totals, balance due, payment method/status) and fires `window.print()`. The print-only CSS in `style.css` hides everything on the page except the injected receipt layer for the duration of the print dialog, then cleans up on `afterprint`.

### `js/components/payments.js`
Shared, reusable UI for two concerns used by both check-in and checkout: **payment method** (Cash / M-Pesa / Bank Transfer, with a conditional reference-number field for the latter two) and **payment status** (Paid in full / Partial / Pay at checkout, with a conditional deposit-amount field for Partial). Also exports the corresponding `validatePayment()` / `validatePaymentStatus()` functions so both modals validate identically.

### `style.css`
Tailwind can't express everything cheaply (keyframe animations, `@page` print rules, scrollbar styling), so this file covers: custom scrollbar, room-card hover lift, active nav/filter-pill styling, the sidebar drawer's scroll-lock, the pulsing status dot, a refresh-spin animation, the expense-form's slide-in reason field, and a full `@media print` stylesheet dedicated to rendering `Receipt.js`'s output cleanly on 80mm thermal paper (plus a mobile-print fallback block, since some mobile browsers otherwise print a blank page).

---

## 5. Reservations confirm/cancel flow

This is worth documenting in detail since it's had a couple of real bugs.

**Two levels of status live in Airtable:**
- `reservations` table — one row per website booking. Its `status_reading` select field includes `pending`, `confirmed`, and `cancelled`.
- `reservation_line_items` table — one row per *room request* within a reservation (a reservation can have 2+ line items, e.g. a family booking 3 rooms). Its `status_reading` select field includes `pending`, `checked_in`, and `cancelled` — **it does not have a `confirmed` option**, and the Airtable API key used by this app doesn't have permission to auto-create new select options.

**What this means in practice:**
- Confirming happens **only at the reservation level** (`patchReservation(id, { status: "confirmed" })`). There is deliberately no "Confirm" button on an individual line item — an earlier version had one, and clicking it threw a `422 INVALID_MULTIPLE_CHOICE_OPTIONS` error from Airtable every time, because it tried to write `"confirmed"` into a field that doesn't allow that value. That button was removed.
- Line items only ever move `pending → checked_in` (via room assignment) or `pending/confirmed → cancelled`.
- **Cancelling a reservation cascades**: it also cancels every line item under it that isn't already `checked_in` (checked-in rooms are left alone — they need the normal checkout flow, not a silent cancel, since a real guest is already on-property).
- Assigning a room to a line item (`onAssignRoom` → `_handleAssignReservationRoom` in `main.js`) reuses the exact same `checkIn()` call the dashboard uses for a walk-in — there's only one check-in code path in the whole app — and then separately PATCHes the line item to `checked_in` with the assigned room name/booking id.

If you ever see a 422 with `INVALID_MULTIPLE_CHOICE_OPTIONS` from `patchReservationLineItem`, the fix is **not** to add the value in code — it's to either (a) confirm at the reservation level instead, or (b) add the missing option to that Airtable field's schema directly (with the right table permissions) if a line-item-level "confirmed" state is genuinely needed in the future.

---

## 6. Roles & permissions

Two roles exist today, distinguished by which PIN was entered:

| Role | Sees |
|---|---|
| `attendant` | Dashboard, Reservations, Expenses Log, Booking History — standard front-desk operations |
| `owner` | Everything attendants see, **plus** any element marked `[data-owner-only]` in `index.html` (currently used to gate destructive/financial-oversight UI elements) |

**What changed with the gateway:** *authentication* is now real — every request to the gateway (rooms, bookings, reservations, expenses, everything) requires a valid, signed session token, verified server-side. A PIN typed into the console (`localStorage.setItem(...)`, the old bypass) no longer works, because there's no server-side check of that flag anymore; the gateway only trusts its own signed tokens, issued only after a real PIN check against a secret it holds.

*Authorization* — telling attendants and owners apart for specific actions — is currently **DOM-only, same as before**: `auth.js` toggles `.hidden` on `[data-owner-only]` elements, but the gateway currently treats both roles identically for every route (an attendant's token can call the same endpoints an owner's can, including deletes). If a specific action should become owner-only at the server level too, that's a one-line change per route in the gateway's `src/index.js` (change its trust tier from `"staff"` to `"owner"`) — not implemented yet because both roles are meant to have equal access to every current action.

Anyone with the Airtable PAT itself (which now lives only in the gateway's secrets, not in any shipped code) can still bypass everything — that hasn't changed, it's just a much smaller set of people (whoever has Cloudflare account access) than "every visitor's browser," which was the situation before the gateway existed.

---

## 7. Debugging tips

- Errors from the gateway surface the same way `_handleError()`-wrapped Airtable errors always did — a `{ ok: false, error }` object your `_handle*` action handler in `main.js` already checks for. The gateway logs the underlying Airtable error server-side (visible via `wrangler tail`, not the browser console) rather than in this app's console, since the browser no longer talks to Airtable directly.
- A session that's expired or been invalidated shows up as every API call suddenly failing at once with "Session expired" — `api.js` handles this automatically by clearing the stored token and reloading back to the PIN screen, so you shouldn't need to debug this manually; if it's happening more often than once per shift, check the token TTL in the gateway's `session.js`.
- `main.js` logs `State change detected. Active view: <view>` on every state mutation — useful for confirming a click actually triggered a state update (vs. a silently-swallowed error).
- Because there's no build step, **the browser cache is the #1 cause of "I fixed it but it's still broken."** After deploying updated `.js` files, hard-refresh (Ctrl/Cmd+Shift+R) or test in an incognito window before assuming a fix didn't work.
- Quick way to confirm a specific fix actually deployed: DevTools → Sources → open the file in question → search for the function/string that should (or shouldn't) be there anymore.
- If *every* request fails immediately after switching to the gateway, check `GATEWAY_URL` in both `api.js` and `auth.js` first — a stale placeholder or typo there looks identical to a network outage from the browser's side.

---

## 8. Known issues / roadmap

- **Tailwind CDN in production** — should migrate to the Tailwind CLI or a PostCSS build step for real caching and to remove the console warning (see §2).
- **~~No real backend authorization~~ — partially resolved.** Authentication is now real: every gateway route requires a valid, signed session token (see §6), and the PIN list lives server-side, not in shipped JS. What's *not* yet enforced server-side is the attendant/owner **distinction** — the gateway currently treats every valid session the same regardless of role, so `[data-owner-only]` gating is still DOM-only. Not a problem today since both roles are meant to have equal access to every action, but worth revisiting if that ever changes (see §6 for how to lock a specific route down).
- **No offline/retry queue** — if a write fails mid-action (e.g. network drop during checkout), the user gets a toast and has to manually retry; nothing is queued for automatic replay.
- **Line-item "confirmed" state** — currently unsupported by the Airtable schema on purpose (see §5). If the business ever needs to track "we've confirmed this specific room request but haven't assigned a room yet" as a distinct state from the reservation-level confirm, that requires an Airtable schema change (adding a `confirmed` option to `reservation_line_items.status_reading`) before any code change.
- **Gateway not yet deployed** — `wrangler deploy` hasn't been run yet; `GATEWAY_URL` in both `api.js` and `auth.js` is still a placeholder. Nothing in this app can reach Airtable until that's done (see §2).