export function applyDiscount(price, percent) {
  return Math.round(price * (100 - percent)) / 100;
}

export function applyCoupon(price, coupon) {
  return applyDiscount(price, coupon.percent);
}
