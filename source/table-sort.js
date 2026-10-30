// Column sorting for the tables. Click a header: the first click sorts numbers and times high-to-low (most, newest)
// and text A→Z (`first`), the next click flips it. The sorted header is dark with an arrow; the others show no arrow.
const arrow = dir => `<svg class="lc-sort-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="${dir === 'desc' ? 'M6 2.5v7M3 6.5l3 3 3-3' : 'M6 9.5v-7M3 5.5l3-3 3 3'}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export function sortHead(label, key, sort, cls = '', first = 'desc') {
  const on = sort.key === key;
  return `<th class="lc-sortable${on ? ' sorted' : ''}${cls ? ' ' + cls : ''}" data-sort="${key}" data-first="${first}" aria-sort="${on ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}" tabindex="0"><span>${label}${on ? arrow(sort.dir) : ''}</span></th>`;
}
export const toggleSort = (sort, key, first = 'desc') => sort.key === key ? {key, dir: sort.dir === 'desc' ? 'asc' : 'desc'} : {key, dir: first};
// Sorts a copy by valueOf(row, key): numbers numerically, text naturally (A-2 before A-10).
export function sortRows(rows, sort, valueOf) {
  const k = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = valueOf(a, sort.key), y = valueOf(b, sort.key);
    return k * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', {numeric: true}));
  });
}
// Clicks and Enter/Space on sortable headers inside root call onSort(key).
export function bindSort(root, onSort) {
  root.querySelectorAll('th[data-sort]').forEach(th => {
    th.onclick = () => onSort(th.dataset.sort, th.dataset.first);
    th.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(th.dataset.sort, th.dataset.first); } };
  });
}
