import {prevNext, sidebarFor} from '../../../website/lib/sidebar.js';

export default {
  sidebarItems: (data) => sidebarFor(data.sidebar, data.page.url),
  hasSidebar: (data) => sidebarFor(data.sidebar, data.page.url) !== null,
  pager: (data) => prevNext(data.sidebar, data.page.url),
};
