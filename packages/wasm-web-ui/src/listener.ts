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
