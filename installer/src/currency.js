// @ts-check
/**
 * The reporting currency: the currency symbol the report's Estimated Value page shows money with.
 * The amounts themselves are the report's assumptions, which people set in the report.
 */

export const DEFAULT_CURRENCY = 'USD';

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
 * The installer's choice, kept in the install record.
 * @typedef {object} ReportingConfig
 * @property {string} currency  ISO 4217 code.
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
 * The saved choice, cleaned: a known currency.
 * @param {unknown} raw
 * @returns {ReportingConfig | undefined}
 */
export function normaliseReporting(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const currency = toCurrencyCode(/** @type {any} */ (raw).currency);
  return currency ? { currency } : undefined;
}

/**
 * The plan review's words for the report's currency.
 * @param {ReportingConfig | undefined} reporting
 */
export function describeReporting(reporting) {
  const code = reporting?.currency ?? DEFAULT_CURRENCY;
  return `The Estimated Value page shows money in ${code} (${currencySymbol(code)}).`;
}
