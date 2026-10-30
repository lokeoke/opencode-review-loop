export function slugify(text, { maxLength = Infinity } = {}) {
  const slug = text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug.slice(0, maxLength).replace(/-$/, '');
}
