export async function save(store, user) {
  await store.write(user.id, user);
  return true;
}

// Retries transient write failures before giving up.
export async function saveWithRetry(store, user, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      store.write(user.id, user);
      return true;
    } catch {
      if (attempt === attempts) return false;
    }
  }
}
