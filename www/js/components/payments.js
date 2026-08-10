/**
 * js/components/payments.js
 * ─────────────────────────────────────────────────────
 * Centralized payment-method UI + validation, shared by
 * any component that needs to collect a payment method
 * and (when required) a reference number — e.g. CheckOutModal.js.
 *
 * Exports:
 * - renderPaymentFields(containerId, method)
 * - validatePayment(method, reference)
 *
 * Also exports the DOM id constants used by the rendered
 * markup so callers can read values back out without
 * duplicating magic strings.
 */

// ─────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────

export const PAYMENT_STATUS_OPTIONS = [
  { value: "paid",    label: "Paid in full" },
  { value: "partial", label: "Partial / deposit" },
  { value: "unpaid",  label: "Pay at checkout" }
];


export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "mpesa", label: "M-Pesa" },
  { value: "bank_transfer", label: "Bank Transfer" }
];

// Label/placeholder shown for the conditional reference input, per method.
const REFERENCE_FIELD = {
  mpesa: { label: "M-Pesa Code", placeholder: "e.g. QFT3X9ZK1A" },
  bank_transfer: { label: "Bank Reference", placeholder: "e.g. FT23056789" }
};

// Methods that require a reference number before checkout can proceed.
const METHODS_REQUIRING_REFERENCE = new Set(Object.keys(REFERENCE_FIELD));

export const PAYMENT_METHOD_SELECT_ID = "payment-method-select";
export const PAYMENT_REFERENCE_WRAP_ID = "payment-reference-wrap";
export const PAYMENT_REFERENCE_LABEL_ID = "payment-reference-label";
export const PAYMENT_REFERENCE_INPUT_ID = "payment-reference-input";

export const PAYMENT_STATUS_SELECT_ID = "payment-status-select";
export const PAYMENT_DEPOSIT_INPUT_ID = "payment-deposit-input";
const PAYMENT_STATUS_WRAP_ID = "payment-status-wrap";
const PAYMENT_DEPOSIT_WRAP_ID = "payment-deposit-wrap";

function _requiresReference(method) {
  return METHODS_REQUIRING_REFERENCE.has(method);
}

// ─────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────

/**
 * Injects a payment method dropdown into `containerId`, plus a
 * conditional reference input ("M-Pesa Code" / "Bank Reference")
 * that shows automatically for methods that need one. Wires its
 * own change listener so the conditional field stays in sync
 * without any extra work from the caller.
 *
 * @param {string} containerId - id of the element to inject markup into
 * @param {string} [method="cash"] - initially selected payment method
 */
export function renderPaymentFields(containerId, method = "cash") {
  const container = document.getElementById(containerId);
  if (!container) return;

  const optionsHtml = PAYMENT_METHODS.map(
    (m) => `<option value="${m.value}" ${m.value === method ? "selected" : ""}>${m.label}</option>`
  ).join("");

  const field = REFERENCE_FIELD[method];
  const hiddenClass = _requiresReference(method) ? "" : "hidden";

  container.innerHTML = `
    <label class="block text-xs font-semibold text-gray-400 mb-1.5" for="${PAYMENT_METHOD_SELECT_ID}">Payment Method</label>
    <select id="${PAYMENT_METHOD_SELECT_ID}"
      class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
             focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors">
      ${optionsHtml}
    </select>

    <div id="${PAYMENT_REFERENCE_WRAP_ID}" class="mt-3 ${hiddenClass}">
      <label id="${PAYMENT_REFERENCE_LABEL_ID}" class="block text-xs font-semibold text-gray-400 mb-1.5" for="${PAYMENT_REFERENCE_INPUT_ID}">${field?.label ?? ""}</label>
      <input id="${PAYMENT_REFERENCE_INPUT_ID}" type="text" placeholder="${field?.placeholder ?? ""}"
        class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
               placeholder-gray-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors" />
    </div>
  `;

  const select = document.getElementById(PAYMENT_METHOD_SELECT_ID);
  select.addEventListener("change", (e) => {
    const selected = e.target.value;
    const wrap = document.getElementById(PAYMENT_REFERENCE_WRAP_ID);
    const labelEl = document.getElementById(PAYMENT_REFERENCE_LABEL_ID);
    const input = document.getElementById(PAYMENT_REFERENCE_INPUT_ID);
    const selectedField = REFERENCE_FIELD[selected];

    wrap.classList.toggle("hidden", !_requiresReference(selected));
    labelEl.textContent = selectedField?.label ?? "";
    input.placeholder = selectedField?.placeholder ?? "";
    input.value = "";
  });
}

/**
 * Injects a "Payment Status" segmented control (Paid in full / Partial /
 * Pay at checkout) into `containerId`, plus a conditional "Deposit
 * amount" number input that shows only when status === "partial" —
 * mirrors the show/hide pattern used for the reference field in
 * renderPaymentFields().
 *
 * @param {string} containerId - id of the element to inject markup into
 * @param {string} [status="paid"] - initially selected payment status
 */
export function renderPaymentStatusFields(containerId, status = "paid") {
  const container = document.getElementById(containerId);
  if (!container) return;

  const buttonsHtml = PAYMENT_STATUS_OPTIONS.map(
    (opt) => `
      <button type="button" data-status="${opt.value}"
        class="payment-status-btn py-2.5 px-3 rounded-lg border text-sm font-medium transition-colors
               ${opt.value === status ? "bg-brand-700 border-brand-500 text-white" : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500"}">
        ${opt.label}
      </button>`
  ).join("");

  const depositHidden = status === "partial" ? "" : "hidden";

  container.innerHTML = `
    <label class="block text-xs font-semibold text-gray-400 mb-1.5">Payment Status</label>
    <input type="hidden" id="${PAYMENT_STATUS_SELECT_ID}" value="${status}" />
    <div id="${PAYMENT_STATUS_WRAP_ID}" class="grid grid-cols-3 gap-2">
      ${buttonsHtml}
    </div>

    <div id="${PAYMENT_DEPOSIT_WRAP_ID}" class="mt-3 ${depositHidden}">
      <label class="block text-xs font-semibold text-gray-400 mb-1.5" for="${PAYMENT_DEPOSIT_INPUT_ID}">Deposit amount</label>
      <input id="${PAYMENT_DEPOSIT_INPUT_ID}" type="number" min="0" step="1" placeholder="e.g. 2000"
        class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white
               placeholder-gray-600 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-colors" />
    </div>
  `;

  const statusHiddenInput = document.getElementById(PAYMENT_STATUS_SELECT_ID);
  const statusWrap = document.getElementById(PAYMENT_STATUS_WRAP_ID);
  const depositWrap = document.getElementById(PAYMENT_DEPOSIT_WRAP_ID);

  statusWrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".payment-status-btn");
    if (!btn) return;

    const selected = btn.dataset.status;
    statusHiddenInput.value = selected;

    statusWrap.querySelectorAll(".payment-status-btn").forEach((b) => {
      const active = b.dataset.status === selected;
      b.classList.toggle("bg-brand-700", active);
      b.classList.toggle("border-brand-500", active);
      b.classList.toggle("text-white", active);
      b.classList.toggle("bg-gray-800", !active);
      b.classList.toggle("border-gray-700", !active);
      b.classList.toggle("text-gray-400", !active);
    });

    depositWrap.classList.toggle("hidden", selected !== "partial");
    if (selected !== "partial") {
      const depositInput = document.getElementById(PAYMENT_DEPOSIT_INPUT_ID);
      if (depositInput) depositInput.value = "";
    }

    // Let listeners (e.g. validation-message clearing) know something changed.
    statusWrap.dispatchEvent(new CustomEvent("payment-status-change", { bubbles: true, detail: { status: selected } }));
  });
}

// ─────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────

/**
 * Validates a payment method + reference combination.
 * Cash needs no reference; M-Pesa and Bank Transfer both
 * require a non-empty reference value.
 *
 * @param {string} method - "cash" | "mpesa" | "bank_transfer"
 * @param {string} reference - the M-Pesa code / bank reference value (if applicable)
 * @returns {{ valid: boolean, message: string }}
 */
export function validatePayment(method, reference) {
  if (!method) {
    return { valid: false, message: "Select a payment method to continue." };
  }

  if (_requiresReference(method)) {
    const ref = (reference ?? "").trim();
    if (!ref) {
      const label = REFERENCE_FIELD[method]?.label ?? "reference number";
      return { valid: false, message: `Enter the ${label} to continue.` };
    }
  }

  return { valid: true, message: "" };
}

/**
 * Validates a payment status + (conditional) deposit amount combination.
 *
 * @param {string} status - "paid" | "partial" | "unpaid"
 * @param {number|string} depositAmount - deposit value (only checked when status === "partial")
 * @param {number} groupGrandTotal - the group's combined grand_total, deposit must be strictly between 0 and this
 * @returns {{ valid: boolean, message: string }}
 */
export function validatePaymentStatus(status, depositAmount, groupGrandTotal) {
  if (!status) {
    return { valid: false, message: "Select a payment status to continue." };
  }

  if (status === "partial") {
    const deposit = Number(depositAmount);
    if (!Number.isFinite(deposit) || deposit <= 0) {
      return { valid: false, message: "Enter a deposit amount greater than 0." };
    }
    if (deposit >= Number(groupGrandTotal)) {
      return { valid: false, message: "Deposit amount must be less than the group grand total." };
    }
  }

  return { valid: true, message: "" };
}
