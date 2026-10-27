/**
 * The linear-memory extension: the protocol for a module without Wasm GC,
 * such as one written in Rust or C (docs/design/wasm-web-ui.md, "Other
 * languages").
 *
 * Such a module cannot hand the host a reference, so it names its objects
 * with integers and the host keeps the identity: an owned object (a
 * template's strings, a listener, a definition, a property, an element
 * instance) becomes one `Handle` per id, interned while anything on the
 * page holds it and registered with a `FinalizationRegistry` that calls
 * the module's `webui_release(id)` when it is collected. A result or a
 * list is transient, read before the host calls into the module again,
 * and crosses as the bare id. Strings come out as a pointer to a
 * `{ptr, len}` record in the module's memory and go in through the
 * module's `webui_alloc`. A host value the module holds, an event in a
 * listener or a `host` property, is an id into a table on this side,
 * released by the module through the `extern_release` import.
 *
 * `linearExports` wraps the module's integer exports in the interface the
 * host reads GC exports through, so `TemplateHost` and `ElementModule`
 * are the same code for both kinds of module; a GC module never goes
 * through this file.
 */
import type {ModuleObject, TemplateExports} from './templates.js';
import {ValueKind} from './templates.js';
import type {ElementExports} from './elements.js';

/** The host's object for one owned module object of a linear-memory module. */
export class Handle {
  readonly id: number;
  /** Slots on the page that adopted this handle (`retain`/`release`). */
  holders = 0;
  constructor(id: number) {
    this.id = id;
  }
}

/** The exports a linear-memory module adds to the protocol's. */
export interface LinearExports {
  memory: WebAssembly.Memory;
  /** Bytes for a string the host passes in; the module owns them after. */
  webui_alloc(length: number): number;
  /** The host dropped its last reference to the object. */
  webui_release(id: number): void;
  /** Sets a text property from bytes the host allocated with `webui_alloc`. */
  webui_element_set_text(
    instance: number,
    property: number,
    ptr: number,
    length: number,
  ): void;
}

/** Whether a module's exports are the linear-memory extension's. */
export const isLinearMemoryModule = (exports: object): boolean =>
  typeof (exports as LinearExports).webui_release === 'function' &&
  (exports as LinearExports).memory instanceof WebAssembly.Memory;

/**
 * The host's state for one linear-memory module: created before the
 * module is instantiated, because the imports it flavours close over it,
 * and attached to the instance's exports by the `TemplateHost` or
 * `ElementModule` built over them.
 */
export class LinearMemory {
  #exports: LinearExports | undefined;
  readonly #handles = new Map<number, WeakRef<Handle>>();
  readonly #registry = new FinalizationRegistry<number>((id) => {
    // The module does not reuse an id before it is released, so the
    // entry is this handle's, now dead.
    this.#handles.delete(id);
    this.#exports?.webui_release(id);
  });
  readonly #externs = new Map<number, unknown>();
  #nextExtern = 1;
  readonly #decoder = new TextDecoder();
  readonly #encoder = new TextEncoder();

  /** Binds this to the instance. Called by the host over its exports. */
  attach(exports: WebAssembly.Exports): void {
    if (!isLinearMemoryModule(exports)) {
      throw new Error(
        'wasm-web-ui: a linear-memory module exports memory, webui_alloc ' +
          'and webui_release',
      );
    }
    this.#exports = exports as unknown as LinearExports;
  }

  get exports(): LinearExports {
    if (this.#exports === undefined) {
      throw new Error('wasm-web-ui: the module is not attached yet');
    }
    return this.#exports;
  }

  /** The handle for an id, if anything on the page still holds one. */
  live(id: number): Handle | undefined {
    return this.#handles.get(id)?.deref();
  }

  /** The handle for an owned id: the same object while anything holds it. */
  handle(id: number): Handle {
    const live = this.#handles.get(id)?.deref();
    if (live !== undefined) {
      return live;
    }
    const handle = new Handle(id);
    this.#handles.set(id, new WeakRef(handle));
    this.#registry.register(handle, id, handle);
    return handle;
  }

  /**
   * A slot on the page took the handle: a listener's part, which keeps
   * it until the next render replaces it. Counted, so that `release`
   * can return the object to the module as soon as the last slot lets
   * go, which for a listener is every render, instead of waiting for
   * the engine to collect the handle.
   */
  retain(handle: Handle): void {
    handle.holders += 1;
  }

  /** The slot let go. At zero holders the module gets its release now. */
  release(handle: Handle): void {
    handle.holders -= 1;
    if (handle.holders > 0) {
      return;
    }
    this.#registry.unregister(handle);
    this.#handles.delete(handle.id);
    this.exports.webui_release(handle.id);
  }

  /** Decodes `length` bytes at `ptr`. */
  decode(ptr: number, length: number): string {
    return this.#decoder.decode(
      new Uint8Array(this.exports.memory.buffer, ptr, length),
    );
  }

  /** A string the module returned as a `{ptr, len}` record, or null for 0. */
  string(record: number): string | null {
    if (record === 0) {
      return null;
    }
    const view = new DataView(this.exports.memory.buffer);
    return this.decode(
      view.getUint32(record, true),
      view.getUint32(record + 4, true),
    );
  }

  /** Writes `text` into memory the module allocates; the module owns it. */
  write(text: string): [ptr: number, length: number] {
    const bytes = this.#encoder.encode(text);
    const ptr = this.exports.webui_alloc(bytes.length);
    new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
    return [ptr, bytes.length];
  }

  /**
   * Writes `text` into a buffer the module provided, up to `capacity`
   * bytes, and returns the full length: a module whose buffer was too
   * small calls again with a larger one.
   */
  writeInto(text: string, ptr: number, capacity: number): number {
    const bytes = this.#encoder.encode(text);
    if (bytes.length <= capacity) {
      new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
    }
    return bytes.length;
  }

  /** Lends a host value to the module under an id until `releaseExtern`. */
  internExtern(value: unknown): number {
    const id = this.#nextExtern++;
    this.#externs.set(id, value);
    return id;
  }

  /** The host value behind an id the module holds. */
  extern(id: number): unknown {
    return this.#externs.get(id);
  }

  releaseExtern(id: number): void {
    this.#externs.delete(id);
  }
}

/** The module's exports as it declares them: integers everywhere. */
interface RawExports {
  webui_version(): number;
  webui_result_strings(result: number): number;
  webui_result_type(result: number): number;
  webui_strings_count(strings: number): number;
  webui_strings_at(strings: number, index: number): number;
  webui_strings_raw_at(strings: number, index: number): number;
  webui_value_count(container: number): number;
  webui_value_kind(container: number, index: number): number;
  webui_value_extern(container: number, index: number): number;
  webui_value_ref(container: number, index: number): number;
  webui_value_number(container: number, index: number): number;
  webui_listener_invoke(listener: number, event: number): void;
  webui_element_count?(): number;
  webui_element_at(index: number): number;
  webui_definition_tag(definition: number): number;
  webui_definition_styles(definition: number): number;
  webui_definition_property_count(definition: number): number;
  webui_definition_property(definition: number, index: number): number;
  webui_definition_create(definition: number): number;
  webui_property_name(property: number): number;
  webui_property_kind(property: number): number;
  webui_property_attribute(property: number): number;
  webui_element_connected(instance: number): void;
  webui_element_disconnected(instance: number): void;
  webui_element_attribute_changed(
    instance: number,
    property: number,
    ptr: number,
    length: number,
  ): void;
  webui_element_attribute_removed(instance: number, property: number): void;
  webui_element_get_extern(instance: number, property: number): number;
  webui_element_get_number(instance: number, property: number): number;
  webui_element_set_extern(
    instance: number,
    property: number,
    extern: number,
  ): void;
  webui_element_set_number(
    instance: number,
    property: number,
    value: number,
  ): void;
  webui_element_render(instance: number): number;
  webui_element_updated(instance: number, first: number): void;
}

/** A transient id: the opaque value the host passes back as it is. */
const transient = (id: number): ModuleObject => id;
const idOf = (ref: ModuleObject): number =>
  typeof ref === 'number' ? ref : (ref as Handle).id;

/**
 * The host-facing exports of a linear-memory module: ids become handles
 * or stay transient by what they name, string records are decoded, and
 * strings going in are written into the module's memory first.
 */
export const linearExports = (
  exports: WebAssembly.Exports,
  linear: LinearMemory,
): TemplateExports & ElementExports => {
  const raw = exports as unknown as RawExports & LinearExports;
  const text = (record: number): string => linear.string(record) ?? '';
  // The kind the host read last, so the value accessors can tell a
  // string record from an extern id and a transient id from an owned
  // one without a second call into the module.
  let lastContainer = -1;
  let lastIndex = -1;
  let lastKind = -1;
  const kindOf = (container: number, index: number): number => {
    if (container !== lastContainer || index !== lastIndex) {
      lastContainer = container;
      lastIndex = index;
      lastKind = raw.webui_value_kind(container, index);
    }
    return lastKind;
  };
  const propertyKinds = new Map<number, number>();
  const propertyKind = (property: number): number => {
    let kind = propertyKinds.get(property);
    if (kind === undefined) {
      kind = raw.webui_property_kind(property);
      propertyKinds.set(property, kind);
    }
    return kind;
  };

  const templates: TemplateExports = {
    webui_version: () => raw.webui_version(),
    webui_result_strings: (result) =>
      linear.handle(raw.webui_result_strings(idOf(result))),
    webui_result_type: (result) => raw.webui_result_type(idOf(result)),
    webui_strings_count: (strings) => raw.webui_strings_count(idOf(strings)),
    webui_strings_at: (strings, i) =>
      text(raw.webui_strings_at(idOf(strings), i)),
    webui_strings_raw_at: (strings, i) =>
      text(raw.webui_strings_raw_at(idOf(strings), i)),
    webui_value_count: (container) => raw.webui_value_count(idOf(container)),
    webui_value_kind: (container, i) => kindOf(idOf(container), i),
    webui_value_extern: (container, i) => {
      const c = idOf(container);
      const value = raw.webui_value_extern(c, i);
      return kindOf(c, i) === ValueKind.host
        ? linear.extern(value)
        : text(value);
    },
    webui_value_ref: (container, i) => {
      const c = idOf(container);
      const id = raw.webui_value_ref(c, i);
      return kindOf(c, i) === ValueKind.listener
        ? linear.handle(id)
        : transient(id);
    },
    webui_value_number: (container, i) =>
      raw.webui_value_number(idOf(container), i),
    webui_listener_invoke: (listener, event) => {
      const id = linear.internExtern(event);
      try {
        raw.webui_listener_invoke(idOf(listener), id);
      } finally {
        linear.releaseExtern(id);
      }
    },
  };

  const elements: ElementExports = {
    webui_element_count: () => raw.webui_element_count?.() ?? 0,
    webui_element_at: (i) => linear.handle(raw.webui_element_at(i)),
    webui_definition_tag: (definition) =>
      text(raw.webui_definition_tag(idOf(definition))),
    webui_definition_styles: (definition) =>
      linear.string(raw.webui_definition_styles(idOf(definition))),
    webui_definition_property_count: (definition) =>
      raw.webui_definition_property_count(idOf(definition)),
    webui_definition_property: (definition, i) =>
      linear.handle(raw.webui_definition_property(idOf(definition), i)),
    webui_definition_create: (definition) =>
      linear.handle(raw.webui_definition_create(idOf(definition))),
    webui_property_name: (property) =>
      text(raw.webui_property_name(idOf(property))),
    webui_property_kind: (property) => propertyKind(idOf(property)),
    webui_property_attribute: (property) =>
      text(raw.webui_property_attribute(idOf(property))),
    webui_element_connected: (instance) =>
      raw.webui_element_connected(idOf(instance)),
    webui_element_disconnected: (instance) =>
      raw.webui_element_disconnected(idOf(instance)),
    webui_element_attribute_changed: (instance, property, value) => {
      const [ptr, length] = linear.write(value);
      raw.webui_element_attribute_changed(
        idOf(instance),
        idOf(property),
        ptr,
        length,
      );
    },
    webui_element_attribute_removed: (instance, property) =>
      raw.webui_element_attribute_removed(idOf(instance), idOf(property)),
    webui_element_get_extern: (instance, property) => {
      const p = idOf(property);
      const value = raw.webui_element_get_extern(idOf(instance), p);
      return propertyKind(p) === ValueKind.host
        ? linear.extern(value)
        : text(value);
    },
    webui_element_get_number: (instance, property) =>
      raw.webui_element_get_number(idOf(instance), idOf(property)),
    webui_element_set_extern: (instance, property, value) => {
      const p = idOf(property);
      if (propertyKind(p) === ValueKind.host) {
        raw.webui_element_set_extern(
          idOf(instance),
          p,
          linear.internExtern(value),
        );
        return;
      }
      const [ptr, length] = linear.write(String(value));
      raw.webui_element_set_text(idOf(instance), p, ptr, length);
    },
    webui_element_set_number: (instance, property, value) =>
      raw.webui_element_set_number(idOf(instance), idOf(property), value),
    webui_element_render: (instance) => {
      const id = raw.webui_element_render(idOf(instance));
      return id === 0 ? null : transient(id);
    },
    webui_element_updated: (instance, first) =>
      raw.webui_element_updated(idOf(instance), first),
  };

  return {...templates, ...elements};
};
