/**
 * Runtime WebAssembly Component Model Async host for ZenaFX components in the
 * browser (and Node.js v26+).
 *
 * Loads unmodified ZenaFX `.wasm` components (`widgets.wasm`, `button.wasm`,
 * `counter.wasm`, `scroll.wasm`, etc.), instantiates their embedded core WasmGC
 * modules with fresh per-instance capability bindings, implements the Component
 * Model Async waitable/stream/subtask protocol and `wasi:clocks/monotonic-clock`,
 * and bridges `zenafx:host/scene` + `zenafx:host/events` directly to the
 * wasm32 `RenderEngine`.
 */

import {parseZenaFxComponent} from './component-parser.js';
import {transcodeRenderCall, writeDelivery, writeKeyDelivery} from './cabi.js';

const DEFAULT_ANSWER = {
  stopPropagation: false,
  preventDefault: false,
  capture: false,
};

const isShortcut = (event, letter) => {
  const m = event.modifiers ?? {};
  return (
    Boolean(event.down) &&
    (Boolean(m.control) || Boolean(m.meta)) &&
    !m.alt &&
    typeof event.key === 'string' &&
    event.key.length === 1 &&
    event.key.toLowerCase() === letter
  );
};

const createMemoryClipboard = () => {
  let value = null;
  return {
    read: () => value,
    write: (text) => {
      value = String(text);
    },
  };
};

// Component Model Async canonical ABI constants (matches `zena:wasi/async.zena`)
const CALLBACK_EXIT = 0;
const CALLBACK_WAIT = 2;
const CALLBACK_CODE_MASK = 0xf;

const SUBTASK_STATE_STARTED = 1;
const SUBTASK_STATE_RETURNED = 2;

const EVENT_SUBTASK = 1;
const EVENT_STREAM_READ = 2;
const EVENT_FUTURE_READ = 4;

const COPY_COMPLETED = 0;
const COPY_DROPPED = 1;
const BLOCKED = -1;

/**
 * Runs one isolated ZenaFX WebAssembly component instance connected to a
 * `RenderEngine`.
 */
export class ZenaFxComponentRunner {
  /** @type {import('./engine-bridge.js').RenderEngine} */
  #engine;
  #onWake;
  #clipboard;
  #disposed = false;

  // Component instance handles & runtime
  /** @type {WebAssembly.Memory | null} */
  #guestMemory = null;
  /** @type {((oldPtr: number, oldSize: number, align: number, newSize: number) => number) | null} */
  #guestRealloc = null;
  /** @type {((event: number, waitable: number, code: number) => number) | null} */
  #callbackFn = null;

  // Component Model Async state (handle table starts at 1; 0 means none)
  #nextHandle = 1;
  /** @type {Map<number, Set<number>>} waitableSetId -> Set<waitableId> */
  #waitableSets = new Map();
  /** @type {Map<number, number>} waitableId -> waitableSetId */
  #waitableMembership = new Map();
  /** @type {Map<number, {timer: any, settled: boolean}>} */
  #subtasks = new Map();
  /** @type {Map<number, {listenerId: number, kind: 'pointer' | 'key', queue: Array<{event: any, answered: ((answer: {stopPropagation: boolean, preventDefault: boolean, capture: boolean}) => void) | null}>, pendingRead: {ptr: number, len: number} | null, closed: boolean, droppedByGuest: boolean}>} */
  #streams = new Map();
  /** @type {Map<number, number>} listenerId -> streamHandle */
  #listenerToStream = new Map();
  /** @type {Map<number, {stopPropagation: boolean, preventDefault: boolean, capture: boolean, answered: (answer: {stopPropagation: boolean, preventDefault: boolean, capture: boolean}) => void}>} */
  #replies = new Map();
  /** @type {Map<number, {readPending: boolean, written: boolean, peer: number}>} */
  #wakeFutures = new Map();

  // Task execution state
  #waitingSet = 0;
  #inGuest = false;
  #taskExited = false;
  /** @type {Array<{event: number, waitable: number, code: number}>} */
  #readyEvents = [];
  #pumpScheduled = false;

  // Delivery queue (sequential across inputs, matching native `Worker`)
  /** @type {Array<{type: 'pointer', batches: Array<{stopsWhenHandled: boolean, calls: Array<{listener: number, event: any}>}>} | {type: 'key', event: any, listeners: number[], defaultAction: number}>} */
  #deliveryQueue = [];
  #delivering = false;
  #undelivered = 0;
  #deliveryIdleResolvers = [];

  // Telemetry & lifecycle
  #guestEntries = 0;
  #eventsDelivered = 0;
  #ready = false;
  #readyResolve = () => {};
  #readyPromise;

  /**
   * @param {import('./engine-bridge.js').RenderEngine} engine
   * @param {{onWake?: () => void, clipboard?: {read: () => string | null, write: (text: string) => void}}} [options]
   */
  constructor(engine, options = {}) {
    this.#engine = engine;
    this.#onWake = options.onWake ?? (() => {});
    this.#clipboard = options.clipboard ?? createMemoryClipboard();
    this.#readyPromise = new Promise((resolve) => {
      this.#readyResolve = resolve;
    });
  }

  get clipboard() {
    return this.#clipboard;
  }

  get guestEntries() {
    return this.#guestEntries;
  }

  get eventsDelivered() {
    return this.#eventsDelivered;
  }

  get undelivered() {
    return this.#undelivered;
  }

  get isReady() {
    return this.#ready;
  }

  /**
   * Wait until all queued pointer event deliveries have been answered by their
   * listeners (useful for tests).
   */
  waitForDeliveries() {
    if (this.#undelivered === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#deliveryIdleResolvers.push(resolve);
    });
  }

  #allocHandle() {
    return this.#nextHandle++;
  }

  /**
   * Instantiate and start an unmodified ZenaFX `.wasm` component, resolving
   * once the component calls `zenafx:host/scene.ready()`.
   *
   * @param {Uint8Array | ArrayBuffer} componentBytes
   */
  async load(componentBytes) {
    const parsed = await parseZenaFxComponent(componentBytes);

    // 1. Instantiate the embedded `zena:runtime` linear memory module.
    /** @type {Record<string, any>} */
    const runtimeExports = {};
    if (parsed.runtimeModule !== null) {
      const rtInst = await WebAssembly.instantiate(parsed.runtimeModule, {});
      Object.assign(runtimeExports, rtInst.exports);
      this.#guestMemory = /** @type {WebAssembly.Memory} */ (
        rtInst.exports.memory
      );
      this.#guestRealloc = /** @type {any} */ (rtInst.exports.realloc);
    }

    // 2. Build fresh per-instance capability imports for the app core module.
    const importObject = this.#buildImports(parsed.appImports, runtimeExports);

    // 3. Instantiate the app core module.
    const appInstance = await WebAssembly.instantiate(
      parsed.appModule,
      importObject,
    );
    const exports = /** @type {any} */ (appInstance.exports);

    if (this.#guestMemory === null && exports.memory) {
      this.#guestMemory = exports.memory;
    }
    if (this.#guestRealloc === null && exports.cabi_realloc) {
      this.#guestRealloc = exports.cabi_realloc;
    }

    const entryFn = exports[parsed.entryExport];
    this.#callbackFn = parsed.callbackExport
      ? exports[parsed.callbackExport]
      : null;

    // 4. Invoke the component entry (`main`).
    this.#guestEntries += 1;
    this.#inGuest = true;
    try {
      const code = entryFn();
      if (this.#callbackFn !== null) {
        this.#handleCallbackResult(code);
      } else {
        this.#taskExited = true;
      }
    } finally {
      this.#inGuest = false;
    }

    this.#schedulePump();

    // Wait for `ready()` (with a generous timeout so misbehaving components fail loudly).
    if (!this.#ready) {
      await Promise.race([
        this.#readyPromise,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  'ZenaFX component did not call `zenafx:host/scene.ready()` within 10s',
                ),
              ),
            10_000,
          ),
        ),
      ]);
    }
  }

  /**
   * Build the core Wasm import object for this component instance, binding only
   * what the component declares and our policy permits.
   *
   * @param {WebAssembly.ModuleImportDescriptor[]} appImports
   * @param {Record<string, any>} runtimeExports
   */
  #buildImports(appImports, runtimeExports) {
    /** @type {Record<string, Record<string, any>>} */
    const imports = {};
    const ensureNs = (ns) => {
      if (!imports[ns]) imports[ns] = {};
      return imports[ns];
    };

    const sceneImpl = this.#sceneImports();
    const eventsImpl = this.#eventsImports();
    const clockImpl = this.#clockImports();

    for (const desc of appImports) {
      const ns = ensureNs(desc.module);
      if (desc.module === 'zena:runtime') {
        if (!(desc.name in runtimeExports)) {
          throw new Error(`Missing zena:runtime export '${desc.name}'`);
        }
        ns[desc.name] = runtimeExports[desc.name];
      } else if (desc.module === 'zenafx:host/scene@0.1.0') {
        if (!(desc.name in sceneImpl)) {
          throw new Error(
            `Unsupported zenafx:host/scene import '${desc.name}'`,
          );
        }
        ns[desc.name] = sceneImpl[desc.name];
      } else if (desc.module === 'zenafx:host/events@0.1.0') {
        if (!(desc.name in eventsImpl)) {
          throw new Error(
            `Unsupported zenafx:host/events import '${desc.name}'`,
          );
        }
        ns[desc.name] = eventsImpl[desc.name];
      } else if (desc.module === 'wasi:clocks/monotonic-clock@0.3.0') {
        if (!(desc.name in clockImpl)) {
          throw new Error(
            `Unsupported wasi:clocks/monotonic-clock import '${desc.name}'`,
          );
        }
        ns[desc.name] = clockImpl[desc.name];
      } else if (desc.module === 'canon') {
        ns[desc.name] = this.#resolveCanonBuiltin(desc.name);
      } else {
        throw new Error(
          `Component requested unpermitted import '${desc.module}'.'${desc.name}'`,
        );
      }
    }

    return imports;
  }

  #sceneImports() {
    return {
      ready: () => {
        if (!this.#ready) {
          this.#ready = true;
          this.#readyResolve();
        }
        this.#onWake();
      },

      root: () => this.#engine.root(),

      '[method]node.render': (
        node,
        templateTag,
        templateId,
        nodesPtr,
        nodesLen,
        bindingsPtr,
        bindingsLen,
        statesPtr,
        statesLen,
        holesPtr,
        holesLen,
      ) => {
        if (this.#guestMemory === null) {
          throw new Error('Guest component has no linear memory');
        }
        const payload = transcodeRenderCall(
          this.#guestMemory,
          templateTag,
          templateId,
          nodesPtr,
          nodesLen,
          bindingsPtr,
          bindingsLen,
          statesPtr,
          statesLen,
          holesPtr,
          holesLen,
        );
        this.#engine.render(node, payload);
        this.#afterSceneMutation();
      },

      '[method]node.content': (node, slot, count, retptr) => {
        if (this.#guestMemory === null || this.#guestRealloc === null) {
          throw new Error('Guest component has no linear memory or realloc');
        }
        const ids = this.#engine.content(node, slot, count);
        this.#afterSceneMutation();
        if (ids === null) {
          throw new Error(`a node has no slot ${slot}`);
        }
        const byteLen = ids.length * 4;
        const listPtr =
          byteLen > 0 ? this.#guestRealloc(0, 0, 4, byteLen) >>> 0 : 0;
        const view = new DataView(this.#guestMemory.buffer);
        for (let i = 0; i < ids.length; i++) {
          view.setUint32(listPtr + i * 4, ids[i] >>> 0, true);
        }
        view.setUint32(retptr, listPtr, true);
        view.setUint32(retptr + 4, ids.length, true);
      },

      'create-node': () => {
        return this.#engine.createNode();
      },

      '[method]node.set-slot': (node, slot, listPtr, listLen) => {
        if (this.#guestMemory === null) {
          throw new Error('Guest component has no linear memory');
        }
        const view = new DataView(this.#guestMemory.buffer);
        const children = new Array(listLen);
        for (let i = 0; i < listLen; i++) {
          children[i] = view.getUint32((listPtr >>> 0) + i * 4, true);
        }
        const ok = this.#engine.setSlot(node, slot, children);
        if (!ok) {
          throw new Error(`could not set slot ${slot} on node`);
        }
        this.#afterSceneMutation();
      },

      '[method]node.listen-pointer': (node, target, kind, scope, phase) => {
        const streamHandle = this.#allocHandle();
        const listenerId = streamHandle;
        const ok = this.#engine.listenPointer(
          node,
          target,
          kind,
          scope,
          phase,
          listenerId,
        );
        if (!ok) {
          throw new Error(
            `a node shows no template with a position ${target} to listen at`,
          );
        }
        this.#streams.set(streamHandle, {
          listenerId,
          kind: 'pointer',
          queue: [],
          pendingRead: null,
          closed: false,
          droppedByGuest: false,
        });
        this.#listenerToStream.set(listenerId, streamHandle);
        return streamHandle;
      },

      '[method]node.listen-keys': (node, target, phase) => {
        const streamHandle = this.#allocHandle();
        const listenerId = streamHandle;
        const ok = this.#engine.listenKeys(node, target, phase, listenerId);
        if (!ok) {
          throw new Error(
            `a node shows no template with a position ${target} to listen at`,
          );
        }
        this.#streams.set(streamHandle, {
          listenerId,
          kind: 'key',
          queue: [],
          pendingRead: null,
          closed: false,
          droppedByGuest: false,
        });
        this.#listenerToStream.set(listenerId, streamHandle);
        return streamHandle;
      },

      '[method]node.selection': (node, target, retptr) => {
        if (this.#guestMemory === null) {
          throw new Error('Guest component has no linear memory');
        }
        const sel = this.#engine.selectionIn(node, target);
        const view = new DataView(this.#guestMemory.buffer);
        if (sel === null) {
          view.setUint32(retptr, 0, true);
          view.setUint32(retptr + 4, 0, true);
          view.setUint32(retptr + 8, 0, true);
        } else {
          view.setUint32(retptr, 1, true);
          view.setUint32(retptr + 4, sel.anchor >>> 0, true);
          view.setUint32(retptr + 8, sel.focus >>> 0, true);
        }
      },

      '[method]node.select': (node, target, anchor, focus) => {
        const ok = this.#engine.select(node, target, anchor, focus);
        if (!ok) {
          throw new Error(
            `a node shows no template with text at position ${target} to select in`,
          );
        }
        this.#afterSceneMutation();
      },
    };
  }

  #eventsImports() {
    return {
      '[method]reply.stop-propagation': (replyHandle) => {
        const entry = this.#replies.get(replyHandle);
        if (entry) {
          entry.stopPropagation = true;
        }
      },
      '[method]reply.prevent-default': (replyHandle) => {
        const entry = this.#replies.get(replyHandle);
        if (entry) {
          entry.preventDefault = true;
        }
      },
      '[method]reply.capture': (replyHandle) => {
        const entry = this.#replies.get(replyHandle);
        if (entry) {
          entry.capture = true;
        }
      },
    };
  }

  #clockImports() {
    return {
      now: () => BigInt(Math.round(performance.now() * 1_000_000)),
      'get-resolution': () => 1_000_000n,
      'wait-for': (durationNs) => {
        const ms = Number(durationNs) / 1_000_000;
        return this.#spawnTimerSubtask(Math.max(0, ms));
      },
      'wait-until': (whenNs) => {
        const nowNs = BigInt(Math.round(performance.now() * 1_000_000));
        const diffMs = Number(whenNs - nowNs) / 1_000_000;
        return this.#spawnTimerSubtask(Math.max(0, diffMs));
      },
    };
  }

  #spawnTimerSubtask(delayMs) {
    if (delayMs <= 0) {
      return SUBTASK_STATE_RETURNED;
    }
    const handle = this.#allocHandle();
    const record = {timer: null, settled: false};
    record.timer = setTimeout(() => {
      if (this.#disposed || record.settled) return;
      record.settled = true;
      record.timer = null;
      this.#enqueueReadyEvent(EVENT_SUBTASK, handle, SUBTASK_STATE_RETURNED);
    }, delayMs);
    this.#subtasks.set(handle, record);
    return (handle << 4) | SUBTASK_STATE_STARTED;
  }

  /**
   * Resolve a `"canon"` Component Model Async builtin by name.
   * @param {string} name
   */
  #resolveCanonBuiltin(name) {
    if (name === 'waitable-set.new') {
      return () => {
        const id = this.#allocHandle();
        this.#waitableSets.set(id, new Set());
        return id;
      };
    }
    if (name === 'waitable-set.drop') {
      return (setId) => {
        this.#waitableSets.delete(setId);
      };
    }
    if (name === 'waitable.join') {
      return (waitable, setId) => {
        const prev = this.#waitableMembership.get(waitable);
        if (prev !== undefined) {
          this.#waitableSets.get(prev)?.delete(waitable);
        }
        if (setId === 0) {
          this.#waitableMembership.delete(waitable);
        } else {
          this.#waitableMembership.set(waitable, setId);
          let set = this.#waitableSets.get(setId);
          if (!set) {
            set = new Set();
            this.#waitableSets.set(setId, set);
          }
          set.add(waitable);
        }
      };
    }
    if (name === 'subtask.drop') {
      return (subtask) => {
        const rec = this.#subtasks.get(subtask);
        if (rec?.timer) clearTimeout(rec.timer);
        this.#subtasks.delete(subtask);
        this.#removeWaitableFromSets(subtask);
      };
    }
    if (name === 'task.return') {
      return () => {};
    }
    if (name.startsWith('resource.drop#')) {
      if (name.endsWith('#reply')) {
        return (replyHandle) => {
          const entry = this.#replies.get(replyHandle);
          if (entry) {
            this.#replies.delete(replyHandle);
            entry.answered({
              stopPropagation: entry.stopPropagation,
              preventDefault: entry.preventDefault,
              capture: entry.capture,
            });
          }
        };
      }
      // `resource.drop#...#node`: frees guest-owned nodes (`create-node`), no-op for slot-owned ones.
      return (nodeHandle) => {
        if (this.#engine.dropNode(nodeHandle)) {
          this.#afterSceneMutation();
        }
      };
    }
    if (name.startsWith('stream.read#')) {
      return (streamHandle, ptr, len) => {
        const stream = this.#streams.get(streamHandle);
        if (!stream) return COPY_DROPPED;
        if (stream.queue.length > 0 && len > 0) {
          const offered = stream.queue.shift();
          this.#writeOfferedToGuest(stream, ptr, offered);
          return (1 << 4) | COPY_COMPLETED;
        }
        if (stream.closed) {
          return COPY_DROPPED;
        }
        stream.pendingRead = {ptr: ptr >>> 0, len: len >>> 0};
        return BLOCKED;
      };
    }
    if (name.startsWith('stream.drop-readable#')) {
      return (streamHandle) => {
        const stream = this.#streams.get(streamHandle);
        if (!stream) return;
        stream.droppedByGuest = true;
        // Any queued events will never be read; unblock awaiting deliveries.
        for (const item of stream.queue) {
          if (item.answered) item.answered(DEFAULT_ANSWER);
        }
        stream.queue.length = 0;
        this.#streams.delete(streamHandle);
        this.#listenerToStream.delete(stream.listenerId);
        this.#removeWaitableFromSets(streamHandle);
        this.#engine.unlisten(stream.listenerId);
      };
    }
    if (name.startsWith('future.new#')) {
      return () => {
        const readable = this.#allocHandle();
        const writable = this.#allocHandle();
        this.#wakeFutures.set(readable, {
          readPending: false,
          written: false,
          peer: writable,
        });
        this.#wakeFutures.set(writable, {
          readPending: false,
          written: false,
          peer: readable,
        });
        return (BigInt(writable) << 32n) | BigInt(readable);
      };
    }
    if (name.startsWith('future.read#')) {
      return (end, _ptr) => {
        const f = this.#wakeFutures.get(end);
        if (!f) return COPY_DROPPED;
        if (f.written) return COPY_COMPLETED;
        f.readPending = true;
        return BLOCKED;
      };
    }
    if (name.startsWith('future.write#')) {
      return (end, _ptr) => {
        const w = this.#wakeFutures.get(end);
        if (!w) return COPY_DROPPED;
        const r = this.#wakeFutures.get(w.peer);
        if (r) {
          r.written = true;
          if (r.readPending) {
            r.readPending = false;
            this.#enqueueReadyEvent(EVENT_FUTURE_READ, w.peer, COPY_COMPLETED);
          }
        }
        return COPY_COMPLETED;
      };
    }
    if (
      name.startsWith('future.drop-readable#') ||
      name.startsWith('future.drop-writable#')
    ) {
      return (end) => {
        this.#wakeFutures.delete(end);
        this.#removeWaitableFromSets(end);
      };
    }
    throw new Error(`Unsupported canonical builtin '${name}'`);
  }

  #removeWaitableFromSets(waitable) {
    const setId = this.#waitableMembership.get(waitable);
    if (setId !== undefined) {
      this.#waitableSets.get(setId)?.delete(waitable);
      this.#waitableMembership.delete(waitable);
    }
  }

  #writeOfferedToGuest(stream, ptr, offered) {
    if (this.#guestMemory === null) return;
    let replyHandle = null;
    if (offered.answered !== null) {
      replyHandle = this.#allocHandle();
      this.#replies.set(replyHandle, {
        stopPropagation: false,
        preventDefault: false,
        capture: false,
        answered: offered.answered,
      });
    }
    if (stream.kind === 'key') {
      if (this.#guestRealloc === null) {
        throw new Error('Guest component has no realloc for key delivery');
      }
      writeKeyDelivery(
        this.#guestMemory,
        this.#guestRealloc,
        ptr,
        offered.event,
        replyHandle ?? 0,
      );
    } else {
      writeDelivery(this.#guestMemory, ptr, offered.event, replyHandle);
    }
  }

  #afterSceneMutation() {
    const ended = this.#engine.takeEnded();
    for (const listenerId of ended) {
      this.#endListener(listenerId);
    }
    this.#onWake();
  }

  #endListener(listenerId) {
    const streamHandle = this.#listenerToStream.get(listenerId);
    if (streamHandle === undefined) return;
    this.#listenerToStream.delete(listenerId);
    const stream = this.#streams.get(streamHandle);
    if (!stream) return;
    stream.closed = true;
    if (stream.pendingRead !== null) {
      stream.pendingRead = null;
      this.#enqueueReadyEvent(EVENT_STREAM_READ, streamHandle, COPY_DROPPED);
    }
  }

  #offerToListener(listenerId, event, answered) {
    const streamHandle = this.#listenerToStream.get(listenerId);
    if (streamHandle === undefined) return false;
    const stream = this.#streams.get(streamHandle);
    if (!stream || stream.closed || stream.droppedByGuest) return false;

    this.#eventsDelivered += 1;
    const offered = {event, answered};
    if (stream.pendingRead !== null && stream.pendingRead.len > 0) {
      const {ptr} = stream.pendingRead;
      stream.pendingRead = null;
      this.#writeOfferedToGuest(stream, ptr, offered);
      this.#enqueueReadyEvent(
        EVENT_STREAM_READ,
        streamHandle,
        (1 << 4) | COPY_COMPLETED,
      );
    } else {
      stream.queue.push(offered);
    }
    return true;
  }

  #handleCallbackResult(code) {
    const tag = code & CALLBACK_CODE_MASK;
    if (tag === CALLBACK_EXIT) {
      this.#taskExited = true;
      this.#waitingSet = 0;
    } else if (tag === CALLBACK_WAIT) {
      this.#waitingSet = code >>> 4;
    }
  }

  #enqueueReadyEvent(event, waitable, code) {
    if (this.#disposed || this.#taskExited) return;
    this.#readyEvents.push({event, waitable, code});
    this.#schedulePump();
  }

  #schedulePump() {
    if (this.#pumpScheduled || this.#disposed || this.#taskExited) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      this.#pumpEvents();
    });
  }

  #pumpEvents() {
    if (
      this.#disposed ||
      this.#taskExited ||
      this.#inGuest ||
      this.#waitingSet === 0 ||
      this.#callbackFn === null
    ) {
      return;
    }
    while (
      !this.#disposed &&
      !this.#taskExited &&
      this.#waitingSet !== 0 &&
      this.#readyEvents.length > 0
    ) {
      const waitingMembers = this.#waitableSets.get(this.#waitingSet);
      const idx = this.#readyEvents.findIndex(
        (ev) => waitingMembers?.has(ev.waitable) ?? false,
      );
      if (idx === -1) break;
      const ev = this.#readyEvents.splice(idx, 1)[0];
      this.#inGuest = true;
      try {
        const code = this.#callbackFn(ev.event, ev.waitable, ev.code);
        this.#handleCallbackResult(code);
      } finally {
        this.#inGuest = false;
      }
    }
  }

  /**
   * Hand deliveries produced by `RenderEngine.pointer()` or `takeOwed()` to
   * the component's listener streams.
   */
  handOver(deliveries) {
    if (this.#disposed || deliveries.length === 0) return;
    this.#enqueueDelivery({type: 'pointer', batches: deliveries});
  }

  #enqueueDelivery(item) {
    if (this.#disposed) return;
    this.#undelivered += 1;
    this.#deliveryQueue.push(item);
    if (!this.#delivering) {
      this.#drainDeliveries();
    }
  }

  async #drainDeliveries() {
    this.#delivering = true;
    try {
      while (!this.#disposed && this.#deliveryQueue.length > 0) {
        const item = this.#deliveryQueue.shift();
        if (item.type === 'pointer') {
          for (const delivery of item.batches) {
            for (const call of delivery.calls) {
              if (this.#disposed) return;
              if (!delivery.stopsWhenHandled) {
                this.#offerToListener(call.listener, call.event, null);
                continue;
              }
              let resolveAnswer;
              const answeredPromise = new Promise((resolve) => {
                resolveAnswer = resolve;
              });
              const offered = this.#offerToListener(
                call.listener,
                call.event,
                resolveAnswer,
              );
              if (!offered) continue;
              const answer = await answeredPromise;
              if (answer.capture) {
                if (this.#engine.capture(call.listener)) {
                  this.#onWake();
                }
              }
              if (answer.stopPropagation) break;
            }
          }
        } else if (item.type === 'key') {
          let prevented = false;
          for (const listenerId of item.listeners) {
            if (this.#disposed) return;
            let resolveAnswer;
            const answeredPromise = new Promise((resolve) => {
              resolveAnswer = resolve;
            });
            const offered = this.#offerToListener(
              listenerId,
              item.event,
              resolveAnswer,
            );
            if (!offered) continue;
            const answer = await answeredPromise;
            prevented = prevented || answer.preventDefault;
            if (answer.stopPropagation) break;
          }
          if (!prevented && !this.#disposed && item.defaultAction !== 0) {
            if (this.#engine.actOnKeyDefault(item.defaultAction)) {
              this.#onWake();
            }
          }
        }
        this.#undelivered -= 1;
        if (this.#undelivered === 0) {
          const resolvers = this.#deliveryIdleResolvers.splice(0);
          for (const r of resolvers) r();
        }
      }
    } finally {
      this.#delivering = false;
    }
  }

  /**
   * Feed a pointer input to the scene, delivering any resulting listener events
   * and returning whether the scene changed and owes a redraw.
   */
  pointer(input, nowMs = performance.now()) {
    const {deliveries, dirty} = this.#engine.pointer(input, nowMs);
    this.handOver(deliveries);
    if (dirty) {
      this.#onWake();
    }
    return dirty;
  }

  #dispatchKey(event) {
    const {defaultAction, dirty, listeners} = this.#engine.key(event);
    if (listeners.length > 0) {
      this.#enqueueDelivery({
        type: 'key',
        event,
        listeners,
        defaultAction,
      });
    }
    if (dirty) {
      this.#onWake();
    }
    return dirty;
  }

  /**
   * Feed a keyboard event to the scene, handling host clipboard shortcuts
   * (`Ctrl/Meta+C`, `Ctrl/Meta+X`, `Ctrl/Meta+V`) just like native `GuestScene::key`.
   *
   * @param {{down: boolean, key: string, code: string, modifiers?: {shift?: boolean, control?: boolean, alt?: boolean, meta?: boolean}, repeat?: boolean, text?: string | null}} event
   * @param {{skipClipboardPaste?: boolean}} [options]
   * @returns {boolean}
   */
  key(event, options = {}) {
    const copies = isShortcut(event, 'c') || isShortcut(event, 'x');
    const pasted =
      !options.skipClipboardPaste && isShortcut(event, 'v')
        ? this.#clipboard.read()
        : null;
    if (copies) {
      const selected = this.#engine.selectedText();
      if (selected !== null) {
        this.#clipboard.write(selected);
      }
    }
    let owed = this.#dispatchKey(event);
    if (pasted !== null && pasted.length > 0) {
      owed = this.pasteText(pasted) || owed;
    }
    return owed;
  }

  /**
   * Deliver pasted text as a synthetic `Paste` key event, matching native
   * `GuestScene::key`.
   * @param {string} text
   * @returns {boolean}
   */
  pasteText(text) {
    if (!text) return false;
    return this.#dispatchKey({
      down: true,
      key: 'Paste',
      code: '',
      modifiers: {shift: false, control: false, alt: false, meta: false},
      repeat: false,
      text,
    });
  }

  /**
   * Current CSS cursor keyword requested by the scene.
   * @returns {string}
   */
  cursor() {
    return this.#engine.cursor();
  }

  /**
   * Draw one frame at `(width, height)` physical pixels and deliver any owed
   * `enter`/`leave` events if layout moved nodes under a still pointer.
   */
  frame(width, height, bg) {
    const result = this.#engine.drawFrame(width, height, bg);
    const owed = this.#engine.takeOwed();
    this.handOver(owed);
    return result;
  }

  /**
   * Stop all pending timers, unblock awaiting deliveries, and release state.
   */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const rec of this.#subtasks.values()) {
      if (rec.timer) clearTimeout(rec.timer);
    }
    this.#subtasks.clear();
    for (const entry of this.#replies.values()) {
      entry.answered(DEFAULT_ANSWER);
    }
    this.#replies.clear();
    for (const stream of this.#streams.values()) {
      for (const item of stream.queue) {
        if (item.answered) item.answered(DEFAULT_ANSWER);
      }
      stream.queue.length = 0;
    }
    this.#streams.clear();
    this.#listenerToStream.clear();
    this.#deliveryQueue.length = 0;
    this.#undelivered = 0;
    const resolvers = this.#deliveryIdleResolvers.splice(0);
    for (const r of resolvers) r();
  }
}
