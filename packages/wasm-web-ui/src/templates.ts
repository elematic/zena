/**
 * The template layer of the Wasm Web UI host: reads template results out
 * of a module through its `webui_*` exports and builds the lit-html
 * results that render them.
 *
 * The protocol is in docs/design/wasm-web-ui.md. In short, a result is
 * a strings object (the template, identity-stable per call site) plus one
 * value per hole, and the host reads both through accessor exports. The
 * host keeps a WeakMap from strings object to the TemplateStringsArray it
 * built, so a template crosses the boundary once per instance and a
 * re-render costs one lookup plus the values.
 */
import type {TemplateResult} from 'lit-html';
import {nothing, render as litRender, type RenderOptions} from 'lit-html';
import {listener} from './listener.js';

/** An opaque reference to an object the module made. */
export type ModuleObject = object;

/** The value kinds of the protocol, as `webui_value_kind` reports them. */
export const ValueKind = {
  nothing: 0,
  text: 1,
  number: 2,
  boolean: 3,
  template: 4,
  list: 5,
  listener: 6,
  host: 7,
} as const;

/** The exports every module implementing the template layer provides. */
export interface TemplateExports {
  webui_version(): number;
  webui_result_strings(result: ModuleObject): ModuleObject;
  webui_result_type(result: ModuleObject): number;
  webui_strings_count(strings: ModuleObject): number;
  webui_strings_at(strings: ModuleObject, index: number): string;
  webui_strings_raw_at(strings: ModuleObject, index: number): string;
  webui_value_count(container: ModuleObject): number;
  webui_value_kind(container: ModuleObject, index: number): number;
  webui_value_extern(container: ModuleObject, index: number): unknown;
  webui_value_ref(container: ModuleObject, index: number): ModuleObject;
  webui_value_number(container: ModuleObject, index: number): number;
  webui_listener_invoke(listener: ModuleObject, event: Event): void;
}

/** The protocol version this host speaks. */
export const PROTOCOL_VERSION = 1;

/** A TemplateStringsArray made from a module's strings. */
type Strings = TemplateStringsArray;

/**
 * Reads results out of one instantiated module.
 *
 * Construct it over the instance's exports: any object that has the
 * `webui_*` functions.
 */
export class TemplateHost {
  readonly exports: TemplateExports;
  readonly #templates = new WeakMap<ModuleObject, Strings>();

  constructor(exports: WebAssembly.Exports | TemplateExports) {
    const e = exports as unknown as TemplateExports;
    if (typeof e.webui_version !== 'function') {
      throw new Error(
        'wasm-web-ui: the module does not export webui_version, so it ' +
          'does not implement the Wasm Web UI protocol',
      );
    }
    const version = e.webui_version();
    if (version !== PROTOCOL_VERSION) {
      throw new Error(
        `wasm-web-ui: the module speaks protocol version ${version}, ` +
          `this host speaks ${PROTOCOL_VERSION}`,
      );
    }
    this.exports = e;
  }

  /**
   * The lit-html result for a module result: the same object shape
   * lit-html's `html` tag returns, so `render` accepts it directly.
   */
  result(ref: ModuleObject): TemplateResult {
    const {exports} = this;
    const strings = this.strings(exports.webui_result_strings(ref));
    const type = exports.webui_result_type(ref) as 1 | 2 | 3;
    return {
      ['_$litType$']: type,
      strings,
      values: this.values(ref),
    } as unknown as TemplateResult;
  }

  /** Renders a module result into a container through lit-html. */
  render(
    ref: ModuleObject | null,
    container: HTMLElement | DocumentFragment,
    options?: RenderOptions,
  ): void {
    litRender(ref === null ? nothing : this.result(ref), container, options);
  }

  /**
   * The TemplateStringsArray for a strings object, built on first sight
   * and found by identity afterwards.
   */
  strings(ref: ModuleObject): Strings {
    let strings = this.#templates.get(ref);
    if (strings === undefined) {
      const {exports} = this;
      const count = exports.webui_strings_count(ref);
      const cooked: string[] = new Array(count);
      const raw: string[] = new Array(count);
      for (let i = 0; i < count; i++) {
        cooked[i] = exports.webui_strings_at(ref, i);
        raw[i] = exports.webui_strings_raw_at(ref, i);
      }
      // lit-html checks for an own `raw` property: it is what tells a
      // template literal's strings apart from an array a caller built,
      // which is lit-html's guard against injected markup. Here the
      // strings are the module's literals, read through its exports.
      Object.defineProperty(cooked, 'raw', {value: Object.freeze(raw)});
      strings = Object.freeze(cooked) as unknown as Strings;
      this.#templates.set(ref, strings);
    }
    return strings;
  }

  /** The converted values of a result or a list. */
  values(container: ModuleObject): unknown[] {
    const {exports} = this;
    const count = exports.webui_value_count(container);
    const out: unknown[] = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = this.value(container, i);
    }
    return out;
  }

  /** One converted value. */
  value(container: ModuleObject, index: number): unknown {
    const {exports} = this;
    switch (exports.webui_value_kind(container, index)) {
      case ValueKind.nothing:
        return nothing;
      case ValueKind.text:
      case ValueKind.host:
        return exports.webui_value_extern(container, index);
      case ValueKind.number:
        return exports.webui_value_number(container, index);
      case ValueKind.boolean:
        return exports.webui_value_number(container, index) !== 0;
      case ValueKind.template:
        return this.result(exports.webui_value_ref(container, index));
      case ValueKind.list:
        return this.values(exports.webui_value_ref(container, index));
      case ValueKind.listener:
        return listener(this, exports.webui_value_ref(container, index));
      default:
        throw new Error(
          `wasm-web-ui: unknown value kind ${exports.webui_value_kind(
            container,
            index,
          )} at index ${index}`,
        );
    }
  }
}

export {listener} from './listener.js';
