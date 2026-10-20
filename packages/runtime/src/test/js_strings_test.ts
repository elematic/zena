import {suite, test} from 'node:test';
import assert from 'node:assert/strict';
import {instantiate} from '../index.js';
import {compile} from './compile-zena.js';

suite('Runtime - Target JS WebAssembly Strings', () => {
  test('string literal return and console.log with target js', async () => {
    const wasm = compile(
      `
      export let main = (): String => {
        console.log("Hello from Zena JS target!");
        return "returned from main";
      };
    `,
      'js',
    );

    const logged: string[] = [];
    const customConsole = {
      log_string: (msg: unknown) => {
        assert.equal(typeof msg, 'string');
        logged.push(msg as string);
      },
    };

    const res = await instantiate(wasm, {
      console: customConsole,
    });
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    const main = instance.exports.main as () => unknown;
    const retVal = main();

    assert.equal(typeof retVal, 'string');
    assert.equal(retVal, 'returned from main');
    assert.equal(logged.length, 1);
    assert.equal(logged[0], 'Hello from Zena JS target!');
  });

  test('passing JS string to Zena function and string concatenation', async () => {
    const wasm = compile(
      `
      export let greet = (name: String): String => {
        return "Hello, " + name + "!";
      };
    `,
      'js',
    );

    const res = await instantiate(wasm);
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    const greet = instance.exports.greet as (name: string) => unknown;

    const greeting = greet('Antigravity');
    assert.equal(typeof greeting, 'string');
    assert.equal(greeting, 'Hello, Antigravity!');
  });

  test('string equality and comparisons with target js', async () => {
    const wasm = compile(
      `
      export let checkEquals = (a: String, b: String): boolean => a == b;
      export let checkNotEquals = (a: String, b: String): boolean => a != b;
    `,
      'js',
    );

    const res = await instantiate(wasm);
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    const checkEquals = instance.exports.checkEquals as (
      a: string,
      b: string,
    ) => number;
    const checkNotEquals = instance.exports.checkNotEquals as (
      a: string,
      b: string,
    ) => number;

    assert.equal(checkEquals('hello', 'hello'), 1);
    assert.equal(checkEquals('hello', 'world'), 0);
    assert.equal(checkNotEquals('hello', 'world'), 1);
    assert.equal(checkNotEquals('hello', 'hello'), 0);
  });

  test('string methods on native JS strings', async () => {
    const wasm = compile(
      `
      export let testLength = (s: String): i32 => s.length;
      export let testSubstring = (s: String, start: i32, end: i32): String => s.substring(start, end);
      export let testStartsWith = (s: String, prefix: String): boolean => s.startsWith(prefix);
      export let testEndsWith = (s: String, suffix: String): boolean => s.endsWith(suffix);
      export let testIndexOf = (s: String, needle: String): i32 => {
        if (let (true, idx) = s.indexOf(needle)) {
          return idx as i32;
        }
        return -1;
      };
      export let testCharCodeAt = (s: String, index: i32): i32 => s.charCodeAt(index);
      export let testCodePointAt = (s: String, index: i32): i32 => s.codePointAt(index);
      export let testLowerCase = (s: String): String => s.asciiLowerCase();
      export let testUpperCase = (s: String): String => s.asciiUpperCase();
      export let testTrim = (s: String): String => s.trim();
    `,
      'js',
    );

    const res = await instantiate(wasm);
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    const exports = instance.exports as Record<string, Function>;

    // length
    assert.equal(exports.testLength('hello'), 5);
    assert.equal(exports.testLength(''), 0);

    // substring & clamping
    assert.equal(exports.testSubstring('hello world', 0, 5), 'hello');
    assert.equal(exports.testSubstring('hello world', -3, 5), 'hello');
    assert.equal(exports.testSubstring('hello world', 6, 100), 'world');
    assert.equal(exports.testSubstring('hello world', 5, 2), '');

    // startsWith / endsWith
    assert.equal(exports.testStartsWith('hello world', 'hello'), 1);
    assert.equal(exports.testStartsWith('hello world', 'world'), 0);
    assert.equal(exports.testEndsWith('hello world', 'world'), 1);
    assert.equal(exports.testEndsWith('hello world', 'hello'), 0);

    // indexOf
    assert.equal(exports.testIndexOf('hello world', 'world'), 6);
    assert.equal(exports.testIndexOf('hello world', 'notfound'), -1);

    // charCodeAt / codePointAt
    assert.equal(exports.testCharCodeAt('A', 0), 65);
    assert.equal(exports.testCodePointAt('A', 0), 65);

    // asciiLowerCase / asciiUpperCase
    assert.equal(exports.testLowerCase('Hello WORLD'), 'hello world');
    assert.equal(exports.testUpperCase('Hello world'), 'HELLO WORLD');

    // trim
    assert.equal(exports.testTrim('  hello world  '), 'hello world');
  });

  test('string split on native JS strings', async () => {
    const wasm = compile(
      `
      export let countParts = (s: String, sep: String): i32 => {
        let parts = s.split(sep);
        return parts.length;
      };

      export let getPart = (s: String, sep: String, index: i32): String => {
        let parts = s.split(sep);
        return parts[index];
      };
    `,
      'js',
    );

    const res = await instantiate(wasm);
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    const countParts = instance.exports.countParts as (
      s: string,
      sep: string,
    ) => number;
    const getPart = instance.exports.getPart as (
      s: string,
      sep: string,
      index: number,
    ) => string;

    assert.equal(countParts('apple,banana,cherry', ','), 3);
    assert.equal(getPart('apple,banana,cherry', ',', 0), 'apple');
    assert.equal(getPart('apple,banana,cherry', ',', 1), 'banana');
    assert.equal(getPart('apple,banana,cherry', ',', 2), 'cherry');
  });

  test('template literals with target js', async () => {
    const wasm = compile(
      `
      export let formatGreeting = (name: String, count: i32): String => {
        return \`Hello \${name}, you have \${count} messages!\`;
      };
    `,
      'js',
    );

    const res = await instantiate(wasm);
    const instance = res instanceof WebAssembly.Instance ? res : res.instance;
    const formatGreeting = instance.exports.formatGreeting as (
      name: string,
      count: number,
    ) => string;

    assert.equal(
      formatGreeting('Alice', 42),
      'Hello Alice, you have 42 messages!',
    );
  });
});
