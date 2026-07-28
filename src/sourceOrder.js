// Ordering shared by the panels that list one card per tool (Usage & quota,
// AI coding agents). Both follow the header source chips, which App.jsx orders
// by conversation count, so the three surfaces never disagree about where a
// tool sits. Pure (no React) like sortConvos.js.
//
// `order` is the chip order (source ids). Items whose id is absent from it —
// a tool with no conversations, e.g. an N/A or not-installed one — keep their
// server order and sit after the ranked cards.
export function orderBySource(items, order, id = (x) => x.source) {
  if (!order || !order.length) return items;
  const rank = new Map(order.map((s, i) => [s, i]));
  return items
    .map((item, i) => {
      const r = rank.get(id(item));
      return { item, i, r: r === undefined ? Infinity : r };
    })
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}
