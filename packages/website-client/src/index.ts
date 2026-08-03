/**
 * Entry point for the Zena docs site's client bundle.
 *
 * Every element here renders into (or only enhances) light DOM, so the global
 * VitePress-derived stylesheet styles them exactly like the server-rendered
 * markup around them.
 */

import './zena-appearance.js';
import './zena-code-copy.js';
import './zena-code-group.js';
import './zena-layout.js';
import './zena-local-outline.js';
import './zena-outline.js';
import './lib/zena-playground.js';
import './zena-search.js';
import './zena-sidebar.js';

export {ZenaAppearance} from './zena-appearance.js';
export {ZenaCodeCopy} from './zena-code-copy.js';
export {ZenaCodeGroup} from './zena-code-group.js';
export {ZenaLayout} from './zena-layout.js';
export {ZenaLocalOutline} from './zena-local-outline.js';
export {ZenaOutline} from './zena-outline.js';
export {ZenaPlayground} from './lib/zena-playground.js';
export {ZenaSearch, type SearchEntry} from './zena-search.js';
export {ZenaSidebar} from './zena-sidebar.js';
