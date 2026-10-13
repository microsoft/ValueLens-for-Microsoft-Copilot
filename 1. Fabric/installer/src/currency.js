// @ts-check
/**
 * The reporting currency: the one currency the Value page shows value and cost in.
 * Licences and credits are billed in US dollars, so another currency needs a rate.
 * Keep CURRENCIES in step with `1. Fabric/Fabric App/src/lib/currency.ts`.
 */

export const DEFAULT_CURRENCY = 'USD';
/** The largest rate accepted, in units of the reporting currency per US dollar. */
export const MAX_RATE = 100000;

/** @typedef {{ code: string, name: string, symbol: string }} Currency */

/** @type {readonly Currency[]} */
export const CURRENCIES = [
  { code: 'USD', name: 'US dollar', symbol: '$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British pound', symbol: '£' },
  { code: 'AUD', name: 'Australian dollar', symbol: 'A$' },
  { code: 'BRL', name: 'Brazilian real', symbol: 'R$' },
  { code: 'CAD', name: 'Canadian dollar', symbol: 'C$' },
  { code: 'CHF', name: 'Swiss franc', symbol: 'CHF' },
  { code: 'DKK', name: 'Danish krone', symbol: 'DKK' },
  { code: 'INR', name: 'Indian rupee', symbol: '₹' },
  { code: 'JPY', name: 'Japanese yen', symbol: '¥' },
  { code: 'MXN', name: 'Mexican peso', symbol: 'MX$' },
  { code: 'NOK', name: 'Norwegian krone', symbol: 'NOK' },
  { code: 'NZD', name: 'New Zealand dollar', symbol: 'NZ$' },
  { code: 'SEK', name: 'Swedish krona', symbol: 'SEK' },
  { code: 'SGD', name: 'Singapore dollar', symbol: 'S$' },
  { code: 'ZAR', name: 'South African rand', symbol: 'R' },
];

/**
 * The installer's choice, kept in the install record and passed to the app as its default.
 * @typedef {object} ReportingConfig
 * @property {string} currency  ISO 4217 code.
 * @property {number} [exchangeRate]  Units of the currency per US dollar. Never set for USD.
 */

/** @param {unknown} value @returns {string | undefined} */
export function toCurrencyCode(value) {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toUpperCase();
  return CURRENCIES.some((c) => c.code === code) ? code : undefined;
}

/** @param {string} code */
export const currencySymbol = (code) => CURRENCIES.find((c) => c.code === code)?.symbol ?? code;

/**
 * A typed rate: undefined when blank, otherwise a positive number up to MAX_RATE.
 * @param {string} text
 * @returns {number | undefined | string}  The rate, undefined for blank, or why it was refused.
 */
export function parseRate(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  const rate = Number(trimmed);
  if (!Number.isFinite(rate) || rate <= 0) return 'Type a number above 0, or leave it blank.';
  if (rate > MAX_RATE) return `Type a number up to ${MAX_RATE}.`;
  return rate;
}

/**
 * The saved choice, cleaned: a known currency and, for anything but USD, a valid rate.
 * @param {unknown} raw
 * @returns {ReportingConfig | undefined}
 */
export function normaliseReporting(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const currency = toCurrencyCode(/** @type {any} */ (raw).currency);
  if (!currency) return undefined;
  const rate = /** @type {any} */ (raw).exchangeRate;
  const exchangeRate = currency !== 'USD' && typeof rate === 'number' && rate > 0 && rate <= MAX_RATE ? rate : undefined;
  return exchangeRate === undefined ? { currency } : { currency, exchangeRate };
}

/**
 * The plan review's words for the Value page currency.
 * @param {ReportingConfig | undefined} reporting
 */
export function describeReporting(reporting) {
  const currency = reporting?.currency ?? DEFAULT_CURRENCY;
  if (currency === DEFAULT_CURRENCY) return 'The Value page reports in US dollars.';
  return reporting?.exchangeRate
    ? `The Value page reports in ${currency}, at ${reporting.exchangeRate} to $1.`
    : `The Value page reports in ${currency}; set its rate under Prices in the app.`;
}
