// services/reservationMessage.js
//
// ONE function builds the reservation summary. WhatsApp text, mailto body,
// and the on-screen/print receipt all render from this object rather than
// keeping three copies of the same content in sync by hand.

import { ksh, fmtDate, nightsBetween, escapeHtml } from "../utils.js";

const GUESTHOUSE_NAME = "Vintex Guest House";
const GUESTHOUSE_PHONE_DISPLAY = "+254 726 766 023";
const GUESTHOUSE_WHATSAPP_NUMBER = "254726766023"; // no + or leading zero, wa.me format
// TODO: confirm this is the real business inbox — placeholder, please replace.
const GUESTHOUSE_EMAIL = "reservations@vintexguesthouse.com";

/**
 * @param {object} reservation
 * @param {string} reservation.id
 * @param {Array<{categoryId: string, categoryName: string, pricePerNight: number, quantity: number}>} reservation.lineItems
 * @param {string} reservation.checkIn  ISO date
 * @param {string} reservation.checkOut ISO date
 * @param {string} reservation.guestName
 * @param {string} reservation.guestPhone
 * @param {string} [reservation.guestEmail]
 * @param {number} reservation.numGuests
 * @param {string} [reservation.notes]
 */
export function buildReservationSummary(reservation) {
  const nights = nightsBetween(reservation.checkIn, reservation.checkOut);
  const lineItems = reservation.lineItems || [];
  const subtotal = lineItems.reduce((sum, li) => sum + nights * li.quantity * li.pricePerNight, 0);

  const lineItemTextLines = lineItems.map(
    (li) => `${li.categoryName} × ${li.quantity}  (${ksh(nights * li.quantity * li.pricePerNight)})`
  );

  const lines = [
    `${GUESTHOUSE_NAME} — Reservation ${reservation.id}`,
    "",
    ...lineItemTextLines,
    `Check-in:  ${fmtDate(reservation.checkIn)}`,
    `Check-out: ${fmtDate(reservation.checkOut)}`,
    `${nights} night${nights === 1 ? "" : "s"} · ${reservation.numGuests} guest${
      reservation.numGuests === 1 ? "" : "s"
    }`,
    "",
    `Guest: ${reservation.guestName}`,
    `Phone: ${reservation.guestPhone}`,
    reservation.guestEmail ? `Email: ${reservation.guestEmail}` : null,
    reservation.notes ? `Notes: ${reservation.notes}` : null,
    `Payment: ${
      reservation.paymentPreference === "advance"
        ? "Advance — we'll be in touch"
        : "On arrival"
    }`,
    "",
    `Estimated total: ${ksh(subtotal)}`,
    "",
    "Status: Pending — we will confirm shortly.",
    `Questions? Call or WhatsApp ${GUESTHOUSE_PHONE_DISPLAY}.`
  ].filter((line) => line !== null);

  const text = lines.join("\n");

  const lineItemRowsHtml = lineItems
    .map(
      (li) => `
      <div class="receipt__row receipt__row--main">
        <span>${escapeHtml(li.categoryName)} × ${li.quantity}</span>
        <span>${ksh(nights * li.quantity * li.pricePerNight)}</span>
      </div>`
    )
    .join("");

  const html = `
    <div class="receipt">
      <div class="receipt__header">
        <div class="receipt__eyebrow">${escapeHtml(GUESTHOUSE_NAME)}</div>
        <div class="receipt__ref">${escapeHtml(reservation.id)}</div>
      </div>

      <div class="receipt__status receipt__status--pending">Pending confirmation</div>
      ${lineItemRowsHtml}

      <div class="receipt__divider"></div>

      <dl class="receipt__details">
        <dt>Check-in</dt><dd>${escapeHtml(fmtDate(reservation.checkIn))}</dd>
        <dt>Check-out</dt><dd>${escapeHtml(fmtDate(reservation.checkOut))}</dd>
        <dt>Nights</dt><dd>${nights}</dd>
        <dt>Guests</dt><dd>${reservation.numGuests}</dd>
      </dl>

      <div class="receipt__divider"></div>

      <dl class="receipt__details">
        <dt>Name</dt><dd>${escapeHtml(reservation.guestName)}</dd>
        <dt>Phone</dt><dd>${escapeHtml(reservation.guestPhone)}</dd>
        ${reservation.guestEmail ? `<dt>Email</dt><dd>${escapeHtml(reservation.guestEmail)}</dd>` : ""}
        ${reservation.notes ? `<dt>Notes</dt><dd>${escapeHtml(reservation.notes)}</dd>` : ""}
        <dt>Payment</dt><dd>${
          reservation.paymentPreference === "advance"
            ? "Advance — we'll be in touch"
            : "On arrival"
        }</dd>
      </dl>

      <div class="receipt__divider"></div>

      <div class="receipt__row receipt__row--total">
        <span>Estimated total</span>
        <span>${ksh(subtotal)}</span>
      </div>

      <p class="receipt__footnote">
        This confirms we have received your request — it is not yet a confirmed
        booking. We will reach you on ${escapeHtml(reservation.guestPhone)} shortly.
        Questions in the meantime? Call or WhatsApp ${escapeHtml(GUESTHOUSE_PHONE_DISPLAY)}.
      </p>
    </div>
  `;

  return { text, html, subtotal, nights };
}

/**
 * Builds a wa.me link prefilled with the reservation summary, addressed
 * to the guesthouse's own WhatsApp line (the attendant reads it there).
 */
export function buildWhatsAppLink(reservation, summaryText) {
  const encoded = encodeURIComponent(summaryText);
  return `https://wa.me/${GUESTHOUSE_WHATSAPP_NUMBER}?text=${encoded}`;
}

/**
 * Builds a mailto: link addressed to the guesthouse's own business inbox
 * (so a staff member actually receives the reservation), CC'ing the guest
 * at their own address if they supplied one so they get a copy too.
 */
export function buildMailtoLink(reservation, summaryText) {
  const subject = encodeURIComponent(`New reservation ${reservation.id} — ${GUESTHOUSE_NAME}`);
  const body = encodeURIComponent(summaryText);
  const cc = reservation.guestEmail ? `&cc=${encodeURIComponent(reservation.guestEmail)}` : "";
  return `mailto:${GUESTHOUSE_EMAIL}?subject=${subject}&body=${body}${cc}`;
}

export const GUESTHOUSE = {
  name: GUESTHOUSE_NAME,
  phoneDisplay: GUESTHOUSE_PHONE_DISPLAY,
  whatsappNumber: GUESTHOUSE_WHATSAPP_NUMBER,
  email: GUESTHOUSE_EMAIL
};