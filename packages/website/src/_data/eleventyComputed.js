import {prevNext, sidebarFor} from '../../lib/sidebar.js';

/**
 * Derived per-page data.
 *
 * Computing these once here keeps the templates declarative — they only ask
 * "is there a sidebar?" rather than re-deriving it from the URL.
 */
export default {
  sidebarItems: (data) => sidebarFor(data.sidebar, data.page.url),
  hasSidebar: (data) => sidebarFor(data.sidebar, data.page.url) !== null,
  pager: (data) => prevNext(data.sidebar, data.page.url),
};
