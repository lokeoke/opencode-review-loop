export function paginate(items, page, size) {
  const start = (page - 1) * size;
  return {
    items: items.slice(start, start + size),
    totalPages: Math.floor(items.length / size),
    hasNext: start + size <= items.length,
  };
}
