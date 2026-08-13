/**
 * js/services/lockScreen.js
 * ─────────────────────────────────────────────────────
 * Idle-lock + biometric re-arm, layered on top of auth.js's existing
 * PIN session. Design (agreed before writing this file):
 *
 *  - 15 minutes with NO touch on the app AT ALL — including the app
 *    being backgrounded/switched away from without exiting — locks
 *    the screen. Any touch/click/keydown resets the clock while the
 *    app is foregrounded and unlocked.
 *  - While locked, and while the session is still under the 1-hour
 *    absolute ceiling (auth.js: SESSION_ABSOLUTE_MS), biometric
 *    success is treated as fully equivalent to a correct PIN for the
 *    narrow purpose of re-arming the already-open app — it's a LOCAL
 *    re-arm of the still-valid token already in localStorage, no
 *    network call, nothing sent to the Worker.
 *  - If biometrics aren't available/enrolled on the device, or the
 *    person taps "Use PIN instead", or the 1-hour ceiling has been
 *    crossed — fall through to a full PIN login. That reuses the
 *    existing #login-screen / initAuthGate() flow verbatim (via
 *    clearSession() + reload), rather than duplicating any of that
 *    UI or validation logic here.
 *  - Biometrics only ever gate access to a token that's already
 *    sitting in localStorage — they never mint a new one and the
 *    Worker is never told anything about them. A stolen token is
 *    just as valid without this lock screen as with it; this is a
 *    presence-check UX layer, not a replacement for token security.
 *
 * Exports:
 *   initLockScreen()  → void   (call once, after auth passes)
 */

import { isAuthenticated, isSessionAbsoluteExpired, clearSession } from "./auth.js";

// NOTE: this app is served as raw static files (no Vite/webpack/esbuild
// bundling step), so bare specifiers like "@capacitor/core" can't be
// resolved by the browser's native ES module loader — only a bundler
// rewrites those into real paths. On a native build, Capacitor's runtime
// injects a `window.Capacitor` global itself (that's what the npm
// `@capacitor/core` package normally just wraps), so we read off that
// instead of importing the package. In a plain browser tab (dev/preview,
// no native shell) `window.Capacitor` is simply undefined, so we fall
// back to a small stub whose `isNativePlatform()` returns false — every
// call site in this file already branches off that check.
const Capacitor = window.Capacitor ?? { isNativePlatform: () => false, Plugins: {} };
// The official @capacitor/app plugin auto-registers itself on
// window.Capacitor.Plugins.App inside a real native shell — same object,
// same method names (addListener, etc.) the npm wrapper would give you.
const CapApp = Capacitor.Plugins?.App;

const IDLE_MS = 15 * 60 * 1000; // 15 minutes
const ACTIVITY_EVENTS = ["click", "touchstart", "keydown", "scroll", "mousemove"];

let _idleTimer = null;
let _isLocked = false;
let _backgroundedAt = null;
let _lockEl = null;
let _unlockBtn = null;
let _pinFallbackBtn = null;
let _statusEl = null;

/**
 * Wires activity listeners, background/foreground tracking, and the
 * lock overlay's buttons. Call once, after the auth gate passes.
 */
export function initLockScreen() {
  _lockEl = document.getElementById("lock-screen");
  _unlockBtn = document.getElementById("lock-unlock-btn");
  _pinFallbackBtn = document.getElementById("lock-pin-fallback-btn");
  _statusEl = document.getElementById("lock-status-msg");

  if (!_lockEl || !_unlockBtn || !_pinFallbackBtn) {
    console.error("[lockScreen] Required DOM elements missing — lock screen disabled.");
    return;
  }

  _unlockBtn.addEventListener("click", async () => {
    _unlockBtn.disabled = true;
    const ok = await _tryBiometric();
    _unlockBtn.disabled = false;
    if (ok) {
      _unlock();
    } else {
      _showStatus("Verification didn't go through. Try again, or use your PIN.");
    }
  });

  _pinFallbackBtn.addEventListener("click", _forceFullLogin);

  ACTIVITY_EVENTS.forEach((evt) => document.addEventListener(evt, _resetIdleTimer, { passive: true }));

  if (Capacitor.isNativePlatform() && CapApp) {
    CapApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) {
        _backgroundedAt = Date.now();
      } else {
        _onForeground();
      }
    });
  } else {
    // Browser/dev fallback — no native app-state event, so tab
    // visibility is the closest equivalent.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        _backgroundedAt = Date.now();
      } else {
        _onForeground();
      }
    });
  }

  _resetIdleTimer();
}

// ─────────────────────────────────────────────────────
// Idle timer
// ─────────────────────────────────────────────────────

function _resetIdleTimer() {
  if (_isLocked) return; // don't fight the lock screen once it's up
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(_lock, IDLE_MS);
}

function _onForeground() {
  if (!_backgroundedAt) return;
  const awayMs = Date.now() - _backgroundedAt;
  _backgroundedAt = null;
  if (awayMs >= IDLE_MS) {
    _lock();
  } else {
    _resetIdleTimer();
  }
}

// ─────────────────────────────────────────────────────
// Lock / unlock
// ─────────────────────────────────────────────────────

async function _lock() {
  if (!isAuthenticated() || _isLocked) return;
  _isLocked = true;
  clearTimeout(_idleTimer);

  _lockEl.classList.remove("hidden");
  requestAnimationFrame(() => _lockEl.classList.remove("opacity-0"));
  _hideStatus();

  if (isSessionAbsoluteExpired()) {
    // Hard boundary — no amount of biometric success can revive a
    // token this old. Skip straight to PIN-only.
    _unlockBtn.classList.add("hidden");
    _showStatus("Your session has expired. Please log in again.");
    return;
  }

  const available = await _biometricAvailable();
  _unlockBtn.classList.toggle("hidden", !available);
  if (!available) {
    _showStatus("Biometrics aren't set up on this device — use your PIN to continue.");
  }
}

function _unlock() {
  _isLocked = false;
  _lockEl.classList.add("opacity-0");
  setTimeout(() => _lockEl.classList.add("hidden"), 200);
  _resetIdleTimer();
}

/**
 * Always routes through the real login screen — clears the session
 * and reloads, letting auth.js's initAuthGate() take over exactly as
 * it does for a manual logout or a 401. No duplicate PIN-entry UI
 * lives in this file on purpose.
 */
function _forceFullLogin() {
  clearSession();
  window.location.reload();
}

// ─────────────────────────────────────────────────────
// Biometric plugin bridge
// ─────────────────────────────────────────────────────

async function _biometricAvailable() {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const { NativeBiometric } = await import("@capgo/capacitor-native-biometric");
    const result = await NativeBiometric.isAvailable();
    return Boolean(result?.isAvailable);
  } catch (err) {
    console.error("[lockScreen] Biometric availability check failed:", err);
    return false;
  }
}

async function _tryBiometric() {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const { NativeBiometric } = await import("@capgo/capacitor-native-biometric");
    await NativeBiometric.verifyIdentity({
      reason: "Verify to resume your Vintex PMS session",
      title: "Unlock Vintex PMS",
      subtitle: "Session locked after inactivity",
      description: ""
    });
    return true; // resolves only on genuine success; rejects on failure/cancel
  } catch (err) {
    // Expected on cancel/failure — not logged as an error, just a "no."
    return false;
  }
}

// ─────────────────────────────────────────────────────
// Status message helpers
// ─────────────────────────────────────────────────────

function _showStatus(message) {
  if (!_statusEl) return;
  _statusEl.textContent = message;
  _statusEl.classList.remove("hidden");
}

function _hideStatus() {
  if (!_statusEl) return;
  _statusEl.classList.add("hidden");
  _statusEl.textContent = "";
}