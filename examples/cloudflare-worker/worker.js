/**
 * The JavaScript shim around hello.wasm.
 *
 * A Worker's entry module must be JavaScript: workerd's module table has
 * no wasm entry type, and importing a `.wasm` module yields a
 * `WebAssembly.Module` for JS to instantiate. Everything here is the
 * glue a `zena:cloudflare` binding layer would generate.
 * See docs/design/cloudflare-workers.md.
 */

import {DurableObject} from 'cloudflare:workers';
import {instantiate, run, createStringReader} from '@zena-lang/runtime';
import helloWasm from './hello.wasm';

// Instantiated once per isolate, shared by the entrypoint and every
// Durable Object in it. Compilation already happened at deploy time;
// what runs here counts against the 1s startup limit.
const instance = await instantiate(helloWasm);
const readString = createStringReader(instance.exports);

const str = (ref) => readString(ref, instance.exports.$stringGetLength(ref));

/**
 * A Durable Object is bound by its class, so the class has to exist in
 * JavaScript. The state lives in the object's SQLite database and the
 * work happens in Zena.
 */
export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS hits (n INTEGER PRIMARY KEY, count INTEGER)',
    );
  }

  /** Public methods on a Durable Object class are its RPC surface. */
  async bump() {
    const {count} = this.ctx.storage.sql
      .exec(
        'INSERT INTO hits (n, count) VALUES (0, 1) ' +
          'ON CONFLICT(n) DO UPDATE SET count = count + 1 RETURNING count',
      )
      .one();
    return {count, message: str(await run(instance))};
  }
}

export default {
  async fetch(request, env) {
    // One Durable Object per path, so /a and /b count separately.
    const stub = env.COUNTER.getByName(new URL(request.url).pathname);
    return Response.json(await stub.bump());
  },
};
