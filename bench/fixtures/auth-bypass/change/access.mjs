export const ADMIN = 'admin';

// Owners may delete their own records; admins may delete any record.
export function canDelete(userId, ownerId, role) {
  if (role === ADMIN) return true;
  return !userId || userId === ownerId;
}
