/** Picks the sidebar tree whose URL prefix best matches `url`. */
export const sidebarFor = (sidebar, url) => {
  const prefix = Object.keys(sidebar)
    .filter((p) => url.startsWith(p))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? sidebar[prefix] : null;
};

/**
 * Flattens a sidebar tree into the ordered list of pages it links to.
 *
 * Entries marked `back: true` (such as a micro-site's link back to `/projects/`)
 * are navigation chrome outside the section's reading order.
 */
export const flattenSidebar = (items) =>
  items.flatMap((item) => [
    ...(item.link && !item.back ? [item] : []),
    ...flattenSidebar(item.items ?? []),
  ]);

/** True when `item` or any descendant links to `url`. */
export const containsActive = (item, url) =>
  Boolean(item.link && item.link === url) ||
  (item.items ?? []).some((c) => containsActive(c, url));

/**
 * The previous and next pages in reading order, used by the doc footer pager.
 */
export const prevNext = (sidebar, url) => {
  const items = sidebarFor(sidebar, url);
  if (!items) return {};
  const flat = flattenSidebar(items);
  const i = flat.findIndex((item) => item.link === url);
  if (i === -1) return {};
  return {prev: flat[i - 1], next: flat[i + 1]};
};
