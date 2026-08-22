// services/currency.js
//
// Converts KES prices (what's actually charged/stored in Airtable) into
// a currency the guest picks, for DISPLAY ONLY. Uses ExchangeRate-API's
// free open-access endpoint (no key, no signup): 
// https://www.exchangerate-api.com/docs/free — updates once daily,
// which is fine for an estimate. The real charge always happens in KSh
// on arrival; nothing here touches the actual booking math.

const RATES_URL = 'https://open.er-api.com/v6/latest/KES';
const RATES_CACHE_TTL_MS = 60 * 60 * 1000; // 1hr client cache — upstream data itself only refreshes daily
const PREFERRED_CURRENCY_KEY = 'vintex_preferred_currency';

// Curated shortlist, not all ~160 currencies the API supports — keeps the
// picker to currencies guests are actually likely to want.
export const SUPPORTED_CURRENCIES = [
  { code: 'USD', label: 'US Dollar', symbol: '$' },
  { code: 'EUR', label: 'Euro', symbol: '€' },
  { code: 'GBP', label: 'British Pound', symbol: '£' },
  { code: 'KES', label: 'Kenyan Shilling', symbol: 'KSh' }
];

let _ratesCache = null;
let _ratesPromise = null;

async function _getRates() {
  const now = Date.now();
  if (_ratesCache && now - _ratesCache.timestamp < RATES_CACHE_TTL_MS) return _ratesCache.rates;
  if (_ratesPromise) return _ratesPromise;

  _ratesPromise = (async () => {
    const res = await fetch(RATES_URL);
    if (!res.ok) throw new Error(`Failed to load exchange rates (${res.status})`);
    const data = await res.json();
    _ratesCache = { timestamp: now, rates: data.rates };
    return data.rates;
  })();

  try {
    return await _ratesPromise;
  } finally {
    _ratesPromise = null;
  }
}

/**
 * Converts a KES amount into `currencyCode`. Returns null on any failure
 * (rather than throwing) so a flaky rates fetch just means "show KSh
 * only" instead of breaking the price display.
 */
export async function convertFromKES(amountKES, currencyCode) {
  if (currencyCode === 'KES') return amountKES;
  try {
    const rates = await _getRates();
    const rate = rates?.[currencyCode];
    return rate ? amountKES * rate : null;
  } catch {
    return null;
  }
}

export function getPreferredCurrency() {
  try {
    return localStorage.getItem(PREFERRED_CURRENCY_KEY) || 'USD';
  } catch {
    return 'USD'; // private browsing etc. — just don't persist
  }
}

export function setPreferredCurrency(code) {
  try {
    localStorage.setItem(PREFERRED_CURRENCY_KEY, code);
  } catch {
    /* non-fatal — picker still works for this page load */
  }
}

export function formatCurrency(amount, currencyCode) {
  const meta = SUPPORTED_CURRENCIES.find((c) => c.code === currencyCode);
  const symbol = meta?.symbol ?? currencyCode;
  if (currencyCode === 'KES') return `${symbol} ${Math.round(amount).toLocaleString('en-KE')}`;
  return `${symbol}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}