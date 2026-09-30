/**
 * A cast a specialization makes impossible traps when it runs.
 *
 * `v as anyref` type-checks for any T, because casts on a type parameter
 * are checked where the generic is defined. With T = i32 no value can
 * satisfy it, since a primitive never becomes a reference. The portable
 * test tests/language/execution/generics/scalar-reference-cast-in-specialization.zena
 * covers the common case, where a guard keeps the cast from running. This
 * covers the cast running, which the portable runner has no directive
 * for: it must trap, and must not hand back a null.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';

import {compile} from './compile-zena.js';
import {instantiate} from '../index.js';

suite('Runtime - generic casts', () => {
  test('a primitive cast to a reference traps when it runs', async () => {
    const result = await instantiate(
      compile(`
        let toRef = <T>(v: T): anyref => v as anyref;

        export let primitive = (): i32 => {
          let r = toRef(5);
          return if (r == null) { 1 } else { 2 };
        };

        export let reference = (): i32 => {
          let r = toRef('five');
          return if (r == null) { 1 } else { 2 };
        };
      `),
      {},
    );
    const instance =
      (result as {instance?: WebAssembly.Instance}).instance ??
      (result as WebAssembly.Instance);
    const exports = instance.exports as Record<string, () => number>;

    assert.strictEqual(exports.reference(), 2);
    assert.throws(() => exports.primitive(), WebAssembly.RuntimeError);
  });
});
