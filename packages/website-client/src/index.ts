/**
 * Entry point for the Zena docs site's client bundle.
 *
 * Every element defined here renders into (or only enhances) light DOM, so the
 * global VitePress-derived stylesheet styles them exactly like the
 * server-rendered markup around them. `<zena-playground>` is the exception —
 * it is a published package with its own shadow DOM.
 */

import '@zena-lang/playground';
import './zena-appearance.js';
import './zena-code-carousel.js';
import './zena-code-copy.js';
import './zena-code-group.js';
import './zena-example-playground.js';
import './zena-layout.js';
import './zena-local-outline.js';
import './zena-outline.js';
import './zena-search.js';
import './zena-sidebar.js';

export {ZenaAppearance} from './zena-appearance.js';
export {ZenaCodeCarousel} from './zena-code-carousel.js';
export {ZenaCodeCopy} from './zena-code-copy.js';
export {ZenaCodeGroup} from './zena-code-group.js';
export {ZenaExamplePlayground} from './zena-example-playground.js';
export {ZenaLayout} from './zena-layout.js';
export {ZenaLocalOutline} from './zena-local-outline.js';
export {ZenaOutline} from './zena-outline.js';
export {ZenaPlayground} from '@zena-lang/playground';
export {ZenaSearch, type SearchEntry} from './zena-search.js';
export {ZenaSidebar} from './zena-sidebar.js';
