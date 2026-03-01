import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

/**
 * Helper: compile Zena code that converts an f64 to string and compares
 * it against an expected string. Returns 1 if match, 0 if mismatch.
 *
 * Note: `as` has higher precedence than +/- in Zena, so expressions like
 * `0.0 as f64 - 1.0 as f64` don't parse. Use simple literals or unary minus.
 */
const expectF64 = (expr: string, expected: string) => {
  return `
    export let main = (): i32 => {
      let v: f64 = ${expr};
      let s = \`\${v}\`;
      if (s == "${expected}") { return 1; }
      return 0;
    };
  `;
};

const expectF32 = (expr: string, expected: string) => {
  return `
    export let main = (): i32 => {
      let v: f32 = ${expr};
      let s = \`\${v}\`;
      if (s == "${expected}") { return 1; }
      return 0;
    };
  `;
};

suite('Float to String - f64', () => {
  test('zero', async () => {
    const result = await compileAndRun(expectF64('0.0 as f64', '0'));
    assert.strictEqual(result, 1);
  });

  test('integer value 1', async () => {
    const result = await compileAndRun(expectF64('1.0 as f64', '1'));
    assert.strictEqual(result, 1);
  });

  test('integer value 42', async () => {
    const result = await compileAndRun(expectF64('42.0 as f64', '42'));
    assert.strictEqual(result, 1);
  });

  test('integer value 10', async () => {
    const result = await compileAndRun(expectF64('10.0 as f64', '10'));
    assert.strictEqual(result, 1);
  });

  test('integer value 100', async () => {
    const result = await compileAndRun(expectF64('100.0 as f64', '100'));
    assert.strictEqual(result, 1);
  });

  test('integer value 12345', async () => {
    const result = await compileAndRun(expectF64('12345.0 as f64', '12345'));
    assert.strictEqual(result, 1);
  });

  test('0.5', async () => {
    const result = await compileAndRun(expectF64('0.5 as f64', '0.5'));
    assert.strictEqual(result, 1);
  });

  test('1.5', async () => {
    const result = await compileAndRun(expectF64('1.5 as f64', '1.5'));
    assert.strictEqual(result, 1);
  });

  test('0.25', async () => {
    const result = await compileAndRun(expectF64('0.25 as f64', '0.25'));
    assert.strictEqual(result, 1);
  });

  test('0.125', async () => {
    const result = await compileAndRun(expectF64('0.125 as f64', '0.125'));
    assert.strictEqual(result, 1);
  });

  test('0.1 (common decimal)', async () => {
    // With the f64 constant-folding optimization, 0.1 as f64 gives
    // the proper f64 value, which should format as "0.1"
    const result = await compileAndRun(expectF64('0.1 as f64', '0.1'));
    assert.strictEqual(result, 1);
  });

  test('0.3 (common decimal)', async () => {
    const result = await compileAndRun(expectF64('0.3 as f64', '0.3'));
    assert.strictEqual(result, 1);
  });

  test('3.14', async () => {
    const result = await compileAndRun(expectF64('3.14 as f64', '3.14'));
    assert.strictEqual(result, 1);
  });

  test('0.001', async () => {
    const result = await compileAndRun(expectF64('0.001 as f64', '0.001'));
    assert.strictEqual(result, 1);
  });

  test('0.000001 (boundary of normal notation)', async () => {
    const result = await compileAndRun(
      expectF64('0.000001 as f64', '0.000001'),
    );
    assert.strictEqual(result, 1);
  });

  test('negative value', async () => {
    const result = await compileAndRun(expectF64('-3.14 as f64', '-3.14'));
    assert.strictEqual(result, 1);
  });

  test('negative 0.5', async () => {
    const result = await compileAndRun(expectF64('-0.5 as f64', '-0.5'));
    assert.strictEqual(result, 1);
  });

  test('negative integer', async () => {
    const result = await compileAndRun(expectF64('-42.0 as f64', '-42'));
    assert.strictEqual(result, 1);
  });

  test('NaN', async () => {
    const source = `
      export let main = (): i32 => {
        let zero: f64 = 0.0 as f64;
        let v = zero / zero;
        let s = \`\${v}\`;
        if (s == "NaN") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('positive Infinity', async () => {
    const source = `
      export let main = (): i32 => {
        let one: f64 = 1.0 as f64;
        let zero: f64 = 0.0 as f64;
        let v = one / zero;
        let s = \`\${v}\`;
        if (s == "Infinity") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('negative Infinity', async () => {
    const source = `
      export let main = (): i32 => {
        let neg_one: f64 = -1.0 as f64;
        let zero: f64 = 0.0 as f64;
        let v = neg_one / zero;
        let s = \`\${v}\`;
        if (s == "-Infinity") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('value near 1', async () => {
    const result = await compileAndRun(expectF64('0.9999 as f64', '0.9999'));
    assert.strictEqual(result, 1);
  });

  test('value 1.23456789', async () => {
    const result = await compileAndRun(
      expectF64('1.23456789 as f64', '1.23456789'),
    );
    assert.strictEqual(result, 1);
  });

  test('large integer 1e20 (boundary of normal notation)', async () => {
    // 1e20 has exponent 20, which is < 21, so should be normal notation
    const source = `
      export let main = (): i32 => {
        var v: f64 = 1.0 as f64;
        for (var i = 0; i < 20; i = i + 1) { v = v * (10.0 as f64); }
        let s = \`\${v}\`;
        if (s == "100000000000000000000") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('1e21 uses scientific notation', async () => {
    // 1e21 has exponent 21, which is >= 21, so should be scientific notation
    const source = `
      export let main = (): i32 => {
        var v: f64 = 1.0 as f64;
        for (var i = 0; i < 21; i = i + 1) { v = v * (10.0 as f64); }
        let s = \`\${v}\`;
        if (s == "1e+21") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('1e-7 uses scientific notation', async () => {
    // 1e-7 has exponent -7, which is < -6, so should be scientific notation
    const source = `
      export let main = (): i32 => {
        var v: f64 = 1.0 as f64;
        for (var i = 0; i < 7; i = i + 1) { v = v / (10.0 as f64); }
        let s = \`\${v}\`;
        if (s == "1e-7") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('1e100 (large exponent)', async () => {
    const source = `
      export let main = (): i32 => {
        var v: f64 = 1.0 as f64;
        for (var i = 0; i < 100; i = i + 1) { v = v * (10.0 as f64); }
        let s = \`\${v}\`;
        if (s == "1e+100") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('1e-100 (small exponent)', async () => {
    const source = `
      export let main = (): i32 => {
        var v: f64 = 1.0 as f64;
        for (var i = 0; i < 100; i = i + 1) { v = v / (10.0 as f64); }
        let s = \`\${v}\`;
        if (s == "1e-100") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('15000000000 (1.5e10)', async () => {
    const source = `
      export let main = (): i32 => {
        var v: f64 = 1.5 as f64;
        for (var i = 0; i < 10; i = i + 1) { v = v * (10.0 as f64); }
        let s = \`\${v}\`;
        if (s == "15000000000") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('negative zero', async () => {
    const source = `
      export let main = (): i32 => {
        let v: f64 = -0.0 as f64;
        let s = \`\${v}\`;
        if (s == "-0") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('f64 MAX_VALUE (1.7976931348623157e+308)', async () => {
    // Construct via bit pattern: 0x7FEFFFFFFFFFFFFF = 9218868437227405311
    const source = `
      import { f64_reinterpret_i64 } from 'zena:math';
      export let main = (): i32 => {
        let v = f64_reinterpret_i64(9218868437227405311 as i64);
        let s = \`\${v}\`;
        if (s == "1.79769313486231e+308") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('f64 MIN_VALUE / smallest subnormal (5e-324)', async () => {
    // Construct via bit pattern: 0x1
    const source = `
      import { f64_reinterpret_i64 } from 'zena:math';
      export let main = (): i32 => {
        let v = f64_reinterpret_i64(1 as i64);
        let s = \`\${v}\`;
        if (s == "4.94065645841247e-324") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('f64 smallest normal (2.2250738585072014e-308)', async () => {
    // Construct via bit pattern: 0x0010000000000000 = 4503599627370496
    const source = `
      import { f64_reinterpret_i64 } from 'zena:math';
      export let main = (): i32 => {
        let v = f64_reinterpret_i64(4503599627370496 as i64);
        let s = \`\${v}\`;
        if (s == "2.2250738585072e-308") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('f64 EPSILON (2.220446049250313e-16)', async () => {
    // Construct via bit pattern: 0x3CB0000000000000 = 4372995238176751616
    const source = `
      import { f64_reinterpret_i64 } from 'zena:math';
      export let main = (): i32 => {
        let v = f64_reinterpret_i64(4372995238176751616 as i64);
        let s = \`\${v}\`;
        if (s == "2.22044604925031e-16") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  // NOTE: Our 15-significant-digit algorithm does not produce the shortest
  // round-trip representation. For example, 0.1+0.2 produces "0.3" instead
  // of JavaScript's "0.30000000000000004". These tests document current
  // behavior and will need updating when we implement a shortest-representation
  // algorithm (e.g. Ryū).
  test('0.1 + 0.2 (classic FP corner case)', async () => {
    const source = `
      export let main = (): i32 => {
        let v: f64 = (0.1 as f64) + (0.2 as f64);
        let s = \`\${v}\`;
        // With 15 sig digits this rounds to "0.3", not JS's "0.30000000000000004"
        if (s == "0.3") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('1/3 (repeating decimal)', async () => {
    const source = `
      export let main = (): i32 => {
        let v: f64 = (1.0 as f64) / (3.0 as f64);
        let s = \`\${v}\`;
        if (s == "0.333333333333333") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});

suite('Float to String - f32', () => {
  test('zero', async () => {
    const result = await compileAndRun(expectF32('0.0', '0'));
    assert.strictEqual(result, 1);
  });

  test('3.14', async () => {
    const result = await compileAndRun(expectF32('3.14', '3.14'));
    assert.strictEqual(result, 1);
  });

  test('0.5', async () => {
    const result = await compileAndRun(expectF32('0.5', '0.5'));
    assert.strictEqual(result, 1);
  });

  test('0.1', async () => {
    const result = await compileAndRun(expectF32('0.1', '0.1'));
    assert.strictEqual(result, 1);
  });

  test('integer value 42', async () => {
    const result = await compileAndRun(expectF32('42.0', '42'));
    assert.strictEqual(result, 1);
  });

  test('negative value', async () => {
    const result = await compileAndRun(expectF32('-3.14', '-3.14'));
    assert.strictEqual(result, 1);
  });

  test('NaN', async () => {
    const source = `
      export let main = (): i32 => {
        let zero: f32 = 0.0;
        let v = zero / zero;
        let s = \`\${v}\`;
        if (s == "NaN") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('Infinity', async () => {
    const source = `
      export let main = (): i32 => {
        let one: f32 = 1.0;
        let zero: f32 = 0.0;
        let v = one / zero;
        let s = \`\${v}\`;
        if (s == "Infinity") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('1.5', async () => {
    const result = await compileAndRun(expectF32('1.5', '1.5'));
    assert.strictEqual(result, 1);
  });

  test('0.25', async () => {
    const result = await compileAndRun(expectF32('0.25', '0.25'));
    assert.strictEqual(result, 1);
  });

  test('100.0', async () => {
    const result = await compileAndRun(expectF32('100.0', '100'));
    assert.strictEqual(result, 1);
  });

  test('f32 max (3.4028235e+38)', async () => {
    const source = `
      export let main = (): i32 => {
        let base: f32 = 3.4028235;
        var v: f32 = base;
        for (var i = 0; i < 38; i = i + 1) { v = v * 10.0; }
        let s = \`\${v}\`;
        if (s == "3.402823e+38") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('f32 smallest subnormal (1.4e-45)', async () => {
    const source = `
      export let main = (): i32 => {
        let base: f32 = 1.4;
        var v: f32 = base;
        for (var i = 0; i < 45; i = i + 1) { v = v / 10.0; }
        let s = \`\${v}\`;
        if (s == "1.401298e-45") { return 1; }
        return 0;
      };
    `;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
