export async function save(store, user) {
  await store.write(user.id, user);
  return true;
}
