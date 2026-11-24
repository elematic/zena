import {
  RenderEngineModule,
  ZenaFxCanvasSurface,
} from '../../../zenafx-web/src/index.js';

let canvas = /** @type {HTMLCanvasElement} */ (
  document.getElementById('zenafx-canvas')
);
const statusEl = document.getElementById('zenafx-status');
const demoButtons = document.getElementById('zenafx-demo-buttons');
const fileInput = /** @type {HTMLInputElement} */ (
  document.getElementById('zenafx-file-input')
);
const backendSelect = /** @type {HTMLSelectElement} */ (
  document.getElementById('zenafx-backend-select')
);

const statEls = {
  demo: document.getElementById('zenafx-stat-demo'),
  frames: document.getElementById('zenafx-stat-frames'),
  solves: document.getElementById('zenafx-stat-solves'),
  entries: document.getElementById('zenafx-stat-entries'),
  events: document.getElementById('zenafx-stat-events'),
  ms: document.getElementById('zenafx-stat-ms'),
  backend: document.getElementById('zenafx-stat-backend'),
  engineSize: document.getElementById('zenafx-stat-engine-size'),
  compSize: document.getElementById('zenafx-stat-comp-size'),
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

const ASSET_BASE = '/demos/zenafx';
const DEMO_URLS = {
  button: `${ASSET_BASE}/examples/button.wasm`,
  widgets: `${ASSET_BASE}/examples/widgets.wasm`,
  counter: `${ASSET_BASE}/examples/counter.wasm`,
  scroll: `${ASSET_BASE}/examples/scroll.wasm`,
  split: `${ASSET_BASE}/examples/split.wasm`,
  cursors: `${ASSET_BASE}/examples/cursors.wasm`,
  disclosure: `${ASSET_BASE}/examples/disclosure.wasm`,
  input: `${ASSET_BASE}/examples/input.wasm`,
  selection: `${ASSET_BASE}/examples/selection.wasm`,
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
    fetch(`${ASSET_BASE}/zenafx_web_engine.wasm`),
    fetch(`${ASSET_BASE}/font.ttf`),
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
