/**
 * js/services/auth.js
 * ─────────────────────────────────────────────────────
 * Was: PIN checked against an in-module CREDENTIALS map, session flag
 * written straight to sessionStorage — anyone could fake it from the
 * console with sessionStorage.setItem('vintex_authenticated','true').
 *
 * Now: PIN is sent to the gateway's /api/auth/login. The PIN list
 * lives server-side (a Worker secret), and what comes back is an
 * HMAC-signed session token that every subsequent api.js call sends
 * as `Authorization: Bearer <token>` — unforgeable from the browser.
 *
 * The login screen UI and flow are otherwise unchanged: same form,
 * same fields, same error/shake behavior.
 *
 * Session persistence: localStorage (survives across tab reloads —
 * matches a front-desk shift, unlike the previous tab-scoped
 * sessionStorage). Keys:
 *   vintex_session_token   the signed bearer token
 *   vintex_user            e.g. "attendant_1"
 *   vintex_role            "attendant" | "owner"
 *
 * Exports:
 *   isAuthenticated()          → boolean
 *   getSessionToken()          → string | null   (used by api.js)
 *   getActiveUser()            → string | null
 *   getActiveRole()            → "attendant" | "owner" | null
 *   getSessionAgeMs()          → number   (NEW — used by lockScreen.js)
 *   isSessionAbsoluteExpired() → boolean  (NEW — used by lockScreen.js)
 *   SESSION_ABSOLUTE_MS        → number   (NEW — 1hr ceiling constant)
 *   initAuthGate(callback)     → void
 *   clearSession()             → void
 */

// Must match the GATEWAY_URL used in services/api.js.
const GATEWAY_URL = "https://api.vintexguesthouse.com";

/**
 * Hard ceiling on session age, enforced CLIENT-SIDE only. Once a
 * session crosses this age, lockScreen.js refuses to offer biometric
 * re-arm and forces a full PIN login instead — biometrics can re-arm
 * an already-valid token, but nothing client-side can mint a new one.
 *
 * NOTE: this does not shorten the token's actual server-side lifetime
 * (still whatever vintex-gateway's /api/auth/login issues today). This
 * constant only controls when THIS APP decides to stop trusting a
 * token it's holding and asks for fresh proof — a real tightening of
 * the server-issued token lifetime is a separate Worker-side change.
 */
export const SESSION_ABSOLUTE_MS = 60 * 60 * 1000; // 1 hour

// ─────────────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────────────

/**
 * Returns true when a session token is present. Does not verify the
 * signature or expiry client-side — that's the gateway's job on every
 * request; an expired/tampered token just gets a 401 from the API,
 * which api.js's error handler turns into a forced re-login.
 * @returns {boolean}
 */
export function isAuthenticated() {
  return Boolean(localStorage.getItem("vintex_session_token"));
}

/**
 * Returns the raw bearer token for api.js to attach to requests, or
 * null when no session exists.
 * @returns {string|null}
 */
export function getSessionToken() {
  return localStorage.getItem("vintex_session_token");
}

/**
 * @returns {string|null}
 */
export function getActiveUser() {
  return localStorage.getItem("vintex_user") ?? null;
}

/**
 * @returns {'attendant'|'owner'|null}
 */
export function getActiveRole() {
  return /** @type {'attendant'|'owner'|null} */ (
    localStorage.getItem("vintex_role") ?? null
  );
}

/**
 * Milliseconds since this session's token was issued (i.e. since the
 * last successful PIN login), or Infinity if we have no recorded
 * issue time — an untracked session is treated as expired rather than
 * trusted, so a stale/legacy session (written before this field
 * existed) gets forced through a fresh login exactly once.
 * @returns {number}
 */
export function getSessionAgeMs() {
  const issuedAt = Number(localStorage.getItem("vintex_session_issued_at") ?? 0);
  if (!issuedAt) return Infinity;
  return Date.now() - issuedAt;
}

/**
 * True once the session has crossed SESSION_ABSOLUTE_MS. lockScreen.js
 * checks this before ever offering biometric re-arm.
 * @returns {boolean}
 */
export function isSessionAbsoluteExpired() {
  return getSessionAgeMs() >= SESSION_ABSOLUTE_MS;
}

/**
 * Writes session data into localStorage.
 * @param {string} token
 * @param {string} userId
 * @param {'attendant'|'owner'} role
 */
function _writeSession(token, userId, role) {
  localStorage.setItem("vintex_session_token", token);
  localStorage.setItem("vintex_user", userId);
  localStorage.setItem("vintex_role", role);
  localStorage.setItem("vintex_session_issued_at", String(Date.now()));
}

/**
 * Clears the active session from localStorage. Called on explicit
 * logout, automatically by api.js whenever the gateway returns a 401
 * (token expired or invalid), and by lockScreen.js whenever idle-lock
 * or absolute-expiry forces a fresh PIN login.
 */
export function clearSession() {
  localStorage.removeItem("vintex_session_token");
  localStorage.removeItem("vintex_user");
  localStorage.removeItem("vintex_role");
  localStorage.removeItem("vintex_session_issued_at");
}

// ─────────────────────────────────────────────────────
// Auth gate bootstrapper
// ─────────────────────────────────────────────────────

/**
 * Boots the login screen gate. If a session token already exists,
 * the login screen is hidden immediately and `onAuthenticatedCallback`
 * fires — same as before, just no signature/expiry check here (the
 * first real API call will catch a stale token).
 *
 * Otherwise, listens for form submission, sends the PIN to
 * POST /api/auth/login, and on success:
 *   1. Persists { token, user, role } to localStorage.
 *   2. Animates the login screen out.
 *   3. Updates the sidebar user pill with the active profile.
 *   4. Fires `onAuthenticatedCallback`.
 *
 * On failure: shows the inline error message, clears the input, and
 * re-focuses it — no browser popups. Same UX as before; the only
 * difference is the PIN check now happens on the server.
 *
 * @param {Function} onAuthenticatedCallback - Called once auth passes.
 */
export function initAuthGate(onAuthenticatedCallback) {
  const loginScreen = document.getElementById("login-screen");
  const loginForm = document.getElementById("login-form");
  const pinInput = document.getElementById("login-pin-input");
  const errorMsg = document.getElementById("login-error-msg");
  const submitBtn = loginForm?.querySelector("button[type='submit']");

  // ── Already authenticated in this tab ──
  if (isAuthenticated()) {
    _hideLoginScreen(loginScreen);
    _applySessionToUI();
    onAuthenticatedCallback();
    return;
  }

  // ── Wire form submission ──
  if (!loginForm) {
    console.error("[auth] #login-form not found in DOM.");
    return;
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const pin = pinInput?.value?.trim() ?? "";
    if (!pin) return;

    if (submitBtn) submitBtn.disabled = true;

    try {
      const response = await fetch(`${GATEWAY_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin })
      });
      const data = await response.json().catch(() => null);

      if (response.ok && data?.ok) {
        // ✅ Valid PIN
        _writeSession(data.token, data.userId, data.role);

        if (errorMsg) errorMsg.classList.add("hidden");

        // Fade out login screen
        if (loginScreen) {
          loginScreen.classList.add("opacity-0");
          loginScreen.style.transition = "opacity 0.3s ease";
          setTimeout(() => {
            loginScreen.classList.add("hidden");
            loginScreen.classList.remove("opacity-0");
          }, 320);
        }

        _applySessionToUI();
        onAuthenticatedCallback();
      } else {
        _showLoginError(errorMsg, pinInput);
      }
    } catch (networkErr) {
      // Gateway unreachable — same inline error UI, no separate
      // "network error" state, since the front desk just needs to
      // know the PIN didn't work and try again.
      console.error("[auth] Login request failed:", networkErr);
      _showLoginError(errorMsg, pinInput);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

function _showLoginError(errorMsg, pinInput) {
  if (errorMsg) errorMsg.classList.remove("hidden");
  if (pinInput) {
    pinInput.value = "";
    pinInput.focus();
    pinInput.classList.add("shake-error");
    setTimeout(() => pinInput.classList.remove("shake-error"), 500);
  }
}

// ─────────────────────────────────────────────────────
// Internal UI helpers
// ─────────────────────────────────────────────────────

/**
 * Immediately hides the login overlay without animation.
 * @param {HTMLElement|null} loginScreen
 */
function _hideLoginScreen(loginScreen) {
  if (loginScreen) loginScreen.classList.add("hidden");
}

/**
 * Injects the active user's profile into the sidebar user pill and
 * role badge, if those elements exist. Also updates avatar initials.
 */
function _applySessionToUI() {
  const user = getActiveUser();
  const role = getActiveRole();
  if (!user || !role) return;

  const avatarEl = document.getElementById("sidebar-avatar");
  if (avatarEl) avatarEl.textContent = _initials(user);

  const nameEl = document.getElementById("sidebar-user-name");
  if (nameEl) nameEl.textContent = _displayName(user);

  const roleEl = document.getElementById("sidebar-user-role");
  if (roleEl) {
    roleEl.textContent = role.charAt(0).toUpperCase() + role.slice(1);
    roleEl.className =
      role === "owner" ? "text-xs font-semibold text-amber-400" : "text-xs text-gray-500";
  }

  // Owner gets extra management controls; attendants see standard nav.
  const ownerOnlyEls = document.querySelectorAll("[data-owner-only]");
  ownerOnlyEls.forEach((el) => {
    if (role === "owner") el.classList.remove("hidden");
    else el.classList.add("hidden");
  });
}

/**
 * "attendant_2" → "A2",  "owner" → "OW"
 * @param {string} userId
 * @returns {string}
 */
function _initials(userId) {
  if (userId === "owner") return "OW";
  return "AT";
}

/**
 * "attendant_2" → "Attendant 2",  "owner" → "Owner"
 * @param {string} userId
 * @returns {string}
 */
function _displayName(userId) {
  if (userId === "owner") return "Owner";
  return "Attendant";
}