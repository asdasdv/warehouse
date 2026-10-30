// Page buttons for History and Inventory: first, last and the pages around the current one, «…» for the gaps.
export function pageButtons(current, pages) {
  const keep = new Set([0, pages - 1, current - 1, current, current + 1]), out = [];
  for (let i = 0; i < pages; i++) {
    if (keep.has(i)) out.push(`<button data-page="${i}" class="${i === current ? 'active' : ''}"${i === current ? ' aria-current="page"' : ''}>${i + 1}</button>`);
    else if (out[out.length - 1] !== '<span>…</span>') out.push('<span>…</span>');
  }
  return out.join('');
}
