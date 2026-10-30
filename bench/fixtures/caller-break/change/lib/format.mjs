const SYMBOLS = { USD: '$', EUR: '€' };

export function formatPrice({ cents, currency = 'USD' }) {
  return `${SYMBOLS[currency]}${(cents / 100).toFixed(2)}`;
}
