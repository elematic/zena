/**
 * Browser `<canvas>` surface for ZenaFX (`ZenaFxCanvasSurface`).
 *
 * Implements the web bottom layer corresponding to `packages/zenafx/src/ui/surface.rs`:
 * - Demand-driven redraw via `requestAnimationFrame` (stays completely idle
 *   when nothing is dirty, matching native `ControlFlow::Wait`).
 * - Supports both Canvas 2D (`putImageData`) and WebGPU (`writeTexture` +
 *   fullscreen WGSL blit) presentation backends.
 * - Handles `ResizeObserver`, `devicePixelRatio`, and pointer/wheel input.
 */

import {ZenaFxComponentRunner} from './component-runner.js';

const WEBGPU_BLIT_WGSL = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) idx: u32) -> VsOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(3.0, 1.0),
    vec2<f32>(-1.0, 1.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 2.0),
    vec2<f32>(2.0, 0.0),
    vec2<f32>(0.0, 0.0),
  );
  var out: VsOut;
  out.pos = vec4<f32>(positions[idx], 0.0, 1.0);
  out.uv = uvs[idx];
  return out;
}

@group(0) @binding(0) var frameSampler: sampler;
@group(0) @binding(1) var frameTexture: texture_2d<f32>;

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(frameTexture, frameSampler, in.uv);
}
`;

/**
 * WebGPU texture presenter: uploads Vello CPU's premultiplied RGBA8 framebuffer
 * directly from Wasm linear memory to a `GPUTexture` and blits to the canvas.
 */
class WebGpuPresenter {
  #device;
  #context;
  #pipeline;
  #sampler;
  #texture = null;
  #bindGroup = null;
  #texWidth = 0;
  #texHeight = 0;

  constructor(device, context, format) {
    this.#device = device;
    this.#context = context;
    const shader = device.createShaderModule({code: WEBGPU_BLIT_WGSL});
    this.#pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {module: shader, entryPoint: 'vs'},
      fragment: {
        module: shader,
        entryPoint: 'fs',
        targets: [{format}],
      },
      primitive: {topology: 'triangle-list'},
    });
    this.#sampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    });
  }

  static async create(canvas) {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return null;
    }
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        console.warn(
          '[zenafx-web] WebGPU: no adapter available; falling back to Canvas 2D',
        );
        return null;
      }
      const device = await adapter.requestDevice();
      const context = canvas.getContext('webgpu');
      if (!context) {
        console.warn(
          '[zenafx-web] WebGPU: canvas.getContext("webgpu") returned null (canvas may already have a 2d context); falling back to Canvas 2D',
        );
        device.destroy?.();
        return null;
      }
      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({device, format, alphaMode: 'premultiplied'});
      return new WebGpuPresenter(device, context, format);
    } catch (err) {
      console.warn(
        '[zenafx-web] WebGPU initialization failed; falling back to Canvas 2D:',
        err,
      );
      return null;
    }
  }

  #ensureTexture(width, height) {
    if (
      this.#texWidth === width &&
      this.#texHeight === height &&
      this.#texture
    ) {
      return;
    }
    this.#texture?.destroy();
    this.#texture = this.#device.createTexture({
      size: [width, height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#bindGroup = this.#device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: this.#sampler},
        {binding: 1, resource: this.#texture.createView()},
      ],
    });
    this.#texWidth = width;
    this.#texHeight = height;
  }

  present(engine, width, height) {
    this.#ensureTexture(width, height);
    const bytes = engine.premulPixels();
    this.#device.queue.writeTexture(
      {texture: this.#texture},
      bytes,
      {bytesPerRow: width * 4, rowsPerImage: height},
      {width, height, depthOrArrayLayers: 1},
    );
    const encoder = this.#device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.#context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: {r: 1, g: 1, b: 1, a: 1},
        },
      ],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(3);
    pass.end();
    this.#device.queue.submit([encoder.finish()]);
  }

  dispose() {
    this.#texture?.destroy();
    this.#texture = null;
    this.#bindGroup = null;
    this.#context?.unconfigure?.();
    this.#device?.destroy?.();
  }
}

/**
 * Canvas 2D presenter: blits unpremultiplied RGBA8 pixels via `putImageData`.
 */
class Canvas2dPresenter {
  #ctx;
  #imageData = null;

  constructor(canvas) {
    const ctx = canvas.getContext('2d', {alpha: false});
    if (!ctx) {
      throw new Error('Could not acquire 2D canvas context');
    }
    this.#ctx = ctx;
  }

  present(engine, width, height) {
    if (
      !this.#imageData ||
      this.#imageData.width !== width ||
      this.#imageData.height !== height
    ) {
      this.#imageData = this.#ctx.createImageData(width, height);
    }
    this.#imageData.data.set(engine.rgbaPixels());
    this.#ctx.putImageData(this.#imageData, 0, 0);
  }

  dispose() {}
}

/**
 * Interactive browser surface connecting an HTML `<canvas>` to a `RenderEngine`
 * and optional `ZenaFxComponentRunner`.
 */
export class ZenaFxCanvasSurface {
  #canvas;
  #engine;
  /** @type {ZenaFxComponentRunner | null} */
  #runner = null;
  #presenter;
  #backendName;
  #onFrame;
  #background;

  #rafId = 0;
  #frames = 0;
  #disposed = false;
  #shownCursor = 'default';
  #resizeObserver = null;
  #abortController = new AbortController();

  constructor(canvas, engine, presenter, backendName, options = {}) {
    this.#canvas = canvas;
    this.#engine = engine;
    this.#presenter = presenter;
    this.#backendName = backendName;
    this.#onFrame = options.onFrame ?? (() => {});
    this.#background = options.background ?? {r: 1, g: 1, b: 1, a: 1};
    this.#bindEvents();
  }

  /**
   * Create a surface attached to `canvas`.
   *
   * Note: per the HTML Canvas spec, a `<canvas>` element permanently locks its
   * context type on the first `getContext()` call. Pass a freshly created
   * `<canvas>` element when switching between `'canvas2d'` and `'webgpu'`.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {import('./engine-bridge.js').RenderEngine} engine
   * @param {{backend?: 'canvas2d' | 'webgpu', onFrame?: (stats: any) => void, background?: {r: number, g: number, b: number, a: number}}} [options]
   */
  static async create(canvas, engine, options = {}) {
    let presenter = null;
    let backendName = 'canvas2d';
    if (options.backend === 'webgpu') {
      presenter = await WebGpuPresenter.create(canvas);
      if (presenter) {
        backendName = 'webgpu';
      }
    }
    if (!presenter) {
      presenter = new Canvas2dPresenter(canvas);
      backendName = 'canvas2d';
    }
    return new ZenaFxCanvasSurface(
      canvas,
      engine,
      presenter,
      backendName,
      options,
    );
  }

  get backend() {
    return this.#backendName;
  }

  get frames() {
    return this.#frames;
  }

  get runner() {
    return this.#runner;
  }

  /**
   * Load an unmodified ZenaFX `.wasm` component onto this surface.
   * @param {Uint8Array | ArrayBuffer} componentBytes
   */
  async loadComponent(componentBytes) {
    this.#runner?.dispose();
    this.#syncCanvasSize();
    let memoryClipboard = null;
    const clipboard = {
      read: () => memoryClipboard,
      write: (text) => {
        memoryClipboard = text;
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          navigator.clipboard.writeText(text).catch(() => {});
        }
      },
    };
    const runner = new ZenaFxComponentRunner(this.#engine, {
      clipboard,
      onWake: () => {
        this.#syncCursor();
        this.requestRedraw();
      },
    });
    this.#runner = runner;
    await runner.load(componentBytes);
    this.#syncCursor();
    this.requestRedraw();
    return runner;
  }

  /**
   * Show the built-in Rust "Hello, world" scene (no guest component).
   * @param {string} [message]
   */
  loadHelloDemo(message) {
    this.#runner?.dispose();
    this.#runner = null;
    this.#syncCanvasSize();
    this.#engine.loadHelloDemo(message);
    this.requestRedraw();
  }

  /**
   * Schedule one frame on the next animation frame (coalesced).
   */
  requestRedraw() {
    if (this.#disposed || this.#rafId !== 0) return;
    this.#rafId = requestAnimationFrame(() => {
      this.#rafId = 0;
      this.#renderFrame();
    });
  }

  #syncCanvasSize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = this.#canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.#canvas.width !== w || this.#canvas.height !== h) {
      this.#canvas.width = w;
      this.#canvas.height = h;
    }
    this.#engine.setScale(dpr);
    return {width: w, height: h, scale: dpr};
  }

  #renderFrame() {
    if (this.#disposed) return;
    const {width, height, scale} = this.#syncCanvasSize();
    const t0 = performance.now();
    const result = this.#runner
      ? this.#runner.frame(width, height, this.#background)
      : this.#engine.drawFrame(width, height, this.#background);
    this.#presenter.present(this.#engine, result.width, result.height);
    this.#syncCursor();
    const elapsedMs = performance.now() - t0;
    this.#frames += 1;

    this.#onFrame({
      frames: this.#frames,
      width: result.width,
      height: result.height,
      scale,
      commandCount: result.commandCount,
      solves: this.#engine.solves(),
      nodes: this.#engine.nodeCount(),
      guestEntries: this.#runner?.guestEntries ?? 0,
      eventsDelivered: this.#runner?.eventsDelivered ?? 0,
      frameTimeMs: elapsedMs,
      backend: this.#backendName,
    });

    if (this.#engine.isDirty()) {
      this.requestRedraw();
    }
  }

  #canvasCoords(event) {
    const rect = this.#canvas.getBoundingClientRect();
    const dpr = this.#canvas.width / Math.max(1, rect.width);
    return {
      x: (event.clientX - rect.left) * dpr,
      y: (event.clientY - rect.top) * dpr,
      dpr,
    };
  }

  #syncCursor() {
    const next = this.#engine.cursor();
    if (next !== this.#shownCursor) {
      this.#shownCursor = next;
      if (this.#canvas.style) {
        this.#canvas.style.cursor = next;
      }
    }
  }

  #bindEvents() {
    const {signal} = this.#abortController;
    const canvas = this.#canvas;

    // Make the canvas focusable so keyboard shortcuts, Tab focus traversal,
    // text editing, and clipboard paste reach it when clicked.
    if (typeof canvas.tabIndex === 'number' && canvas.tabIndex < 0) {
      canvas.tabIndex = 0;
    } else if (canvas.tabIndex === undefined) {
      canvas.tabIndex = 0;
    }
    if (canvas.style) {
      canvas.style.outline = 'none';
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => {
        this.#syncCanvasSize();
        this.requestRedraw();
      });
      this.#resizeObserver.observe(canvas);
    }

    canvas.addEventListener(
      'pointermove',
      (e) => {
        if (!this.#runner) return;
        const {x, y} = this.#canvasCoords(e);
        const dirty = this.#runner.pointer({type: 'moved', x, y});
        this.#syncCursor();
        if (dirty) {
          this.requestRedraw();
        }
      },
      {signal},
    );

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.#runner) return;
        canvas.focus?.({preventScroll: true});
        if (e.button === 0 && e.pointerId !== undefined) {
          try {
            canvas.setPointerCapture?.(e.pointerId);
          } catch {
            // ignore synthetic events without an active pointer
          }
        }
        const {x, y} = this.#canvasCoords(e);
        const dirty = this.#runner.pointer({
          type: 'button',
          x,
          y,
          button: e.button,
          down: true,
        });
        this.#syncCursor();
        if (dirty) {
          this.requestRedraw();
        }
      },
      {signal},
    );

    canvas.addEventListener(
      'pointerup',
      (e) => {
        if (!this.#runner) return;
        if (
          e.button === 0 &&
          e.pointerId !== undefined &&
          canvas.hasPointerCapture?.(e.pointerId)
        ) {
          try {
            canvas.releasePointerCapture?.(e.pointerId);
          } catch {
            // ignore
          }
        }
        const {x, y} = this.#canvasCoords(e);
        const dirty = this.#runner.pointer({
          type: 'button',
          x,
          y,
          button: e.button,
          down: false,
        });
        this.#syncCursor();
        if (dirty) {
          this.requestRedraw();
        }
      },
      {signal},
    );

    canvas.addEventListener(
      'pointerleave',
      () => {
        if (!this.#runner) return;
        const dirty = this.#runner.pointer({type: 'left'});
        this.#syncCursor();
        if (dirty) {
          this.requestRedraw();
        }
      },
      {signal},
    );

    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.#runner) return;
        e.preventDefault();
        const {x, y, dpr} = this.#canvasCoords(e);
        // DOM deltaMode: 0 = pixel, 1 = line (~48px), 2 = page
        const mult =
          e.deltaMode === 1
            ? 48 * dpr
            : e.deltaMode === 2
              ? this.#canvas.height
              : dpr;
        const dirty = this.#runner.pointer({
          type: 'wheel',
          x,
          y,
          dx: e.deltaX * mult,
          dy: e.deltaY * mult,
        });
        this.#syncCursor();
        if (dirty) {
          this.requestRedraw();
        }
      },
      {signal, passive: false},
    );

    const toKeyEvent = (e, down) => {
      const modifiers = {
        shift: Boolean(e.shiftKey),
        control: Boolean(e.ctrlKey),
        alt: Boolean(e.altKey),
        meta: Boolean(e.metaKey),
      };
      const key = e.key ?? '';
      // Printable text typed by this press (matching native `typed()`).
      const text =
        down &&
        !modifiers.control &&
        !modifiers.meta &&
        key.length === 1 &&
        key.charCodeAt(0) >= 0x20
          ? key
          : null;
      return {
        down,
        key,
        code: e.code ?? '',
        modifiers,
        repeat: Boolean(e.repeat),
        text,
      };
    };

    const isBrowserClipboardPaste = (ev) =>
      ev.down &&
      (ev.modifiers.control || ev.modifiers.meta) &&
      !ev.modifiers.alt &&
      ev.key.toLowerCase() === 'v';

    const shouldPreventBrowserDefault = (ev) => {
      if (!ev.down) return false;
      if (isBrowserClipboardPaste(ev)) {
        // Let the browser fire the native `paste` event so we receive the real
        // system clipboard synchronously in `clipboardData`.
        return false;
      }
      if (
        (ev.modifiers.control || ev.modifiers.meta) &&
        !ev.modifiers.alt &&
        ['a', 'c', 'x'].includes(ev.key.toLowerCase())
      ) {
        return true;
      }
      return (
        ev.key === 'Tab' ||
        ev.key === ' ' ||
        ev.key === 'Enter' ||
        ev.key === 'Backspace' ||
        ev.key === 'Delete' ||
        ev.key === 'Home' ||
        ev.key === 'End' ||
        ev.key.startsWith('Arrow')
      );
    };

    canvas.addEventListener(
      'keydown',
      (e) => {
        if (!this.#runner) return;
        const ev = toKeyEvent(e, true);
        if (shouldPreventBrowserDefault(ev)) {
          e.preventDefault();
        }
        // In browsers, let the native `paste` event deliver system clipboard text
        // so pasting from external apps works without extra permissions.
        const skipClipboardPaste =
          typeof ClipboardEvent !== 'undefined' && isBrowserClipboardPaste(ev);
        const dirty = this.#runner.key(ev, {skipClipboardPaste});
        this.#syncCursor();
        if (dirty) {
          this.requestRedraw();
        }
      },
      {signal},
    );

    canvas.addEventListener(
      'keyup',
      (e) => {
        if (!this.#runner) return;
        const ev = toKeyEvent(e, false);
        const dirty = this.#runner.key(ev);
        this.#syncCursor();
        if (dirty) {
          this.requestRedraw();
        }
      },
      {signal},
    );

    canvas.addEventListener(
      'paste',
      (e) => {
        if (!this.#runner) return;
        const text =
          e.clipboardData?.getData('text/plain') ||
          this.#runner.clipboard.read();
        if (!text) return;
        e.preventDefault();
        const dirty = this.#runner.pasteText(text);
        this.#syncCursor();
        if (dirty) {
          this.requestRedraw();
        }
      },
      {signal},
    );
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#rafId !== 0) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = 0;
    }
    this.#abortController.abort();
    this.#resizeObserver?.disconnect();
    this.#runner?.dispose();
    this.#presenter.dispose();
  }
}
