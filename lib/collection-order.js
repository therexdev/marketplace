'use strict';
function latestSales(events, previous = {}) {
  const result = { ...previous };
  for (const e of events) {
    if (e.kind !== 'sold' || !e.collection) continue;
    const old = result[e.collection];
    if (!old || e.seq > old.seq || (e.seq === old.seq && e.idx > old.idx)) {
      result[e.collection] = { seq: e.seq, idx: e.idx, at: e.at || null };
    }
  }
  return result;
}
function orderCollections(rows, sales) {
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const sa = sales[a.row.address], sb = sales[b.row.address];
    if (sa && sb) return sb.seq - sa.seq || sb.idx - sa.idx || a.index - b.index;
    if (sa || sb) return sa ? -1 : 1;
    // Registry insertion order is the fallback for older imported projects
    // with no launch timestamp; newly registered projects append at the end.
    return a.index - b.index;
  }).map(({ row }) => row);
}
module.exports = { latestSales, orderCollections };
