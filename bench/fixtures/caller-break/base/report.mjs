import { formatPrice } from './lib/format.mjs';

export function summary(orders) {
  const total = orders.reduce((sum, order) => sum + order.cents, 0);
  return `Total: ${formatPrice(total)}`;
}
