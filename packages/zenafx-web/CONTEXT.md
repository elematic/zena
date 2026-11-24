# zenafx-web Context

Web bottom layer for ZenaFX: runs unmodified ZenaFX WebAssembly components in the browser (and Node.js v26+) over a `wasm32-unknown-unknown` build of `packages/zenafx-render`.

## Layout

- `engine/` — Rust `cdylib` workspace member (`zenafx-web-engine`) compiling `zenafx-render` to `wasm32-unknown-unknown` (`out/zenafx_web_engine.wasm`) with the `wasm-release` profile, excluded from `workspace-hack` in `.config/hakari.toml`.
- `src/` — zero-dependency ES2024 JavaScript runtime (`component-parser.js`, `cabi.js`, `engine-bridge.js`, `component-runner.js`, `surface.js`, `index.js`).
- `demo/` — interactive browser demo (`index.html`, `demo.js`) and local dev server (`serve.mjs`).
- `test/web_runner_test.js` — end-to-end `node:test` suite exercising the real `zenafx_web_engine.wasm` and all four compiled ZenaFX example components.

## Commands

- Build wasm32 engine: `./target/release/zena build ./packages/zenafx-web:build`
- Run tests: `./target/release/zena run ./packages/zenafx-web:test`
- Run demo server: `./target/release/zena run ./packages/zenafx-web:demo`
