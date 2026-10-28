@AGENTS.md

Directory-level orientation lives in CONTEXT.md files. Nested CLAUDE.md
shims import them automatically for Claude Code; other agents should
read the CONTEXT.md nearest their work before editing:

- `packages/zena-compiler/CONTEXT.md` — self-hosted compiler, codegen overview
- `packages/zena-compiler/zena/lib/codegen/ir/CONTEXT.md` — ZIR backend (lowering, GVN, emit)
- `packages/zena-compiler/zena/lib/codegen/reachability/CONTEXT.md` — RTA, specialization
- `packages/zena-cli/CONTEXT.md` — Rust CLI / wasmtime embedder
- `packages/pds/CONTEXT.md` — the PDS and package host
- `packages/pds-web/CONTEXT.md` — the PDS's server-rendered pages and their assets
- `packages/workspace-hack/CONTEXT.md` — generated crate unifying the Rust crates' dependency features
