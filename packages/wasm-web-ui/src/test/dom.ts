/**
 * A DOM for the tests: happy-dom's globals (document, HTMLElement,
 * customElements, Event, …) installed on globalThis before lit-html is
 * imported, since lit-html captures `document` when it loads.
 *
 * Import this module first in every test file, then import lit-html and
 * the host through dynamic `import()` so the order is the one written.
 */
import {GlobalRegistrator} from '@happy-dom/global-registrator';

if (!(globalThis as {happyDOM?: unknown}).happyDOM) {
  GlobalRegistrator.register();
}

/** Resolves after pending microtasks have run. */
export const microtasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
