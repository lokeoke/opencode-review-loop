export function applyDiscount(price, percent) {
  const bounded = Math.min(Math.max(percent, 0), 100);
  return Math.round(price * (100 - bounded)) / 100;
}
