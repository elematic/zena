/**
 * Ecosystem projects featured on `/projects/`.
 *
 * Keep `slug` and `link` aligned with the micro-site prefixes in
 * `src/_data/sidebar.js`.
 */
export default [
  {
    slug: 'zebra',
    title: 'Zebra',
    link: '/projects/zebra/',
    status: 'In progress',
    statusType: 'warning',
    tagline:
      'Build and run tool inspired by Wireit, with planned Wasm build rules',
    summary:
      'Native task graph, content-addressed cache, and dev service runner iterating on Wireit with faster startup, plus planned Wasm build-rule components, incremental and resident steps, and Blaze-style graph queries.',
    stack: ['Zena', 'WASI', 'Wasmtime'],
  },
  {
    slug: 'package-manager',
    title: 'Package Manager',
    link: '/projects/package-manager/',
    status: 'In progress',
    statusType: 'warning',
    tagline:
      'AT Protocol package manager and registry, extensible with Wasm plugins',
    summary:
      'Manages AT Protocol accounts for packages, scopes, teams, and organizations, delegated publishing permissions, and the registry App View—with language-specific config parsing, README extraction, and static analysis designed for Wasm plugins.',
    stack: ['Zena', 'AT Protocol', 'Wasm'],
  },
  {
    slug: 'zenafx',
    title: 'ZenaFX',
    link: '/projects/zenafx/',
    status: 'Prototype',
    statusType: 'warning',
    tagline: 'Capability-isolated graphical runtime for WebAssembly components',
    summary:
      'Multiple isolated Wasm components contribute to a shared retained scene graph. A Rust host handles windowing, text shaping, and GPU compositing while layout, styling, and scene management live in Zena.',
    stack: ['Rust', 'Zena', 'WIT'],
  },
  {
    slug: 'pds',
    title: 'AT Protocol PDS',
    link: '/projects/pds/',
    status: 'In progress',
    statusType: 'warning',
    tagline: 'Extendable, multi-tenant AT Protocol Personal Data Server',
    summary:
      'Multi-tenant PDS designed for systems that customize account creation, permission delegation, and allowed content—including accounts that represent packages, documents, organizations, and other objects.',
    stack: ['Zena', 'AT Protocol', 'Wasm'],
  },
  {
    slug: 'wasm-web-ui',
    title: 'Wasm Web UI',
    link: '/projects/wasm-web-ui/',
    status: 'Prototype',
    statusType: 'warning',
    tagline: 'Protocol for isolated web components in WebAssembly',
    summary:
      'Runs untrusted custom elements from Wasm modules with explicit capability imports and no direct DOM access. Components emit declarative template results across the boundary and render on both the client and Wasm servers.',
    stack: ['Zena', 'JavaScript', 'Rust'],
  },
  {
    slug: 'playground',
    title: 'WebAssembly Playground',
    link: '/projects/playground/',
    status: 'In progress',
    statusType: 'warning',
    tagline: 'In-browser editor, worker protocol, and sandboxed preview',
    summary:
      'Growing from the Zena playground into a general WebAssembly playground with a standard build worker, LSP, console output, and multi-file preview protocol that any Wasm-compiled compiler can plug into.',
    stack: ['JavaScript', 'Web Workers', 'Wasm'],
  },
  {
    slug: 'runtime',
    title: 'Zena CLI & Host Runtime',
    link: '/projects/runtime/',
    status: 'In progress',
    statusType: 'warning',
    tagline: 'Wasmtime host crate and WIT interfaces extending WASI',
    summary:
      'Shared Rust host crates and zena:host WIT interfaces for spawning processes, loading capability-sandboxed Wasm plugins, caching compiled components, and formatting Wasm stack traces.',
    stack: ['Rust', 'Wasmtime', 'WASI 0.3'],
  },
  {
    slug: 'ssg',
    title: 'Static Site Generator',
    link: '/projects/ssg/',
    status: 'Idea',
    statusType: 'info',
    tagline: 'Workflow-driven static site generator with Wasm plugins',
    summary:
      'Planned static site generator combining zena:workflow, Zebra, and Zena Markdown so content pipelines share incremental task graphs, output caching, and multi-language Wasm extensions.',
    stack: ['Zena', 'Zebra', 'Wasm'],
  },
];
