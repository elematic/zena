@AGENTS.md

Directory-level orientation lives in CONTEXT.md files. Nested CLAUDE.md
shims import them automatically for Claude Code; other agents should
read the CONTEXT.md nearest their work before editing:

- `packages/compiler/CONTEXT.md` — self-hosted compiler, codegen overview
- `packages/compiler/src/lib/codegen/ir/CONTEXT.md` — ZIR backend (lowering, GVN, emit)
- `packages/compiler/src/lib/checker/CONTEXT.md` — the type checker's libraries
- `packages/compiler/src/lib/codegen/reachability/CONTEXT.md` — RTA, specialization
- `packages/cli/CONTEXT.md` — Rust CLI / wasmtime embedder
- `packages/pds/CONTEXT.md` — the PDS and its managed accounts
- `packages/registry/CONTEXT.md` — the App View: the registry methods, the site, and the service
- `packages/pds-web/CONTEXT.md` — the App View's server-rendered pages and their assets
- `packages/markdown/CONTEXT.md` — CommonMark and GFM parser, AST, plugin API, and HTML renderer
- `packages/semver/CONTEXT.md` — semantic versions and npm's version ranges
- `packages/changes/CONTEXT.md` — change files, units and groups, and release versions
- `packages/terminal/CONTEXT.md` — colors, Clack-style layout and a spinner for command-line programs
- `packages/workspace-hack/CONTEXT.md` — generated crate unifying the Rust crates' dependency features
- `packages/zenafx-render/CONTEXT.md` — platform-independent ZenaFX rendering engine (retained scene, taffy, parley, vello_cpu)
- `packages/zenafx-web/CONTEXT.md` — ZenaFX web runtime (wasm32 engine + JS Component Model Async host + Canvas2D/WebGPU surface)
