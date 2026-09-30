# Zena on Cloudflare Workers

A Zena module running inside [workerd](https://github.com/cloudflare/workerd),
the runtime behind Cloudflare Workers, with a Durable Object for state.

## Running it

This directory is a standalone npm project, so install its dependencies
first:

```bash
cd examples/cloudflare-worker
npm install
npm run dev
```

`npm run dev` compiles `hello.zena` for the `js` target (through the
compiler in the repository root) and starts a local server. No Cloudflare
account is needed — `wrangler dev` runs workerd on this machine.

```bash
curl http://localhost:8787/a     # {"count":1,"message":"Hello world from Zena | caught: boom | awaited"}
curl http://localhost:8787/a     # {"count":2,...}
curl http://localhost:8787/b     # {"count":1,...} — a different Durable Object
```

To rebuild the wasm alone, from the repository root:

```bash
npm run demo:cloudflare:build
```

## Why this is not a workspace

The repository's workspaces are `packages/*`, so this project's
dependencies stay out of the root `package-lock.json` deliberately.

wrangler depends on workerd and sharp, both of which ship one npm package
per platform as optional dependencies. npm installs only the one matching
the current machine, but a lockfile records all of them, and the Nix build
fetches every entry in the root lockfile regardless of `os`/`cpu` —
`npmDepsHash` is a fixed-output derivation, so its hash has to be the same
on every machine. Adding wrangler to the root tripled that fetch, from
210 MB to 613 MB, for a demo that no build or test depends on.

Keeping a separate `package.json` and `package-lock.json` here pins
wrangler for anyone who wants to run the demo and costs nothing to anyone
who does not.

## Files

| File             | Role                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| `hello.zena`     | The Zena module: a GC string, a caught exception, an async entry point              |
| `worker.js`      | The JavaScript shim that instantiates the wasm and defines the Durable Object class |
| `wrangler.jsonc` | Worker configuration: the wasm loader rule and the Durable Object binding           |

`hello.wasm` is a build output and is not checked in. `worker.js` resolves
`@zena-lang/runtime` from the repository root's `node_modules`, so the
root workspaces need to be installed too.

## Why there is a JavaScript file

A Worker's entry module must be JavaScript. workerd has no wasm entry
type; importing a `.wasm` file produces a `WebAssembly.Module` that JS
instantiates. Durable Objects are bound by class name, so the class also
has to exist in JavaScript.

`worker.js` is written by hand here. A `zena:cloudflare` binding layer
would generate it. See
[docs/design/cloudflare-workers.md](../../docs/design/cloudflare-workers.md)
for what that involves and what is still missing — chiefly that only an
async `main` can currently return a value to JavaScript, which is why the
async entry point in `hello.zena` is named `main`.
