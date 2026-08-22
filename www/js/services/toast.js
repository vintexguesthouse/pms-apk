/**
 * js/services/toast.js
 * ─────────────────────────────────────────────────────
 * Shared toast helper — moved out of main.js unchanged so components
 * (Receipt.js, BookingHistory.js) can surface failures to the user
 * without importing main.js back (main.js already imports
 * BookingHistory.js, so that would be a circular import).
 *
 * Uses the same #toast / #toast-icon / #toast-title / #toast-body
 * elements already in index.html — no new UI, no new markup.
 *
 * Exports:
 *   showToast(type, title, body?) → void
 */

let _toastTimer = null;

export function showToast(type, title, body = "") {
  const toast = document.getElementById("toast");
  const iconEl = document.getElementById("toast-icon");
  const titleEl = document.getElementById("toast-title");
  const bodyEl = document.getElementById("toast-body");
  if (!toast) return;

  const icons = { success: "✅", error: "❌", info: "ℹ️" };
  iconEl.textContent = icons[type] ?? "ℹ️";
  titleEl.textContent = title;
  bodyEl.textContent = body;

  toast.classList.remove("translate-y-10", "opacity-0", "pointer-events-none");
  toast.classList.add("translate-y-0", "opacity-100");

  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    toast.classList.add("translate-y-10", "opacity-0", "pointer-events-none");
    toast.classList.remove("translate-y-0", "opacity-100");
  }, 3500);
}