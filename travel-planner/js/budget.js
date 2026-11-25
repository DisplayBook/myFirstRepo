// Costs and budget: currency conversion, totals by category and by day.
// Pure functions (no DOM), unit-tested.

import { TYPES, datePart, addDays, daysBetween, itemTitle } from './logic.js';

export const CURRENCIES = ['GBP', 'EUR', 'USD', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'CNY', 'HKD', 'SGD', 'THB', 'INR', 'AED', 'ZAR',
  'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'MXN', 'BRL', 'KRW', 'IDR', 'MYR', 'PHP', 'VND', 'ILS', 'ISK', 'EGP', 'MAD'];

/** A sensible home currency from the browser's region. */
export function guessCurrency(locale = (typeof navigator !== 'undefined' && navigator.language) || 'en-GB') {
  const region = (String(locale).split(/[-_]/)[1] || '').toUpperCase();
  const map = { GB: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', CH: 'CHF', JP: 'JPY', IN: 'INR', SE: 'SEK', NO: 'NOK', DK: 'DKK',
    PL: 'PLN', ZA: 'ZAR', SG: 'SGD', HK: 'HKD', AE: 'AED', MX: 'MXN', BR: 'BRL', IE: 'EUR', FR: 'EUR', DE: 'EUR', ES: 'EUR', IT: 'EUR',
    NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR' };
  return map[region] || 'USD';
}

export const homeCurrency = (meta = {}) => meta.currency || guessCurrency();

export function fmtMoney(amount, currency, { whole = false } = {}) {
  if (amount == null || !isFinite(amount)) return '';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: whole ? 0 : undefined, minimumFractionDigits: whole ? 0 : undefined,
    }).format(amount);
  } catch {
    return `${amount.toFixed(whole ? 0 : 2)} ${currency}`;
  }
}

export const hasCost = (it) => it.cost !== undefined && it.cost !== null && it.cost !== '' && isFinite(Number(it.cost));

/**
 * Convert to the home currency. rates[CUR] = home-currency units for 1 CUR.
 * Returns null when there's no rate for that currency.
 */
export function toHome(amount, currency, home, rates = {}) {
  const n = Number(amount);
  if (!isFinite(n)) return null;
  if (!currency || currency === home) return n;
  const r = Number(rates[currency]);
  return isFinite(r) && r > 0 ? n * r : null;
}

/**
 * How a booking's cost falls across days: hotels over their nights, car hire
 * over its days, everything else on its start date.
 */
export function spreadCost(it, amount) {
  const start = datePart(it.start);
  if (!start) return [];
  const end = datePart(it.end);
  let days = [start];
  if (it.type === 'hotel' && end > start) {
    days = Array.from({ length: daysBetween(start, end) }, (_, i) => addDays(start, i));
  } else if (it.type === 'car' && end > start) {
    days = Array.from({ length: daysBetween(start, end) }, (_, i) => addDays(start, i));
  }
  const share = amount / days.length;
  return days.map((date) => ({ date, amount: share }));
}

/**
 * Payment state of a booking, in the booking's own currency.
 * status: 'full' (paid in full), 'deposit' (part paid) or 'none'.
 */
export function payment(it) {
  const cost = hasCost(it) ? Number(it.cost) : 0;
  if (it.paid) return { status: 'full', paid: cost, due: 0, balanceDue: '' };
  const dep = Number(it.deposit);
  if (isFinite(dep) && dep > 0) {
    const paid = Math.min(dep, cost);
    return { status: 'deposit', paid, due: Math.max(0, cost - paid), balanceDue: it.balanceDue || '' };
  }
  return { status: 'none', paid: 0, due: cost, balanceDue: it.balanceDue || '' };
}

/** Everything the Budget screen shows. Amounts are in the home currency. */
export function budgetSummary(items, meta = {}, today = '') {
  const home = homeCurrency(meta);
  const rates = meta.rates || {};
  const byType = Object.fromEntries(Object.keys(TYPES).map((k) => [k, 0]));
  const byDay = {};
  const rows = [];
  const uncosted = [];
  const missingRates = new Set();
  let total = 0, paid = 0;
  for (const it of items) {
    if (!hasCost(it)) { uncosted.push(it); continue; }
    const currency = it.currency || home;
    const value = toHome(it.cost, currency, home, rates);
    const pay = payment(it);
    const ratio = Number(it.cost) > 0 ? pay.paid / Number(it.cost) : (pay.status === 'full' ? 1 : 0);
    const paidValue = value === null ? null : value * ratio;
    rows.push({
      item: it, title: itemTitle(it), cost: Number(it.cost), currency, value,
      status: pay.status, paid: pay.status === 'full', paidLocal: pay.paid, dueLocal: pay.due,
      paidValue, dueValue: value === null ? null : value - paidValue, balanceDue: pay.balanceDue,
    });
    if (value === null) { missingRates.add(currency); continue; }
    total += value;
    paid += paidValue;
    byType[it.type] = (byType[it.type] || 0) + value;
    for (const s of spreadCost(it, value)) byDay[s.date] = (byDay[s.date] || 0) + s.amount;
  }
  rows.sort((a, b) => String(a.item.start || '').localeCompare(String(b.item.start || '')));
  // What's still to pay, soonest deadline first (balance-due date, else the booking's start).
  const upcoming = rows.filter((r) => r.dueLocal > 0.005)
    .map((r) => {
      const by = r.balanceDue || datePart(r.item.start) || '';
      return { ...r, by, overdue: !!(today && by && by < today) };
    })
    .sort((a, b) => (a.by || '~').localeCompare(b.by || '~'));
  const budget = Number(meta.budget) > 0 ? Number(meta.budget) : null;
  return {
    home, total, paid, unpaid: total - paid, budget,
    remaining: budget === null ? null : budget - total,
    byType, byDay, rows, upcoming, uncosted, missingRates: [...missingRates].sort(),
  };
}

/** Parse a typed amount like "1,234.50" or "1.234,50" or "£80". */
export function parseAmount(s) {
  if (typeof s === 'number') return isFinite(s) ? s : null;
  let t = String(s ?? '').replace(/[^\d.,-]/g, '');
  if (!t) return null;
  const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
  if (lastComma > lastDot) {
    // Comma is the decimal mark if followed by 1-2 digits ("12,50"), else a thousands separator.
    t = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else {
    t = t.replace(/,/g, '');
  }
  const n = Number(t);
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
