import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('i64 comparison with as expression', () => {
  test('comparison with parenthesized as expression', async () => {
    const source = `
export let main = (): i32 => {
  let x = 1 as i64;
  if (x > (0 as i64)) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('less-than comparison with parenthesized as expression', async () => {
    const source = `
export let main = (): i32 => {
  let x = 0 as i64;
  if (x < (1 as i64)) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('comparison in class method', async () => {
    const source = `
class Counter {
  var value: i64 = 0 as i64;
  
  isGreaterThan(other: i64): boolean {
    return this.value > (0 as i64);
  }
  
  isLessThan(other: i64): boolean {
    return this.value < (1 as i64);
  }
}

export let main = (): i32 => {
  let c = new Counter();
  if (c.isLessThan(1 as i64)) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('comparison in generic class method', async () => {
    const source = `
class Box<T> {
  value: T;
  new(value: T) : value = value {}
  
  checkI64(): boolean {
    let x = 1 as i64;
    return x > (0 as i64);
  }
}

export let main = (): i32 => {
  let b = new Box<i32>(42);
  if (b.checkI64()) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('less-than before generic call', async () => {
    // This might confuse the parser: x < (0 as i64) followed by something
    // that looks like it could be generic type args
    const source = `
class Checker {
  check(): boolean {
    let x = 0 as i64;
    let result = x < (1 as i64);
    return result;
  }
}

export let main = (): i32 => {
  let c = new Checker();
  if (c.check()) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('chained comparison with as - potential ambiguity', async () => {
    // Try cases that might confuse < with generic type args
    const source = `
let identity = <T>(x: T): T => x;

export let main = (): i32 => {
  let x = 1 as i64;
  // This line has both < comparison and generic call
  let lessThan = x < (2 as i64);
  let id = identity<i64>(x);
  if (lessThan) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('comparison immediately followed by generic instantiation', async () => {
    // x < (0 as SomeType) could potentially look like x<(0 as SomeType)>
    const source = `
class Box<T> {
  value: T;
  new(v: T) : value = v {}
}

export let main = (): i32 => {
  let x = 0 as i64;
  if (x < (1 as i64)) {
    let b = new Box<i64>(x);
    return 1;
  }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('contextual typing - comparison with i64 literal', async () => {
    // NEW: Numeric literals now infer their type from context
    // x > 0 where x is i64 means 0 is also inferred as i64
    const source = `
export let main = (): i32 => {
  let x = 1 as i64;
  if (x > 0) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('contextual typing - comparison with f64 literal', async () => {
    const source = `
export let main = (): i32 => {
  let x = 3.14 as f64;
  if (x > 3) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('contextual typing - arithmetic with i64', async () => {
    const source = `
export let main = (): i32 => {
  let x = 100 as i64;
  let y = x + 50;  // 50 inferred as i64
  if (y > 100) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('contextual typing - chained comparisons', async () => {
    const source = `
export let main = (): i32 => {
  let x = 5 as i64;
  // Both 0 and 10 inferred as i64 from context
  if (x > 0) {
    if (x < 10) {
      return 1;
    }
  }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('contextual typing - decimal literal with f32 context', async () => {
    const source = `
export let main = (): i32 => {
  let x: f32 = 2.5;
  if (x > 2.0) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('comparison without parentheses - as has higher precedence', async () => {
    // x > 0 as i64 is parsed as x > (0 as i64) because `as` has higher precedence than `>`
    const source = `
export let main = (): i32 => {
  let x = 1 as i64;
  if (x > 0 as i64) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('variable declaration with explicit type annotation uses contextual typing', async () => {
    // Contextual typing applies to variable declarations with type annotations.
    // This allows the literal 1 (default type i32) to be coerced to i64.
    // This matches the self-hosted compiler's behavior and is consistent with
    // supporting idioms like `let arr: Array<i32> = []`.
    const source = `
export let main = (): i32 => {
  let x: i64 = 1;
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 0);
  });

  test('contextual typing - literal on LHS (bidirectional)', async () => {
    // 0 < x should work just like x > 0
    const source = `
export let main = (): i32 => {
  let x = 5 as i64;
  if (0 < x) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('contextual typing - arithmetic with literal on LHS', async () => {
    const source = `
export let main = (): i32 => {
  let x = 100 as i64;
  let y = 50 + x;  // 50 inferred as i64 from x
  if (y > 100) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('contextual typing - f64 literal on LHS', async () => {
    const source = `
export let main = (): i32 => {
  let x = 3.14 as f64;
  if (3.0 < x) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('contextual typing - both operands are literals defaults to i32', async () => {
    // When both are literals, no context is available, defaults to i32
    const source = `
export let main = (): i32 => {
  if (1 < 2) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });

  test('mixed int/float - i32 compared to float literal', async () => {
    // i32 > 1.5 - does the float literal stay as f32?
    const source = `
export let main = (): i32 => {
  let x: i32 = 5;
  if (x > 1.5) { return 1; }
  return 0;
};
`;
    const result = await compileAndRun(source);
    assert.strictEqual(result, 1);
  });
});
