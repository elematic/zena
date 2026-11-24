import {RenderEngineModule, ZenaFxCanvasSurface} from '../src/index.js';

let canvas = /** @type {HTMLCanvasElement} */ (
  document.getElementById('zenafx-canvas')
);
const statusEl = document.getElementById('status');
const demoButtons = document.getElementById('demo-buttons');
const fileInput = /** @type {HTMLInputElement} */ (
  document.getElementById('file-input')
);
const backendSelect = /** @type {HTMLSelectElement} */ (
  document.getElementById('backend-select')
);

/**
 * Replace the `<canvas>` DOM node with a fresh element so switching between
 * `'canvas2d'` and `'webgpu'` is not blocked by HTML Canvas context locking.
 */
const replaceCanvas = () => {
  const fresh = document.createElement('canvas');
  fresh.id = 'zenafx-canvas';
  canvas.replaceWith(fresh);
  canvas = fresh;
  return fresh;
};

const statEls = {
  demo: document.getElementById('stat-demo'),
  frames: document.getElementById('stat-frames'),
  solves: document.getElementById('stat-solves'),
  entries: document.getElementById('stat-entries'),
  events: document.getElementById('stat-events'),
  ms: document.getElementById('stat-ms'),
  backend: document.getElementById('stat-backend'),
  engineSize: document.getElementById('stat-engine-size'),
  compSize: document.getElementById('stat-comp-size'),
};

const formatKb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

const setStatus = (msg) => {
  if (!msg) {
    statusEl.classList.add('hidden');
  } else {
    statusEl.textContent = msg;
    statusEl.classList.remove('hidden');
  }
};

const DEMO_URLS = {
  button: '/packages/zenafx/out/button.wasm',
  widgets: '/packages/zenafx/out/widgets.wasm',
  counter: '/packages/zenafx/out/counter.wasm',
  scroll: '/packages/zenafx/out/scroll.wasm',
  split: '/packages/zenafx/out/split.wasm',
  cursors: '/packages/zenafx/out/cursors.wasm',
  disclosure: '/packages/zenafx/out/disclosure.wasm',
  input: '/packages/zenafx/out/input.wasm',
  selection: '/packages/zenafx/out/selection.wasm',
};

let engineModule = null;
let fontBytes = null;
let surface = null;
let engine = null;
let currentDemo = 'button';
let customBytes = null;
let customName = null;
let mountSeq = 0;

const boot = async () => {
  if (!navigator.gpu) {
    const opt = backendSelect.querySelector('option[value="webgpu"]');
    if (opt) opt.textContent = 'WebGPU (unavailable)';
  }

  setStatus('Loading zenafx_web_engine.wasm + font…');
  const [engineRes, fontRes] = await Promise.all([
    fetch('/packages/zenafx-web/out/zenafx_web_engine.wasm'),
    fetch('/packages/zenafx-web/demo/font.ttf'),
  ]);
  if (!engineRes.ok) {
    throw new Error(
      `Failed to fetch zenafx_web_engine.wasm (${engineRes.status})`,
    );
  }
  if (!fontRes.ok) {
    throw new Error(`Failed to fetch font.ttf (${fontRes.status})`);
  }

  const [engineBuf, fontBuf] = await Promise.all([
    engineRes.arrayBuffer(),
    fontRes.arrayBuffer(),
  ]);
  statEls.engineSize.textContent = formatKb(engineBuf.byteLength);

  engineModule = await RenderEngineModule.compile(engineBuf);
  fontBytes = new Uint8Array(fontBuf);

  await mountDemo(currentDemo);
};

const mountDemo = async (name, overrideBytes = null) => {
  const seq = ++mountSeq;
  setStatus(`Loading ${name}…`);
  surface?.dispose();
  surface = null;
  engine?.dispose();
  engine = null;

  const targetCanvas = replaceCanvas();
  const nextEngine = await engineModule.instantiate();
  if (seq !== mountSeq) {
    nextEngine.dispose();
    return;
  }
  nextEngine.registerFont(fontBytes);

  const nextSurface = await ZenaFxCanvasSurface.create(
    targetCanvas,
    nextEngine,
    {
      backend: /** @type {'canvas2d' | 'webgpu'} */ (backendSelect.value),
      onFrame: (stats) => {
        statEls.frames.textContent = String(stats.frames);
        statEls.solves.textContent = String(stats.solves);
        statEls.entries.textContent = String(stats.guestEntries);
        statEls.events.textContent = String(stats.eventsDelivered);
        statEls.ms.textContent = `${stats.frameTimeMs.toFixed(1)} ms`;
        statEls.backend.textContent = stats.backend;
      },
    },
  );
  if (seq !== mountSeq) {
    nextSurface.dispose();
    nextEngine.dispose();
    return;
  }

  engine = nextEngine;
  surface = nextSurface;
  backendSelect.value = surface.backend;
  statEls.backend.textContent = surface.backend;
  statEls.demo.textContent = name;

  if (name === 'hello') {
    statEls.compSize.textContent = 'built-in';
    surface.loadHelloDemo('Hello from ZenaFX on the Web!');
    setStatus(null);
    return;
  }

  let bytes = overrideBytes;
  if (!bytes) {
    const url = DEMO_URLS[name];
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url} (${res.status})`);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (seq !== mountSeq) return;

  statEls.compSize.textContent = formatKb(bytes.byteLength);
  await surface.loadComponent(bytes);
  if (seq !== mountSeq) return;
  setStatus(null);
};

demoButtons.addEventListener('click', (e) => {
  const btn = /** @type {HTMLElement} */ (e.target).closest(
    'button[data-demo]',
  );
  if (!btn) return;
  for (const b of demoButtons.querySelectorAll('button')) {
    b.classList.toggle('active', b === btn);
  }
  currentDemo = btn.dataset.demo;
  customBytes = null;
  customName = null;
  mountDemo(currentDemo).catch((err) => setStatus(`Error: ${err.message}`));
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  for (const b of demoButtons.querySelectorAll('button')) {
    b.classList.remove('active');
  }
  customBytes = new Uint8Array(await file.arrayBuffer());
  customName = file.name;
  mountDemo(customName, customBytes).catch((err) =>
    setStatus(`Error: ${err.message}`),
  );
});

backendSelect.addEventListener('change', () => {
  if (customBytes) {
    mountDemo(customName, customBytes).catch((err) =>
      setStatus(`Error: ${err.message}`),
    );
  } else {
    mountDemo(currentDemo).catch((err) => setStatus(`Error: ${err.message}`));
  }
});

boot().catch((err) => {
  console.error(err);
  setStatus(`Failed to start: ${err.message}`);
});
