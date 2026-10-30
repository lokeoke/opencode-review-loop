export function canDelete(userId, ownerId) {
  return userId === ownerId;
}
