export function displayName(user) {
  if (user.nickname && user.nickname.trim() !== '') return user.nickname.trim();
  return `${user.first.trim()} ${user.last.trim()}`;
}

export function initials(user) {
  return `${user.first.trim()[0]}${user.last.trim()[0]}`.toUpperCase();
}
