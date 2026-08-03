import {LitElement} from 'lit';

/**
 * Base class for elements that render into light DOM.
 *
 * The docs site styles everything with the (VitePress-derived) global
 * stylesheet, so shadow roots would just get in the way. Rendering into light
 * DOM also means the markup an element produces is the same markup Eleventy
 * could have produced, which keeps the CSS honest.
 */
export class LightElement extends LitElement {
  protected override createRenderRoot(): HTMLElement {
    return this;
  }
}

/**
 * Base class for elements that only add behavior to server-rendered markup.
 *
 * These never call `render()`, so Lit leaves their children alone.
 */
export class BehaviorElement extends HTMLElement {
  #abort?: AbortController;

  /** An AbortSignal that fires when the element is disconnected. */
  protected get disconnectedSignal(): AbortSignal {
    return (this.#abort ??= new AbortController()).signal;
  }

  disconnectedCallback(): void {
    this.#abort?.abort();
    this.#abort = undefined;
  }
}
