/**
 * DCE tests for case classes.
 *
 * Verifies that auto-generated operator == and hashCode() are eliminated
 * by DCE when unused, making case classes zero-cost compared to manual
 * desugared equivalents.
 */
import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileToWasm} from './utils.js';

const compileAndValidate = async (
  source: string,
  dce = false,
): Promise<number> => {
  const bytes = compileToWasm(source, '/main.zena', {dce});
  await WebAssembly.compile(bytes.buffer as ArrayBuffer);
  return bytes.length;
};

suite('Case class DCE', () => {
  test('unused operator == and hashCode are eliminated', async () => {
    // Case class with DCE: auto-generated operator ==, hashCode() should be eliminated
    const caseClassDce = `
      class Point(x: i32, y: i32)

      export let main = (): i32 => {
        let p = new Point(1, 2);
        return p.x + p.y;
      };
    `;

    // Same case class without DCE: operator == and hashCode() are included
    const caseClassNoDce = `
      class Point(x: i32, y: i32)

      export let main = (): i32 => {
        let p = new Point(1, 2);
        return p.x + p.y;
      };
    `;

    const sizeDce = await compileAndValidate(caseClassDce, true);
    const sizeNoDce = await compileAndValidate(caseClassNoDce, false);

    console.log(`  Case class (DCE):    ${sizeDce} bytes`);
    console.log(`  Case class (no DCE): ${sizeNoDce} bytes`);

    // With DCE, the case class should be smaller because unused == and
    // hashCode are eliminated.
    assert.ok(
      sizeDce < sizeNoDce,
      `DCE should reduce case class size ` +
        `(dce=${sizeDce}, noDce=${sizeNoDce})`,
    );
  });

  test('used operator == is preserved', async () => {
    const source = `
      class Point(x: i32, y: i32)

      export let main = (): i32 => {
        let a = new Point(1, 2);
        let b = new Point(1, 2);
        return if (a == b) 1 else 0;
      };
    `;

    const sizeNoDce = await compileAndValidate(source, false);
    const sizeWithDce = await compileAndValidate(source, true);

    console.log(`  Without DCE: ${sizeNoDce} bytes`);
    console.log(`  With DCE:    ${sizeWithDce} bytes`);

    // DCE should not break operator == usage
    assert.ok(sizeWithDce > 0);
    assert.ok(sizeWithDce <= sizeNoDce);
  });

  test('used hashCode is preserved', async () => {
    const source = `
      class Point(x: i32, y: i32)

      export let main = (): i32 => {
        let p = new Point(3, 4);
        return p.hashCode();
      };
    `;

    const sizeNoDce = await compileAndValidate(source, false);
    const sizeWithDce = await compileAndValidate(source, true);

    console.log(`  Without DCE: ${sizeNoDce} bytes`);
    console.log(`  With DCE:    ${sizeWithDce} bytes`);

    assert.ok(sizeWithDce > 0);
    assert.ok(sizeWithDce <= sizeNoDce);
  });

  test('DCE eliminates both == and hashCode when neither is used', async () => {
    const source = `
      class Point(x: i32, y: i32)

      export let main = (): i32 => {
        let p = new Point(10, 20);
        return p.x;
      };
    `;

    const sizeNoDce = await compileAndValidate(source, false);
    const sizeWithDce = await compileAndValidate(source, true);

    console.log(`  Without DCE: ${sizeNoDce} bytes`);
    console.log(`  With DCE:    ${sizeWithDce} bytes`);

    // DCE should produce smaller binary since both methods are unused
    assert.ok(
      sizeWithDce < sizeNoDce,
      `DCE should reduce size (noDce=${sizeNoDce}, dce=${sizeWithDce})`,
    );
  });
});
