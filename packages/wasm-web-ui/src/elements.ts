/**
 * The elements layer: custom elements whose lifecycle a module implements.
 *
 * A module exports its element definitions as records: a tag, the
 * properties with their attributes, the styles, and a constructor. An
 * `ElementModule` reads each record once through the module's exports,
 * and `classFor` derives an `HTMLElement` class from a record; an
 * instance the constructor makes carries the lifecycle the module
 * implements for it. Registration is the page's: it defines the classes
 * it derives, under the tags it chooses, in the registry it chooses. The
 * module asks for an update through the `request_update` import, and the
 * host renders once per microtask per instance.
 */
import {render, nothing, type RenderOptions} from 'lit-html';
import {hydrate} from '@lit-labs/ssr-client';
import {
  TemplateHost,
  ValueKind,
  type ModuleObject,
  type TemplateHostOptions,
} from './templates.js';
import type {LinearMemory} from './linear.js';

/** The exports a module with element definitions provides. */
export interface ElementExports {
  webui_element_count(): number;
  webui_element_at(index: number): ModuleObject;
  webui_definition_tag(definition: ModuleObject): string;
  webui_definition_styles(definition: ModuleObject): string | null;
  webui_definition_property_count(definition: ModuleObject): number;
  webui_definition_property(
    definition: ModuleObject,
    index: number,
  ): ModuleObject;
  webui_definition_create(definition: ModuleObject): ModuleObject;
  webui_property_name(property: ModuleObject): string;
  webui_property_kind(property: ModuleObject): number;
  webui_property_attribute(property: ModuleObject): string;
  webui_element_connected(instance: ModuleObject): void;
  webui_element_disconnected(instance: ModuleObject): void;
  webui_element_attribute_changed(
    instance: ModuleObject,
    property: ModuleObject,
    value: string,
  ): void;
  webui_element_attribute_removed(
    instance: ModuleObject,
    property: ModuleObject,
  ): void;
  webui_element_get_extern(
    instance: ModuleObject,
    property: ModuleObject,
  ): unknown;
  webui_element_get_number(
    instance: ModuleObject,
    property: ModuleObject,
  ): number;
  webui_element_set_extern(
    instance: ModuleObject,
    property: ModuleObject,
    value: unknown,
  ): void;
  webui_element_set_number(
    instance: ModuleObject,
    property: ModuleObject,
    value: number,
  ): void;
  webui_element_render(instance: ModuleObject): ModuleObject | null;
  webui_element_updated(instance: ModuleObject, first: number): void;
}

/** Whether a module's exports include the elements layer. */
export const hasElements = (exports: object): exports is ElementExports =>
  typeof (exports as ElementExports).webui_element_count === 'function';

/** One property of a definition, as the module declared it. */
export interface PropertyInfo {
  readonly name: string;
  /** A value kind: text, number, boolean or host value. */
  readonly kind: number;
  /** The attribute that reflects into the property, or '' for none. */
  readonly attribute: string;
  /** The module's property record. */
  readonly ref: ModuleObject;
}

/**
 * One element definition the module exports: the record the page reads
 * once when it registers the element, and the constructor.
 */
export interface ElementDefinition {
  /** The tag the module suggests, or '' for one the page names. */
  readonly tag: string;
  readonly properties: readonly PropertyInfo[];
  /** The attributes the properties reflect from. */
  readonly observedAttributes: readonly string[];
  /** The stylesheet text, or null for none. */
  readonly styles: string | null;
  /** The module's definition record. */
  readonly ref: ModuleObject;
  /** A new instance, with the lifecycle the module implements for it. */
  create(): ElementInstance;
}

/** A module instance of an element. */
export interface ElementInstance {
  readonly definition: ElementDefinition;
  /** The module's instance object. */
  readonly ref: ModuleObject;
  connected(): void;
  disconnected(): void;
  /** An observed attribute changed; `value` is null when it was removed. */
  attributeChanged(name: string, value: string | null): void;
  /** What the instance shows now, as a lit-html value. */
  render(): unknown;
  /** The host rendered the last result; `first` on the first render. */
  updated(first: boolean): void;
  get(name: string): unknown;
  set(name: string, value: unknown): void;
}

/** The DOM element behind a module instance. */
export interface WasmElement extends HTMLElement {
  /** Ask for a render before the next frame, as a module property set does. */
  requestUpdate(): void;
  /** Resolves after the pending render, with `true` if one was pending. */
  readonly updateComplete: Promise<boolean>;
}

/**
 * The live elements by module instance: how `request_update` and
 * `dispatch_event` find the element an instance belongs to. A module
 * object is unique to its instance, so one map serves every module on
 * the page, and the imports need no binding to a module.
 */
const liveElements = new WeakMap<object, WasmElement>();

/** The element for a module instance, if one was constructed for it. */
export const elementFor = (instance: ModuleObject): WasmElement | undefined =>
  liveElements.get(instance as object);

/**
 * The imports the elements layer needs, under the `wasm-web-ui` module
 * name: the module calls `request_update` when an instance's state
 * changed and `dispatch_event` to dispatch an `Event` from an element.
 * The event is a plain `Event` of the given type with the flags: a
 * listener reads what it needs off the element, which is how `change`
 * and `input` work too. `dispatch_event` returns 0 when a listener
 * canceled a cancelable event.
 */
export interface ElementImports {
  request_update(instance: ModuleObject): void;
  dispatch_event(instance: ModuleObject, type: string, flags: number): number;
}

/** `dispatch_event` flag bits. */
export const EventFlags = {bubbles: 1, composed: 2, cancelable: 4} as const;

/**
 * The capability imports a page may grant, by name. Each is one function
 * in the `wasm-web-ui` import module that reads or acts on an event the
 * module was handed. A module that imports one the page did not grant
 * fails to instantiate.
 */
export const capabilityImports = {
  event_target_value: (event: Event): string =>
    String((event.target as {value?: unknown} | null)?.value ?? ''),
  event_key: (event: Event): string => (event as KeyboardEvent).key ?? '',
  event_prevent_default: (event: Event): void => {
    event.preventDefault();
  },
  event_stop_propagation: (event: Event): void => {
    event.stopPropagation();
  },
} as const;

export type Capability = keyof typeof capabilityImports;

export interface WebUiImportOptions {
  /** The capability imports to grant. Defaults to all of them. */
  capabilities?: readonly Capability[];
  /**
   * For a module without Wasm GC: the `LinearMemory` the page made for
   * it. The imports then take the module's integer ids, strings as
   * bytes in its memory, and an event as an id into the host's table
   * (`linear.ts`). A GC module needs nothing here.
   */
  linear?: LinearMemory;
}

const eventInit = (flags: number): EventInit => ({
  bubbles: (flags & EventFlags.bubbles) !== 0,
  composed: (flags & EventFlags.composed) !== 0,
  cancelable: (flags & EventFlags.cancelable) !== 0,
});

const dispatch = (
  element: WasmElement | undefined,
  type: string,
  flags: number,
): number =>
  element === undefined ||
  element.dispatchEvent(new Event(type, eventInit(flags)))
    ? 1
    : 0;

const grantedCapabilities = (
  options: WebUiImportOptions,
): readonly Capability[] =>
  options.capabilities ?? (Object.keys(capabilityImports) as Capability[]);

/**
 * The protocol's import module, `wasm-web-ui`, to spread into the import
 * object a module is instantiated with, beside the imports of the
 * module's own runtime:
 *
 * ```js
 * const {instance} = await WebAssembly.instantiate(bytes, {
 *   ...runtimeImports,
 *   ...webUiImports(),
 * });
 * ```
 *
 * It holds `request_update` and `dispatch_event`, which act on the
 * module's own element instances, and the capability imports the page
 * grants. A template-only module imports none of it.
 */
export const webUiImports = (
  options: WebUiImportOptions = {},
): {'wasm-web-ui': WebAssembly.ModuleImports} => {
  if (options.linear !== undefined) {
    return {'wasm-web-ui': linearImports(options.linear, options)};
  }
  const imports: ElementImports = {
    request_update: (instance) => {
      liveElements.get(instance as object)?.requestUpdate();
    },
    dispatch_event: (instance, type, flags) =>
      dispatch(liveElements.get(instance as object), type, flags),
  };
  const granted: Record<string, unknown> = {};
  for (const name of grantedCapabilities(options)) {
    granted[name] = capabilityImports[name];
  }
  return {
    'wasm-web-ui': {...imports, ...granted} as WebAssembly.ModuleImports,
  };
};

/**
 * The same import module for a linear-memory module: an instance is an
 * id, an event type is bytes in the module's memory, an event is an id
 * in the host's table, and a capability that returns a string writes it
 * into a buffer the module provides and returns the full length, so a
 * module whose buffer was too small calls again.
 */
const linearImports = (
  linear: LinearMemory,
  options: WebUiImportOptions,
): WebAssembly.ModuleImports => {
  const event = (id: number): Event => linear.extern(id) as Event;
  const all = {
    request_update: (instance: number) => {
      const handle = linear.live(instance);
      if (handle !== undefined) {
        liveElements.get(handle)?.requestUpdate();
      }
    },
    dispatch_event: (
      instance: number,
      ptr: number,
      length: number,
      flags: number,
    ) => {
      const handle = linear.live(instance);
      return dispatch(
        handle === undefined ? undefined : liveElements.get(handle),
        linear.decode(ptr, length),
        flags,
      );
    },
    extern_release: (id: number) => {
      linear.releaseExtern(id);
    },
    event_target_value: (id: number, buffer: number, capacity: number) =>
      linear.writeInto(
        capabilityImports.event_target_value(event(id)),
        buffer,
        capacity,
      ),
    event_key: (id: number, buffer: number, capacity: number) =>
      linear.writeInto(
        capabilityImports.event_key(event(id)),
        buffer,
        capacity,
      ),
    event_prevent_default: (id: number) => {
      capabilityImports.event_prevent_default(event(id));
    },
    event_stop_propagation: (id: number) => {
      capabilityImports.event_stop_propagation(event(id));
    },
  };
  const imports: Record<string, unknown> = {
    request_update: all.request_update,
    dispatch_event: all.dispatch_event,
    extern_release: all.extern_release,
  };
  for (const name of grantedCapabilities(options)) {
    imports[name] = all[name];
  }
  return imports as WebAssembly.ModuleImports;
};

/**
 * Whether the platform has scoped custom element registries: a
 * `CustomElementRegistry` a page constructs, a shadow root attached
 * with one, and `document.importNode` creating elements from one.
 */
export const scopedRegistriesSupported = (): boolean =>
  typeof CustomElementRegistry === 'function' &&
  typeof ShadowRoot === 'function' &&
  'customElementRegistry' in ShadowRoot.prototype;

export interface ElementModuleOptions extends TemplateHostOptions {
  /**
   * The registry the module's elements resolve the tags in their own
   * templates from. Left out, where the platform has scoped custom
   * element registries, it is a registry of the module's own with every
   * tagged definition defined in it, so the module's elements can use
   * each other whatever the page defines; where it has none, it is null
   * and the elements resolve from the document's registry, so the page
   * has to define the tags the module's templates use. `customElements`
   * resolves from the page's registry everywhere.
   */
  registry?: CustomElementRegistry | null;
}

/**
 * A module's elements: the definition records, read once from an
 * instantiated module, and the classes derived from them.
 *
 * ```js
 * const elements = new ElementModule(instance.exports);
 * for (const definition of elements.definitions) {
 *   customElements.define(definition.tag, elements.classFor(definition));
 * }
 * ```
 */
export class ElementModule {
  /** The template host the elements render through. */
  readonly host: TemplateHost;
  /** The definitions the module exports, in the module's order. */
  readonly definitions: readonly ElementDefinition[];
  /**
   * The registry the elements' shadow roots create elements from, or
   * null for the document's.
   */
  readonly registry: CustomElementRegistry | null;

  constructor(
    exports: WebAssembly.Exports | TemplateHost,
    options: ElementModuleOptions = {},
  ) {
    this.host =
      exports instanceof TemplateHost
        ? exports
        : new TemplateHost(exports, {linear: options.linear});
    this.definitions = readDefinitions(this.host);
    if (options.registry === undefined && scopedRegistriesSupported()) {
      const registry = new CustomElementRegistry();
      this.registry = registry;
      for (const definition of this.definitions) {
        if (definition.tag !== '') {
          registry.define(definition.tag, this.classFor(definition));
        }
      }
    } else {
      this.registry = options.registry ?? null;
    }
  }

  /**
   * The `HTMLElement` class for a definition, defined nowhere: the page
   * defines it, under the definition's tag or one of its own. Its
   * constructor calls the module's constructor export, its property
   * accessors call the module's getters and setters, and its lifecycle
   * callbacks forward to the module.
   */
  classFor(definition: ElementDefinition): CustomElementConstructor {
    return buildElementClass(definition, this.registry);
  }
}

/**
 * The definition records, read through the module's accessors once.
 * Each record's functions close over the module's objects, so the page
 * holds plain data and functions, never an index into the module.
 */
const readDefinitions = (host: TemplateHost): ElementDefinition[] => {
  const exports = host.exports as unknown as ElementExports;
  if (!hasElements(exports)) {
    return [];
  }
  const definitions: ElementDefinition[] = [];
  const count = exports.webui_element_count();
  for (let i = 0; i < count; i++) {
    const ref = exports.webui_element_at(i);
    const properties: PropertyInfo[] = [];
    const propertyCount = exports.webui_definition_property_count(ref);
    for (let p = 0; p < propertyCount; p++) {
      const pref = exports.webui_definition_property(ref, p);
      properties.push({
        name: exports.webui_property_name(pref),
        kind: exports.webui_property_kind(pref),
        attribute: exports.webui_property_attribute(pref),
        ref: pref,
      });
    }
    const byName = new Map(properties.map((p) => [p.name, p]));
    const byAttribute = new Map(
      properties.filter((p) => p.attribute !== '').map((p) => [p.attribute, p]),
    );
    const definition: ElementDefinition = {
      tag: exports.webui_definition_tag(ref),
      properties,
      observedAttributes: [...byAttribute.keys()],
      styles: exports.webui_definition_styles(ref) ?? null,
      ref,
      create: () => {
        const instance = exports.webui_definition_create(ref);
        const property = (name: string): PropertyInfo => {
          const info = byName.get(name);
          if (info === undefined) {
            throw new Error(`wasm-web-ui: no property ${name}`);
          }
          return info;
        };
        return {
          definition,
          ref: instance,
          connected: () => exports.webui_element_connected(instance),
          disconnected: () => exports.webui_element_disconnected(instance),
          attributeChanged: (name, value) => {
            const info = byAttribute.get(name);
            if (info === undefined) {
              return;
            }
            if (value === null) {
              exports.webui_element_attribute_removed(instance, info.ref);
            } else {
              exports.webui_element_attribute_changed(
                instance,
                info.ref,
                value,
              );
            }
          },
          render: () => {
            const result = exports.webui_element_render(instance);
            return result === null ? nothing : host.result(result);
          },
          updated: (first) =>
            exports.webui_element_updated(instance, first ? 1 : 0),
          get: (name) => readProperty(exports, instance, property(name)),
          set: (name, value) =>
            writeProperty(exports, instance, property(name), value),
        };
      },
    };
    definitions.push(definition);
  }
  return definitions;
};

/** Whether shadow roots take constructed stylesheets here. */
const adoptedStyleSheetsSupported = (): boolean =>
  typeof ShadowRoot === 'function' &&
  'adoptedStyleSheets' in ShadowRoot.prototype &&
  typeof CSSStyleSheet === 'function' &&
  'replaceSync' in CSSStyleSheet.prototype;

/**
 * The shadow root init for a class built against `registry`: the root
 * creates elements from it where the platform supports that.
 */
const shadowRootInit = (
  registry: CustomElementRegistry | null,
): ShadowRootInit =>
  registry !== null && scopedRegistriesSupported()
    ? ({mode: 'open', customElementRegistry: registry} as ShadowRootInit)
    : {mode: 'open'};

/**
 * A creation scope for lit-html that clones template content with
 * `registry`, so the elements a template names are the module's own
 * even when the page never defined them.
 */
const creationScope = (
  registry: CustomElementRegistry,
): NonNullable<RenderOptions['creationScope']> => ({
  importNode: (node: Node, deep?: boolean) =>
    (document.importNode as (node: Node, options: unknown) => Node)(node, {
      customElementRegistry: registry,
      selfOnly: deep === false,
    }),
});

/**
 * The `HTMLElement` class derived from a definition record: the
 * constructor makes a module instance, the observed attributes and the
 * property accessors are the record's, and the callbacks forward to the
 * instance's lifecycle.
 */
const buildElementClass = (
  definition: ElementDefinition,
  registry: CustomElementRegistry | null,
): CustomElementConstructor => {
  // One stylesheet per definition, built on the first instance and
  // adopted by every shadow root; a platform without constructed
  // stylesheets gets a `<style>` element per instance instead, which
  // the template renders ahead of.
  const styleText = definition.styles;
  let sheet: CSSStyleSheet | undefined;
  const adoptStyles = (root: ShadowRoot): ChildNode | null => {
    if (styleText === null || styleText === '') {
      return null;
    }
    if (adoptedStyleSheetsSupported()) {
      if (sheet === undefined) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(styleText);
      }
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return null;
    }
    const style = document.createElement('style');
    style.textContent = styleText;
    root.append(style);
    return style;
  };
  const scoped = registry !== null && scopedRegistriesSupported();

  class Element extends HTMLElement implements WasmElement {
    static readonly observedAttributes = [
      ...definition.observedAttributes,
      'defer-hydration',
    ];

    readonly #instance: ElementInstance;
    readonly #root: ShadowRoot;
    readonly #renderOptions: RenderOptions;
    /**
     * Whether the first update hydrates server-rendered markup rather
     * than rendering: true when the element arrived with a shadow root,
     * which declarative shadow DOM gives an element before it upgrades.
     * The server wrote the styles into that root, so none are adopted.
     */
    #hydrate: boolean;
    #pending = false;
    #rendered = false;
    #settle: ((value: boolean) => void) | undefined;
    #complete: Promise<boolean> = Promise.resolve(false);

    constructor() {
      super();
      this.#instance = definition.create();
      const existing = this.shadowRoot;
      this.#hydrate = existing !== null;
      this.#root = existing ?? this.attachShadow(shadowRootInit(registry));
      this.#renderOptions = {
        host: this,
        renderBefore: existing === null ? adoptStyles(this.#root) : null,
        ...(scoped ? {creationScope: creationScope(registry)} : {}),
      };
      liveElements.set(this.#instance.ref as object, this);
    }

    connectedCallback(): void {
      this.#instance.connected();
      // An element inside server-rendered markup waits for its host to
      // hydrate it first; Lit's hydration removes the attribute.
      if (!this.hasAttribute('defer-hydration')) {
        this.requestUpdate();
      }
    }

    disconnectedCallback(): void {
      this.#instance.disconnected();
    }

    attributeChangedCallback(
      name: string,
      _old: string | null,
      value: string | null,
    ): void {
      if (name === 'defer-hydration') {
        if (value === null && this.isConnected) {
          this.requestUpdate();
        }
        return;
      }
      this.#instance.attributeChanged(name, value);
    }

    requestUpdate(): void {
      if (this.#pending || !this.isConnected) {
        return;
      }
      this.#pending = true;
      this.#complete = new Promise<boolean>((resolve) => {
        this.#settle = resolve;
      });
      queueMicrotask(() => this.#update());
    }

    get updateComplete(): Promise<boolean> {
      return this.#complete;
    }

    #update(): void {
      this.#pending = false;
      const settle = this.#settle;
      this.#settle = undefined;
      try {
        const value = this.#instance.render();
        if (this.#hydrate) {
          // Server-rendered markup: attach lit-html's parts to what is
          // there, after which `render` updates in place.
          this.#hydrate = false;
          hydrate(value, this.#root, this.#renderOptions);
        } else {
          render(value, this.#root, this.#renderOptions);
        }
        const first = !this.#rendered;
        this.#rendered = true;
        this.#instance.updated(first);
      } finally {
        settle?.(true);
      }
    }

    /** The module instance, for the property accessors below. */
    get [instanceKey](): ElementInstance {
      return this.#instance;
    }
  }

  for (const property of definition.properties) {
    Object.defineProperty(Element.prototype, property.name, {
      configurable: true,
      enumerable: true,
      get(this: Element) {
        return this[instanceKey].get(property.name);
      },
      set(this: Element, value: unknown) {
        this[instanceKey].set(property.name, value);
      },
    });
  }

  return Element;
};

const instanceKey = Symbol('wasm-web-ui instance');

const readProperty = (
  exports: ElementExports,
  instance: ModuleObject,
  property: PropertyInfo,
): unknown => {
  switch (property.kind) {
    case ValueKind.text:
    case ValueKind.host:
      return exports.webui_element_get_extern(instance, property.ref);
    case ValueKind.number:
      return exports.webui_element_get_number(instance, property.ref);
    case ValueKind.boolean:
      return exports.webui_element_get_number(instance, property.ref) !== 0;
    default:
      throw new Error(
        `wasm-web-ui: property kind ${property.kind} cannot be read`,
      );
  }
};

const writeProperty = (
  exports: ElementExports,
  instance: ModuleObject,
  property: PropertyInfo,
  value: unknown,
): void => {
  switch (property.kind) {
    case ValueKind.text:
      exports.webui_element_set_extern(
        instance,
        property.ref,
        String(value ?? ''),
      );
      return;
    case ValueKind.host:
      exports.webui_element_set_extern(instance, property.ref, value);
      return;
    case ValueKind.number:
      exports.webui_element_set_number(instance, property.ref, Number(value));
      return;
    case ValueKind.boolean:
      exports.webui_element_set_number(instance, property.ref, value ? 1 : 0);
      return;
    default:
      throw new Error(
        `wasm-web-ui: property kind ${property.kind} cannot be set`,
      );
  }
};
