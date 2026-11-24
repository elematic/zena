/**
 * End-to-end tests for the ZenaFX web runner.
 *
 * Runs in Node.js v26 against:
 *   - the REAL wasm32 `zenafx_web_engine.wasm` (Taffy + Parley + Vello CPU + Scene)
 *   - a real TTF font registered via `RenderEngine.registerFont`
 *   - ALL FOUR unmodified ZenaFX `.wasm` components (`widgets.wasm`, `button.wasm`,
 *     `counter.wasm`, `scroll.wasm`) compiled by `zena build --target component`
 *
 * Mirrors the native assertions in `packages/zenafx/tests/{app,button,counter,scroll}.rs`.
 */

import {suite, test, before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execSync} from 'node:child_process';

import {
  RenderEngineModule,
  ZenaFxComponentRunner,
  ZenaFxCanvasSurface,
} from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '../..');

const engineWasmPath = path.join(pkgRoot, 'out/zenafx_web_engine.wasm');
const examplePath = (name) =>
  path.join(repoRoot, `packages/zenafx/out/${name}.wasm`);

const OPEN_SANS_FONT = path.join(
  repoRoot,
  'node_modules/@radica/base/fonts/Open Sans/Open_Sans/OpenSans-VariableFont_wdth,wght.ttf',
);

const findTestFont = () => {
  if (
    process.env.ZENAFX_WEB_FONT &&
    fs.existsSync(process.env.ZENAFX_WEB_FONT)
  ) {
    return process.env.ZENAFX_WEB_FONT;
  }
  if (fs.existsSync(OPEN_SANS_FONT)) {
    return OPEN_SANS_FONT;
  }
  try {
    const out = execSync('fc-match -f "%{file}" sans-serif', {
      encoding: 'utf8',
    }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    // fall through
  }
  for (const candidate of [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/Library/Fonts/Arial.ttf',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Could not locate a TTF font for Parley; set ZENAFX_WEB_FONT',
  );
};

let engineModule;
let fontBytes;

before(async () => {
  assert.ok(
    fs.existsSync(engineWasmPath),
    `Missing ${engineWasmPath}; build packages/zenafx-web/engine first`,
  );
  engineModule = await RenderEngineModule.compile(
    fs.readFileSync(engineWasmPath),
  );
  fontBytes = new Uint8Array(fs.readFileSync(findTestFont()));
});

const createEngine = async () => {
  const engine = await engineModule.instantiate();
  const faces = engine.registerFont(fontBytes);
  assert.ok(faces > 0, `expected registered font faces, got ${faces}`);
  return engine;
};

const loadComponent = async (name, opts = {}) => {
  const engine = await createEngine();
  const runner = new ZenaFxComponentRunner(engine, opts);
  const wasmPath = examplePath(name);
  assert.ok(fs.existsSync(wasmPath), `Missing ${wasmPath}`);
  await runner.load(fs.readFileSync(wasmPath));
  return {engine, runner};
};

const countDarkPixels = (rgba) => {
  let dark = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] < 100 && rgba[i + 1] < 100 && rgba[i + 2] < 100) {
      dark += 1;
    }
  }
  return dark;
};

suite('zenafx-web: built-in hello demo (wasm32 engine)', () => {
  test('renders card and rasterizes dark text pixels via Vello CPU inside Wasm', async () => {
    const engine = await createEngine();
    try {
      engine.loadHelloDemo('Hello, web!');
      const res = engine.drawFrame(800, 600);
      assert.equal(res.width, 800);
      assert.equal(res.height, 600);
      assert.equal(res.commandCount, 2, 'card quad + text glyph run');

      const info = engine.inspectFrame();
      const card = info.commands.find((c) => c.type === 'quad');
      const glyphs = info.commands.find((c) => c.type === 'glyphs');
      assert.ok(card && glyphs);
      assert.equal(glyphs.text, 'Hello, web!');
      assert.ok(Math.abs(card.x + card.w / 2 - 400) < 1.5, 'card centered x');
      assert.ok(Math.abs(card.y + card.h / 2 - 300) < 1.5, 'card centered y');

      const rgba = engine.rgbaPixels();
      assert.equal(rgba.length, 800 * 600 * 4);
      // Corner is white background
      assert.equal(rgba[0], 255);
      assert.equal(rgba[1], 255);
      assert.equal(rgba[2], 255);
      assert.equal(rgba[3], 255);
      // Text pixels rendered by Parley + Vello CPU inside Wasm!
      const dark = countDarkPixels(rgba);
      assert.ok(dark > 100, `expected > 100 dark glyph pixels, got ${dark}`);
    } finally {
      engine.dispose();
    }
  });
});

suite('zenafx-web: widgets.wasm component', () => {
  test('renders 3 cards, 7 quads, 7 glyph runs and resizes without re-entering guest', async () => {
    const {engine, runner} = await loadComponent('widgets');
    try {
      assert.equal(runner.guestEntries, 1);
      runner.frame(800, 600);
      const wideInfo = engine.inspectFrame();
      const quads = wideInfo.commands.filter((c) => c.type === 'quad');
      const glyphs = wideInfo.commands.filter((c) => c.type === 'glyphs');
      assert.equal(quads.length, 7, 'page + 3 cards + 3 wells');
      assert.equal(glyphs.length, 7, '3 card titles + 4 slot labels');
      assert.equal(glyphs[0].text, 'First card');
      assert.equal(glyphs[1].text, 'Second card');
      assert.equal(glyphs[2].text, 'Third card');
      assert.ok(countDarkPixels(engine.rgbaPixels()) > 100);

      // Resize four times — guest must never be re-entered, and layout must re-solve.
      const wideHeight = quads[3].y + quads[3].h - quads[1].y;
      for (const [w, h] of [
        [400, 1000],
        [1200, 300],
        [800, 600],
        [360, 1000],
      ]) {
        runner.frame(w, h);
      }
      assert.equal(
        runner.guestEntries,
        1,
        'resizing must never re-enter the component',
      );
      const narrowQuads = engine
        .inspectFrame()
        .commands.filter((c) => c.type === 'quad');
      const narrowHeight =
        narrowQuads[3].y + narrowQuads[3].h - narrowQuads[1].y;
      assert.ok(
        narrowHeight > wideHeight,
        `narrow viewport should wrap text (${narrowHeight} > ${wideHeight})`,
      );
    } finally {
      runner.dispose();
      engine.dispose();
    }
  });
});

suite(
  'zenafx-web: button.wasm component (pointer events + state styles)',
  () => {
    const approxColor = (actual, expected) =>
      actual && expected.every((v, i) => Math.abs(actual[i] - v) < 0.01);

    const RESTING = [0.2, 0.38, 0.86, 1.0];
    const HOVERED = [0.31, 0.49, 0.95, 1.0];
    const PRESSED = [0.13, 0.27, 0.66, 1.0];

    test('hover/press restyles without waking component; click increments & stops propagation', async () => {
      let wakes = 0;
      const {engine, runner} = await loadComponent('button', {
        onWake: () => {
          wakes += 1;
        },
      });
      try {
        runner.frame(800, 600);
        const first = engine.inspectFrame();
        const buttonQuad = first.commands.filter((c) => c.type === 'quad')[1];
        const countGlyph = first.commands.find((c) => c.type === 'glyphs');
        assert.equal(countGlyph.text, '0');
        assert.ok(approxColor(buttonQuad.bg, RESTING));

        const bx = buttonQuad.x + buttonQuad.w / 2;
        const by = buttonQuad.y + buttonQuad.h / 2;

        // Hover over button: host restyles with zero events delivered to guest.
        assert.equal(runner.pointer({type: 'moved', x: bx, y: by}), true);
        runner.frame(800, 600);
        assert.ok(
          approxColor(
            engine.inspectFrame().commands.filter((c) => c.type === 'quad')[1]
              .bg,
            HOVERED,
          ),
        );
        assert.equal(
          runner.eventsDelivered,
          0,
          'hovering must not wake component',
        );

        // Press twice on the button: count becomes "2", same run id (patched in place),
        // and button stops propagation before the page's reset listener.
        const wakesBefore = wakes;
        runner.pointer({type: 'button', x: bx, y: by, button: 0, down: true});
        await runner.waitForDeliveries();
        runner.frame(800, 600);
        assert.ok(
          approxColor(
            engine.inspectFrame().commands.filter((c) => c.type === 'quad')[1]
              .bg,
            PRESSED,
          ),
        );
        runner.pointer({type: 'button', x: bx, y: by, button: 0, down: false});
        await runner.waitForDeliveries();

        runner.pointer({type: 'button', x: bx, y: by, button: 0, down: true});
        await runner.waitForDeliveries();
        runner.frame(800, 600);
        const afterTwo = engine
          .inspectFrame()
          .commands.find((c) => c.type === 'glyphs');
        assert.equal(afterTwo.text, '2');
        assert.equal(
          afterTwo.run,
          countGlyph.run,
          'count text node should be patched in place, not rebuilt',
        );
        assert.equal(
          runner.eventsDelivered,
          2,
          'button stopped propagation so page never heard button presses',
        );
        assert.ok(wakes > wakesBefore, 'handler mutation woke surface');

        // Click outside button on page: resets count back to "0".
        runner.pointer({type: 'button', x: 5, y: 5, button: 0, down: true});
        await runner.waitForDeliveries();
        runner.frame(800, 600);
        assert.equal(
          engine.inspectFrame().commands.find((c) => c.type === 'glyphs').text,
          '0',
        );
        assert.equal(runner.guestEntries, 1);
      } finally {
        runner.dispose();
        engine.dispose();
      }
    });
  },
);

suite(
  'zenafx-web: scroll.wasm component (clipping + wheel + hit testing)',
  () => {
    test('scrolls without waking component or re-solving layout, and clicks scrolled row', async () => {
      const {engine, runner} = await loadComponent('scroll');
      try {
        runner.frame(800, 600);
        const first = engine.inspectFrame();
        const clip = first.commands.find((c) => c.type === 'pushClip');
        assert.ok(clip, 'scrolling list must emit a clip');
        assert.equal(clip.w, 278);
        assert.equal(clip.h, 238);

        const glyphsOf = (info) =>
          info.commands.filter((c) => c.type === 'glyphs');
        const rowsOf = (info) =>
          glyphsOf(info)
            .filter((g) => g.text.startsWith('Row '))
            .map((g) => Number(g.text.slice(4)));

        const initialRows = rowsOf(first);
        assert.equal(initialRows[0], 1);
        assert.ok(initialRows.length > 3 && initialRows.length < 20);
        const solvesBefore = engine.solves();

        // Wheel down inside the list box.
        const moved = runner.pointer({
          type: 'wheel',
          x: clip.x + clip.w / 2,
          y: clip.y + clip.h / 2,
          dx: 0,
          dy: 330,
        });
        assert.equal(moved, true);
        runner.frame(800, 600);

        const scrolled = engine.inspectFrame();
        const scrolledRows = rowsOf(scrolled);
        assert.ok(
          scrolledRows[0] > 1,
          `list should have scrolled: ${scrolledRows}`,
        );
        assert.equal(
          runner.eventsDelivered,
          0,
          'scrolling must not wake component',
        );
        assert.equal(
          engine.solves(),
          solvesBefore,
          'scrolling must not trigger a Taffy layout re-solve',
        );

        // Click the 3rd visible row after scrolling.
        const targetRow = glyphsOf(scrolled).filter((g) =>
          g.text.startsWith('Row '),
        )[2];
        const expectedNum = targetRow.text.slice(4);
        runner.pointer({
          type: 'button',
          x: targetRow.x + 4,
          y: targetRow.y + 4,
          button: 0,
          down: true,
        });
        await runner.waitForDeliveries();
        runner.frame(800, 600);

        const chosen = glyphsOf(engine.inspectFrame()).find(
          (g) => !g.text.startsWith('Row '),
        );
        assert.equal(chosen.text, `Chose row ${expectedNum}`);
      } finally {
        runner.dispose();
        engine.dispose();
      }
    });
  },
);

suite('zenafx-web: counter.wasm component (wasi:clocks timers)', () => {
  test('renders both dials and advances fast counter via monotonic-clock wait-for', async () => {
    const {engine, runner} = await loadComponent('counter');
    try {
      runner.frame(800, 600);
      const first = engine.inspectFrame();
      const quads = first.commands.filter((c) => c.type === 'quad');
      const glyphs = first.commands.filter((c) => c.type === 'glyphs');
      assert.equal(quads.length, 3, 'page + 2 dials');
      assert.equal(glyphs.length, 4, '2 labels + 2 digit runs');

      const fastDigitBefore = glyphs.find((g) => g.text === '0');
      assert.ok(fastDigitBefore);

      // Wait just over one 500ms period so the fast counter ticks via `wasi:clocks`.
      await new Promise((r) => setTimeout(r, 650));
      runner.frame(800, 600);
      const afterGlyphs = engine
        .inspectFrame()
        .commands.filter((c) => c.type === 'glyphs');
      const updatedFast = afterGlyphs.find(
        (g) => g.run === fastDigitBefore.run,
      );
      assert.ok(updatedFast, 'digit run should keep the same run id');
      assert.ok(
        Number(updatedFast.text) >= 1,
        `expected fast counter to advance >= 1, got '${updatedFast.text}'`,
      );
      assert.equal(runner.guestEntries, 1);
    } finally {
      runner.dispose();
      engine.dispose();
    }
  });
});

suite(
  'zenafx-web: split.wasm component (pointer capture + divider drag)',
  () => {
    test('dragging the divider captures pointer, keeps col-resize cursor, and resizes left panel', async () => {
      const {engine, runner} = await loadComponent('split');
      try {
        runner.frame(800, 600);
        const quadsBefore = engine
          .inspectFrame()
          .commands.filter((c) => c.type === 'quad');
        // Divider is the narrow vertical bar between left and right panels.
        const divider = quadsBefore.find(
          (q) => q.w > 0 && q.w < 20 && q.h > 200,
        );
        assert.ok(divider, 'expected divider quad');
        const leftPanelBefore = quadsBefore.find(
          (q) => q.x < divider.x && q.w > 50 && q.h > 200,
        );
        assert.ok(leftPanelBefore, 'expected left panel quad');

        const dx = divider.x + divider.w / 2;
        const dy = divider.y + divider.h / 2;

        runner.pointer({type: 'moved', x: dx, y: dy});
        assert.equal(engine.cursor(), 'col-resize');

        // Press on divider to capture, then drag right by 100px.
        runner.pointer({type: 'button', x: dx, y: dy, button: 0, down: true});
        await runner.waitForDeliveries();
        runner.pointer({type: 'moved', x: dx + 100, y: dy});
        await runner.waitForDeliveries();
        assert.equal(
          engine.cursor(),
          'col-resize',
          'captured drag keeps col-resize cursor',
        );
        runner.frame(800, 600);

        const quadsAfter = engine
          .inspectFrame()
          .commands.filter((c) => c.type === 'quad');
        const dividerAfter = quadsAfter.find(
          (q) => q.w > 0 && q.w < 20 && q.h > 200,
        );
        assert.ok(
          dividerAfter.x > divider.x + 50,
          `divider should have moved right (${divider.x} -> ${dividerAfter.x})`,
        );

        // Release pointer capture.
        runner.pointer({
          type: 'button',
          x: dx + 100,
          y: dy,
          button: 0,
          down: false,
        });
        await runner.waitForDeliveries();
        assert.equal(runner.guestEntries, 1);
      } finally {
        runner.dispose();
        engine.dispose();
      }
    });
  },
);

suite('zenafx-web: cursors.wasm component (CSS cursor tiles)', () => {
  test('reports each tile CSS cursor on hover without waking the component', async () => {
    const {engine, runner} = await loadComponent('cursors');
    try {
      runner.frame(800, 600);
      const glyphs = engine
        .inspectFrame()
        .commands.filter((c) => c.type === 'glyphs');
      assert.ok(
        glyphs.length >= 30,
        `expected cursor tiles, got ${glyphs.length}`,
      );

      for (const expected of [
        'pointer',
        'text',
        'grab',
        'col-resize',
        'zoom-in',
      ]) {
        const label = glyphs.find((g) => g.text === expected);
        assert.ok(label, `expected tile labeled '${expected}'`);
        runner.pointer({type: 'moved', x: label.x + 4, y: label.y + 4});
        assert.equal(engine.cursor(), expected);
      }
      assert.equal(
        runner.eventsDelivered,
        0,
        'hovering cursor tiles wakes no component',
      );
      assert.equal(runner.guestEntries, 1);
    } finally {
      runner.dispose();
      engine.dispose();
    }
  });
});

suite(
  'zenafx-web: disclosure.wasm component (keyboard focus + Tab + Enter)',
  () => {
    test('Tab moves focus and Enter toggles the disclosure body', async () => {
      const {engine, runner} = await loadComponent('disclosure');
      try {
        runner.frame(800, 600);
        const countGlyphs = () =>
          engine.inspectFrame().commands.filter((c) => c.type === 'glyphs')
            .length;
        const before = countGlyphs();

        // Tab focuses the first summary.
        runner.key({
          down: true,
          key: 'Tab',
          code: 'Tab',
          modifiers: {shift: false, control: false, alt: false, meta: false},
          repeat: false,
          text: null,
        });
        await runner.waitForDeliveries();
        runner.frame(800, 600);

        // Enter toggles it open -> more text runs appear.
        runner.key({
          down: true,
          key: 'Enter',
          code: 'Enter',
          modifiers: {shift: false, control: false, alt: false, meta: false},
          repeat: false,
          text: null,
        });
        await runner.waitForDeliveries();
        runner.frame(800, 600);
        const afterOpen = countGlyphs();
        assert.ok(
          afterOpen > before,
          `expected disclosure body to appear (${before} -> ${afterOpen})`,
        );
        assert.equal(runner.guestEntries, 1);
      } finally {
        runner.dispose();
        engine.dispose();
      }
    });
  },
);

suite(
  'zenafx-web: input.wasm component (text fields + caret + editing)',
  () => {
    test('Tab focuses text field and typing inserts characters', async () => {
      const {engine, runner} = await loadComponent('input');
      try {
        runner.frame(800, 600);
        // Tab into the first text field.
        runner.key({
          down: true,
          key: 'Tab',
          code: 'Tab',
          modifiers: {shift: false, control: false, alt: false, meta: false},
          repeat: false,
          text: null,
        });
        await runner.waitForDeliveries();
        runner.frame(800, 600);

        // Type "Hi!"
        for (const ch of ['H', 'i', '!']) {
          runner.key({
            down: true,
            key: ch,
            code: `Key${ch.toUpperCase()}`,
            modifiers: {shift: false, control: false, alt: false, meta: false},
            repeat: false,
            text: ch,
          });
          await runner.waitForDeliveries();
        }
        runner.frame(800, 600);
        const texts = engine
          .inspectFrame()
          .commands.filter((c) => c.type === 'glyphs')
          .map((g) => g.text);
        assert.ok(
          texts.some((t) => t.includes('Hi!')),
          `expected typed text 'Hi!' in ${JSON.stringify(texts)}`,
        );
        assert.equal(runner.guestEntries, 1);
      } finally {
        runner.dispose();
        engine.dispose();
      }
    });
  },
);

suite(
  'zenafx-web: selection.wasm component (select all + copy + paste)',
  () => {
    test('Ctrl+A selects page text, Ctrl+C copies, Tab + Ctrl+V pastes into text field', async () => {
      const {engine, runner} = await loadComponent('selection');
      try {
        runner.frame(800, 600);
        const ctrl = {shift: false, control: true, alt: false, meta: false};

        // Select all window text and copy to clipboard.
        runner.key({
          down: true,
          key: 'a',
          code: 'KeyA',
          modifiers: ctrl,
          repeat: false,
          text: null,
        });
        await runner.waitForDeliveries();
        runner.key({
          down: true,
          key: 'c',
          code: 'KeyC',
          modifiers: ctrl,
          repeat: false,
          text: null,
        });
        await runner.waitForDeliveries();

        const copied = runner.clipboard.read();
        assert.ok(
          copied && copied.length > 10,
          `expected copied page text, got ${JSON.stringify(copied)}`,
        );

        // Tab to the text field and paste.
        runner.key({
          down: true,
          key: 'Tab',
          code: 'Tab',
          modifiers: {shift: false, control: false, alt: false, meta: false},
          repeat: false,
          text: null,
        });
        await runner.waitForDeliveries();
        runner.frame(800, 600);

        runner.key({
          down: true,
          key: 'v',
          code: 'KeyV',
          modifiers: ctrl,
          repeat: false,
          text: null,
        });
        await runner.waitForDeliveries();
        runner.frame(800, 600);

        const texts = engine
          .inspectFrame()
          .commands.filter((c) => c.type === 'glyphs')
          .map((g) => g.text);
        const firstLine = copied.split('\n')[0];
        assert.ok(
          texts.filter((t) => t.includes(firstLine)).length >= 2,
          `expected pasted text in field alongside original page text`,
        );
        assert.equal(runner.guestEntries, 1);
      } finally {
        runner.dispose();
        engine.dispose();
      }
    });
  },
);

suite('zenafx-web: ZenaFxCanvasSurface (demand-driven rAF + Canvas2D)', () => {
  test('presents pixels on Canvas2D, coalesces rAF, and translates pointer events with DPR', async () => {
    // Minimal DOM shims for running ZenaFxCanvasSurface in Node.
    const listeners = new Map();
    let presented = 0;
    let lastImageData = null;
    const mockCanvas = {
      width: 0,
      height: 0,
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        width: 400,
        height: 300,
      }),
      getContext: (kind) => {
        if (kind !== '2d') return null;
        return {
          createImageData: (w, h) => ({
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
          }),
          putImageData: (img) => {
            presented += 1;
            lastImageData = img;
          },
        };
      },
      addEventListener: (type, fn) => {
        listeners.set(type, fn);
      },
    };

    const rafQueue = [];
    const prevWindow = globalThis.window;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevCancelRaf = globalThis.cancelAnimationFrame;

    globalThis.window = {devicePixelRatio: 2};
    globalThis.requestAnimationFrame = (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    globalThis.cancelAnimationFrame = () => {};

    const flushRaf = () => {
      const batch = rafQueue.splice(0);
      for (const cb of batch) cb(performance.now());
    };

    const engine = await createEngine();
    const frameStats = [];
    let surface;
    try {
      surface = await ZenaFxCanvasSurface.create(mockCanvas, engine, {
        backend: 'canvas2d',
        onFrame: (s) => frameStats.push(s),
      });
      await surface.loadComponent(fs.readFileSync(examplePath('button')));
      assert.equal(rafQueue.length, 1, 'multiple wakes coalesce into one rAF');
      flushRaf();

      assert.equal(presented, 1);
      assert.equal(mockCanvas.width, 800, '400px CSS * 2 DPR');
      assert.equal(mockCanvas.height, 600, '300px CSS * 2 DPR');
      assert.ok(countDarkPixels(lastImageData.data) > 50);
      assert.equal(
        rafQueue.length,
        0,
        'idle surface schedules no extra frames',
      );

      // Click on the button in CSS coordinates (offset by canvas left/top, / DPR).
      const btn = engine
        .inspectFrame()
        .commands.filter((c) => c.type === 'quad')[1];
      const cssX = 10 + (btn.x + btn.w / 2) / 2;
      const cssY = 20 + (btn.y + btn.h / 2) / 2;
      listeners.get('pointerdown')({clientX: cssX, clientY: cssY, button: 0});
      await surface.runner.waitForDeliveries();
      assert.equal(
        rafQueue.length,
        1,
        'button click wakes surface for one frame',
      );
      flushRaf();

      assert.equal(
        engine.inspectFrame().commands.find((c) => c.type === 'glyphs').text,
        '1',
      );
      assert.equal(frameStats.at(-1).guestEntries, 1);
      assert.equal(frameStats.at(-1).backend, 'canvas2d');
    } finally {
      surface?.dispose();
      engine.dispose();
      globalThis.window = prevWindow;
      globalThis.requestAnimationFrame = prevRaf;
      globalThis.cancelAnimationFrame = prevCancelRaf;
    }
  });

  test('presents on WebGPU with a fresh canvas and falls back when canvas is locked to 2d', async () => {
    const createSpecCanvas = () => {
      let lockedContext = null;
      const webgpuCalls = {configured: 0, unconfigured: 0};
      const canvas = {
        width: 0,
        height: 0,
        webgpuCalls,
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          width: 400,
          height: 300,
        }),
        getContext: (kind) => {
          if (lockedContext && lockedContext !== kind) return null;
          lockedContext = kind;
          if (kind === '2d') {
            return {
              createImageData: (w, h) => ({
                width: w,
                height: h,
                data: new Uint8ClampedArray(w * h * 4),
              }),
              putImageData: () => {},
            };
          }
          if (kind === 'webgpu') {
            return {
              configure: () => {
                webgpuCalls.configured += 1;
              },
              unconfigure: () => {
                webgpuCalls.unconfigured += 1;
              },
              getCurrentTexture: () => ({createView: () => ({})}),
            };
          }
          return null;
        },
        addEventListener: () => {},
      };
      return canvas;
    };

    const gpuStats = {writes: 0, draws: 0, submits: 0, destroyed: 0};
    const mockDevice = {
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({getBindGroupLayout: () => ({})}),
      createSampler: () => ({}),
      createTexture: () => ({
        createView: () => ({}),
        destroy: () => {},
      }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => {},
          setBindGroup: () => {},
          draw: (verts) => {
            assert.equal(verts, 3);
            gpuStats.draws += 1;
          },
          end: () => {},
        }),
        finish: () => ({}),
      }),
      queue: {
        writeTexture: (_dest, data) => {
          assert.ok(data.byteLength > 0);
          gpuStats.writes += 1;
        },
        submit: () => {
          gpuStats.submits += 1;
        },
      },
      destroy: () => {
        gpuStats.destroyed += 1;
      },
    };

    const rafQueue = [];
    const prevWindow = globalThis.window;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevCancelRaf = globalThis.cancelAnimationFrame;
    const prevGpuUsage = globalThis.GPUTextureUsage;
    const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

    globalThis.window = {devicePixelRatio: 1};
    globalThis.requestAnimationFrame = (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    globalThis.cancelAnimationFrame = () => {};
    globalThis.GPUTextureUsage = {TEXTURE_BINDING: 0x04, COPY_DST: 0x02};
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        gpu: {
          requestAdapter: async () => ({
            requestDevice: async () => mockDevice,
          }),
          getPreferredCanvasFormat: () => 'bgra8unorm',
        },
      },
    });

    const flushRaf = () => {
      const batch = rafQueue.splice(0);
      for (const cb of batch) cb(performance.now());
    };

    const engine = await createEngine();
    let surface2d;
    let surfaceFallback;
    let surfaceWebGpu;
    try {
      // 1. A canvas locked to 2D cannot switch to WebGPU in place (HTML Canvas spec).
      const lockedCanvas = createSpecCanvas();
      surface2d = await ZenaFxCanvasSurface.create(lockedCanvas, engine, {
        backend: 'canvas2d',
      });
      assert.equal(surface2d.backend, 'canvas2d');
      surface2d.dispose();

      surfaceFallback = await ZenaFxCanvasSurface.create(lockedCanvas, engine, {
        backend: 'webgpu',
      });
      assert.equal(
        surfaceFallback.backend,
        'canvas2d',
        'reusing a 2D-locked canvas falls back to canvas2d',
      );
      surfaceFallback.dispose();

      // 2. A fresh canvas acquires WebGPU cleanly and reports backend === 'webgpu'.
      const freshCanvas = createSpecCanvas();
      const frameStats = [];
      surfaceWebGpu = await ZenaFxCanvasSurface.create(freshCanvas, engine, {
        backend: 'webgpu',
        onFrame: (s) => frameStats.push(s),
      });
      assert.equal(surfaceWebGpu.backend, 'webgpu');
      assert.equal(freshCanvas.webgpuCalls.configured, 1);

      surfaceWebGpu.loadHelloDemo('WebGPU frame');
      flushRaf();

      assert.equal(gpuStats.writes, 1);
      assert.equal(gpuStats.draws, 1);
      assert.equal(gpuStats.submits, 1);
      assert.equal(frameStats.at(-1).backend, 'webgpu');

      surfaceWebGpu.dispose();
      assert.equal(freshCanvas.webgpuCalls.unconfigured, 1);
      assert.ok(gpuStats.destroyed >= 1);
    } finally {
      surface2d?.dispose();
      surfaceFallback?.dispose();
      surfaceWebGpu?.dispose();
      engine.dispose();
      globalThis.window = prevWindow;
      globalThis.requestAnimationFrame = prevRaf;
      globalThis.cancelAnimationFrame = prevCancelRaf;
      globalThis.GPUTextureUsage = prevGpuUsage;
      if (navDesc) {
        Object.defineProperty(globalThis, 'navigator', navDesc);
      } else {
        delete globalThis.navigator;
      }
    }
  });
});
