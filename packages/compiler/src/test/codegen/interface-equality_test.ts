import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('CodeGenerator - Interface Equality', () => {
  async function run(body: string, setup: string) {
    const source = `
      ${setup}
      export let main = (): i32 => {
        ${body}
      };
    `;
    return await compileAndRun(source);
  }

  const twoInterfaces = `
    interface Readable {
      read(): i32;
    }

    interface Writable {
      write(x: i32): void;
    }

    class Stream implements Readable, Writable {
      var value: i32 = 0;
      read(): i32 { return this.value; }
      write(x: i32): void { this.value = x; }
    }
  `;

  test('same object via two different interfaces: == should be true', async () => {
    const result = await run(
      `
      let s = new Stream();
      let r: Readable = s;
      let w: Writable = s;
      if (r == w) { return 1; }
      return 0;
    `,
      twoInterfaces,
    );
    assert.strictEqual(result, 1);
  });

  test('same object via two different interfaces: != should be false', async () => {
    const result = await run(
      `
      let s = new Stream();
      let r: Readable = s;
      let w: Writable = s;
      if (r != w) { return 1; }
      return 0;
    `,
      twoInterfaces,
    );
    assert.strictEqual(result, 0);
  });

  test('same object via two different interfaces: === should be true', async () => {
    const result = await run(
      `
      let s = new Stream();
      let r: Readable = s;
      let w: Writable = s;
      if (r === w) { return 1; }
      return 0;
    `,
      twoInterfaces,
    );
    assert.strictEqual(result, 1);
  });

  test('same object via two different interfaces: !== should be false', async () => {
    const result = await run(
      `
      let s = new Stream();
      let r: Readable = s;
      let w: Writable = s;
      if (r !== w) { return 1; }
      return 0;
    `,
      twoInterfaces,
    );
    assert.strictEqual(result, 0);
  });

  test('different objects via same interface: == should be false', async () => {
    const result = await run(
      `
      let s1 = new Stream();
      let s2 = new Stream();
      let r1: Readable = s1;
      let r2: Readable = s2;
      if (r1 == r2) { return 1; }
      return 0;
    `,
      twoInterfaces,
    );
    assert.strictEqual(result, 0);
  });

  test('direct reference == interface reference (same object)', async () => {
    const result = await run(
      `
      let s = new Stream();
      let r: Readable = s;
      if (s == r) { return 1; }
      return 0;
    `,
      twoInterfaces,
    );
    assert.strictEqual(result, 1);
  });

  test('interface reference == direct reference (same object)', async () => {
    const result = await run(
      `
      let s = new Stream();
      let r: Readable = s;
      if (r == s) { return 1; }
      return 0;
    `,
      twoInterfaces,
    );
    assert.strictEqual(result, 1);
  });

  test('direct reference === interface reference (same object)', async () => {
    const result = await run(
      `
      let s = new Stream();
      let r: Readable = s;
      if (s === r) { return 1; }
      return 0;
    `,
      twoInterfaces,
    );
    assert.strictEqual(result, 1);
  });

  test('interface reference === direct reference (same object)', async () => {
    const result = await run(
      `
      let s = new Stream();
      let r: Readable = s;
      if (r === s) { return 1; }
      return 0;
    `,
      twoInterfaces,
    );
    assert.strictEqual(result, 1);
  });

  test('direct reference != interface reference (different objects)', async () => {
    const result = await run(
      `
      let s1 = new Stream();
      let s2 = new Stream();
      let r: Readable = s2;
      if (s1 != r) { return 1; }
      return 0;
    `,
      twoInterfaces,
    );
    assert.strictEqual(result, 1);
  });

  const parentChild = `
    interface Animal {
      name(): i32;
    }

    interface Mammal extends Animal {
      legs(): i32;
    }

    class Cat implements Mammal {
      name(): i32 { return 1; }
      legs(): i32 { return 4; }
    }
  `;

  test('same object via parent and child interface: == should be true', async () => {
    const result = await run(
      `
      let c = new Cat();
      let a: Animal = c;
      let m: Mammal = c;
      if (a == m) { return 1; }
      return 0;
    `,
      parentChild,
    );
    assert.strictEqual(result, 1);
  });

  test('same object via parent and child interface: === should be true', async () => {
    const result = await run(
      `
      let c = new Cat();
      let a: Animal = c;
      let m: Mammal = c;
      if (a === m) { return 1; }
      return 0;
    `,
      parentChild,
    );
    assert.strictEqual(result, 1);
  });
});
