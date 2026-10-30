const clean = (value) => value.trim();

export function displayName(user) {
  const nickname = user.nickname ? clean(user.nickname) : '';
  if (nickname) return nickname;
  return `${clean(user.first)} ${clean(user.last)}`;
}

export function initials(user) {
  return `${clean(user.first)[0]}${clean(user.last)[0]}`.toUpperCase();
}
