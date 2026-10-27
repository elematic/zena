/**
 * The stable event listener for a hole.
 *
 * A module that writes `@click=${() => this.increment()}` hands the host
 * a new listener object on every render. Giving lit-html a new function
 * each time would make it remove and re-add the DOM listener on every
 * render, so this directive keeps one function per part and swaps the
 * module listener it forwards to. lit-html sees the same function and
 * leaves the DOM alone.
 */
import {directive, Directive, type PartInfo} from 'lit-html/directive.js';
import type {ModuleObject, TemplateHost} from './templates.js';
import type {Handle, LinearMemory} from './linear.js';

class ListenerDirective extends Directive {
  #host: TemplateHost | undefined;
  #listener: ModuleObject | undefined;
  readonly #handler = (event: Event): void => {
    if (this.#host !== undefined && this.#listener !== undefined) {
      this.#host.exports.webui_listener_invoke(this.#listener, event);
    }
  };

  constructor(partInfo: PartInfo) {
    super(partInfo);
  }

  override render(host: TemplateHost, listener: ModuleObject) {
    this.#host = host;
    this.#listener = listener;
    return this.#handler;
  }
}

/** A listener value: forwards events to a module listener object. */
export const listener = directive(ListenerDirective);

/**
 * The same, for a linear-memory module, whose listener is a `Handle` the
 * module keeps alive until the host releases it. The part is the one
 * place the host keeps a listener, so it retains the handle it adopts
 * and releases the one it replaces; a part that leaves the tree keeps
 * its handle for the finalizer, since it may come back.
 */
class LinearListenerDirective extends Directive {
  #linear: LinearMemory | undefined;
  #host: TemplateHost | undefined;
  #listener: Handle | undefined;
  readonly #handler = (event: Event): void => {
    if (this.#host !== undefined && this.#listener !== undefined) {
      this.#host.exports.webui_listener_invoke(this.#listener, event);
    }
  };

  constructor(partInfo: PartInfo) {
    super(partInfo);
  }

  override render(linear: LinearMemory, host: TemplateHost, listener: Handle) {
    if (this.#listener !== listener) {
      linear.retain(listener);
      if (this.#listener !== undefined) {
        linear.release(this.#listener);
      }
    }
    this.#linear = linear;
    this.#host = host;
    this.#listener = listener;
    return this.#handler;
  }
}

export const linearListener = directive(LinearListenerDirective);
