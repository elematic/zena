import {suite, test} from 'node:test';
import assert from 'node:assert';
import {compileAndRun} from './utils.js';

suite('StringReader', () => {
  test('position tracking', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("hello");
        let pos1 = r.position;      // 0
        r.advanceByte();
        let pos2 = r.position;      // 1
        return pos1 * 10 + pos2;    // 01
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('isAtEnd', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("ab");
        var count = 0;
        while (!r.isAtEnd) {
          r.advanceByte();
          count = count + 1;
        }
        return count;
      };
    `);
    assert.strictEqual(result, 2);
  });

  test('peekByte and advanceByte', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("AB");
        let a = r.peekByte();       // 65
        let a2 = r.advanceByte();   // 65 (and advances)
        let b = r.peekByte();       // 66
        return a + a2 + b;          // 65 + 65 + 66 = 196
      };
    `);
    assert.strictEqual(result, 196);
  });

  test('peekByte returns -1 at end', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("");
        return r.peekByte();  // -1
      };
    `);
    assert.strictEqual(result, -1);
  });

  test('peek decodes ASCII', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("A");
        return r.peek();  // 65
      };
    `);
    assert.strictEqual(result, 65);
  });

  test('advance returns code point and moves position', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("AB");
        let a = r.advance();  // 65
        let b = r.advance();  // 66
        return a + b;         // 131
      };
    `);
    assert.strictEqual(result, 131);
  });

  test('mark and sliceFrom', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): boolean => {
        let r = new StringReader("hello world");
        r.advanceByte();  // skip 'h'
        let start = r.mark();
        r.advanceByte();  // 'e'
        r.advanceByte();  // 'l'
        r.advanceByte();  // 'l'
        let slice = r.sliceFrom(start);
        return slice == "ell";
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('sliceRange', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): boolean => {
        let r = new StringReader("hello world");
        let start = r.mark();
        r.advanceByte();  // 'h'
        r.advanceByte();  // 'e'
        r.advanceByte();  // 'l'
        r.advanceByte();  // 'l'
        r.advanceByte();  // 'o'
        let end = r.mark();
        let slice = r.sliceRange(start, end);
        return slice == "hello";
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('skipWhitespace', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("   hello");
        r.skipWhitespace();
        return r.peekByte();  // 'h' = 104
      };
    `);
    assert.strictEqual(result, 104);
  });

  test('matchByte success', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("hello");
        let matched = r.matchByte(104);  // 'h'
        let pos = r.position;
        if (matched) {
          return pos;  // 1
        }
        return 0 - 1;
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('matchByte failure', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("hello");
        let matched = r.matchByte(120);  // 'x' - not a match
        let pos = r.position;
        if (matched) {
          return 0 - 1;
        }
        return pos;  // 0 (position unchanged)
      };
    `);
    assert.strictEqual(result, 0);
  });

  test('reset to marked position', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("hello");
        let start = r.mark();
        r.advanceByte();
        r.advanceByte();
        r.advanceByte();
        r.reset(start);
        return r.position;  // 0
      };
    `);
    assert.strictEqual(result, 0);
  });

  test('remaining length', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("hello");
        let r1 = r.remaining;  // 5
        r.advanceByte();
        r.advanceByte();
        let r2 = r.remaining;  // 3
        return r1 * 10 + r2;   // 53
      };
    `);
    assert.strictEqual(result, 53);
  });

  test('parsing quoted string pattern', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): boolean => {
        let r = new StringReader('"hello world"');
        r.advanceByte();  // skip opening "
        let start = r.mark();
        while (r.peekByte() != 34) {  // 34 = "
          r.advanceByte();
        }
        let content = r.sliceFrom(start);
        r.advanceByte();  // skip closing "
        return content == "hello world";
      };
    `);
    assert.strictEqual(result, 1);
  });

  test('skipBytesWhile for digits', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): boolean => {
        let r = new StringReader("12345abc");
        let start = r.mark();
        // Use inline lambda since top-level function references have scoping issues
        r.skipBytesWhile((b: i32): boolean => b >= 48 && b <= 57);
        let digits = r.sliceFrom(start);
        return digits == "12345";
      };
    `);
    assert.strictEqual(result, 1);
  });
});

suite('StringReader - UTF-8 handling', () => {
  test('peek decodes 2-byte UTF-8', async () => {
    // é is U+00E9, encoded as C3 A9 in UTF-8
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("é");
        return r.peek();  // 233 (0xE9)
      };
    `);
    assert.strictEqual(result, 0xe9);
  });

  test('advance moves correct bytes for 2-byte UTF-8', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("éa");  // é is 2 bytes, a is 1 byte
        r.advance();      // skip é (2 bytes)
        return r.position;  // 2
      };
    `);
    assert.strictEqual(result, 2);
  });

  test('peek decodes 3-byte UTF-8', async () => {
    // € is U+20AC, encoded as E2 82 AC in UTF-8
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("€");
        return r.peek();  // 8364 (0x20AC)
      };
    `);
    assert.strictEqual(result, 0x20ac);
  });

  test('advance moves correct bytes for 3-byte UTF-8', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("€a");  // € is 3 bytes, a is 1 byte
        r.advance();      // skip € (3 bytes)
        return r.position;  // 3
      };
    `);
    assert.strictEqual(result, 3);
  });

  test('peek decodes 4-byte UTF-8 (emoji)', async () => {
    // 😀 is U+1F600, encoded as F0 9F 98 80 in UTF-8
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("😀");
        return r.peek();  // 128512 (0x1F600)
      };
    `);
    assert.strictEqual(result, 0x1f600);
  });

  test('advance moves correct bytes for 4-byte UTF-8', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("😀a");  // 😀 is 4 bytes, a is 1 byte
        r.advance();      // skip 😀 (4 bytes)
        return r.position;  // 4
      };
    `);
    assert.strictEqual(result, 4);
  });

  test('skip N code points works with multi-byte chars', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): i32 => {
        let r = new StringReader("aéb");  // a(1) + é(2) + b(1) = 4 bytes
        r.skip(2);        // skip 'a' and 'é'
        return r.position;  // 3 (1 + 2)
      };
    `);
    assert.strictEqual(result, 3);
  });

  test('safe slicing with Unicode using mark()', async () => {
    const result = await compileAndRun(`
      import {StringReader} from 'zena:string-reader';
      
      export let main = (): boolean => {
        // "a😀b" - 'a' is 1 byte, emoji is 4 bytes, 'b' is 1 byte
        let r = new StringReader("a😀b");
        r.advance();  // skip 'a'
        let start = r.mark();
        r.advance();  // skip emoji (moves 4 bytes safely)
        let emoji = r.sliceFrom(start);
        return emoji == "😀";
      };
    `);
    assert.strictEqual(result, 1);
  });
});
