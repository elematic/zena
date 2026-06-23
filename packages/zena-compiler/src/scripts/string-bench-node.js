import {performance} from 'perf_hooks';

class JSStringBuilder {
  constructor() {
    this.chunks = [];
    this.currentChunk = new Uint8Array(16);
    this.currentPos = 0;
    this.totalLength = 0;
  }

  appendByte(b) {
    if (this.currentPos < this.currentChunk.length) {
      this.currentChunk[this.currentPos] = b;
      this.currentPos++;
      return this;
    }
    this.chunks.push(this.currentChunk);
    this.totalLength += this.currentChunk.length;
    const newCapacity = this.currentChunk.length * 2;
    this.currentChunk = new Uint8Array(newCapacity);
    this.currentChunk[0] = b;
    this.currentPos = 1;
    return this;
  }

  toString() {
    const len = this.totalLength + this.currentPos;
    const res = new Uint8Array(len);
    let offset = 0;
    for (const chunk of this.chunks) {
      res.set(chunk, offset);
      offset += chunk.length;
    }
    res.set(this.currentChunk.subarray(0, this.currentPos), offset);
    return new TextDecoder().decode(res);
  }
}

const filter = process.argv[2] || '';

const runTest = (name, testFunc) => {
  if (filter && !name.includes(filter)) {
    return;
  }
  const start = performance.now();
  testFunc();
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(2)} ms`);
};

console.log('==============================================');
console.log('Running Node.js String Benchmarks (V8)...');
if (filter) {
  console.log('Filter: ' + filter);
}
console.log('==============================================');

// 1. Concatenation via + (with flattening check)
runTest('StringConcatPlus (N=10,000)', () => {
  let s = '';
  for (let i = 0; i < 10000; i++) {
    s = s + 'a';
  }
  // Access character to force V8 to flatten ConsStrings
  const c = s.charCodeAt(s.length - 1);
  if (s.length !== 10000 || c !== 97) {
    console.log('Error in length!');
  }
});

// 1b. Concatenation via + with explicit flattening (N=10,000)
runTest('StringConcatPlusFlatten (N=10,000)', () => {
  let s = '';
  for (let i = 0; i < 10000; i++) {
    s = s + 'a';
  }
  const buf = Buffer.from(s, 'utf-8');
  if (s.length !== 10000 || buf.length !== 10000) {
    console.log('Error in length!');
  }
});

// 2. Concatenation via Join / Builder (N=10,000)
runTest('StringConcatBuilder (N=10,000)', () => {
  const arr = [];
  for (let i = 0; i < 10000; i++) {
    arr.push('a');
  }
  const s = arr.join('');
  if (s.length !== 10000) {
    console.log('Error in length!');
  }
});

// 2b. Concatenation via Join / Builder (N=100,000)
runTest('StringConcatBuilder (N=100,000)', () => {
  const arr = [];
  for (let i = 0; i < 100000; i++) {
    arr.push('a');
  }
  const s = arr.join('');
  if (s.length !== 100000) {
    console.log('Error in length!');
  }
});

// 2c. Concatenation via growable StringBuilder (appendByte, N=100,000)
runTest('StringConcatBuilderByte (N=100,000)', () => {
  const sb = new JSStringBuilder();
  for (let i = 0; i < 100000; i++) {
    sb.appendByte(97); // 'a'
  }
  const s = sb.toString();
  if (s.length !== 100000) {
    console.log('Error in length!');
  }
});

// 2d. Direct Uint8Array write (N=100,000)
runTest('StringDirectByteArray (N=100,000)', () => {
  const buf = new Uint8Array(100000);
  for (let i = 0; i < 100000; i++) {
    buf[i] = 97; // 'a'
  }
  const s = new TextDecoder().decode(buf);
  if (s.length !== 100000) {
    console.log('Error in length!');
  }
});

// 3. Slicing
runTest('StringSlicing (N=100,000)', () => {
  let base = '';
  for (let i = 0; i < 100; i++) {
    base = base + 'abcdefghij';
  }

  let lenSum = 0;
  for (let j = 0; j < 100000; j++) {
    const offset = (j % 90) * 10;
    const s = base.slice(offset, offset + 10);
    lenSum = lenSum + s.length;
  }
  if (lenSum !== 1000000) {
    console.log('Error in lenSum!');
  }
});

// 4. Comparison
runTest('StringComparison (N=100,000)', () => {
  const s1 = 'abcdefghijklmnopqrstuvwxyz';
  const s2 = 'abcdefghijklmnopqrstuvwxyz';
  const s3 = 'abcdefghijklmnopqrstuvwxyA';
  const s4 = 'Abcdefghijklmnopqrstuvwxyz';

  for (let j = 0; j < 100000; j++) {
    // 1. Reference equality (pointer check)
    const refEq = s1 === s1;
    // 2. Structural equality (same content, different instance)
    const structEq = s1 === s2;
    // 3. Structural difference at final character
    const diffEnd = s1 === s3;
    // 4. Structural difference at first character
    const diffStart = s1 === s4;
  }
});

// 5. Searching
runTest('StringSearch (N=10,000)', () => {
  let base = '';
  for (let i = 0; i < 1000; i++) {
    base = base + 'abcdefghijklmnopqrstuvwxyz'; // 26,000 chars
  }
  const needle = 'wxyz';

  for (let j = 0; j < 10000; j++) {
    const hasNeedle = base.includes(needle);
    const startsWith = base.startsWith('abc');
    const endsWith = base.endsWith('xyz');
  }
});

// 6. Map lookups with String keys
runTest('StringMapIndexing (N=10,000)', () => {
  const map = new Map();

  // Generate distinct string keys
  const keys = [];
  for (let i = 0; i < 1000; i++) {
    const key = 'key_' + i;
    keys.push(key);
    map.set(key, i);
  }

  let sum = 0;
  for (let j = 0; j < 10; j++) {
    for (let k = 0; k < 1000; k++) {
      const key = keys[k];
      if (map.has(key)) {
        sum = sum + map.get(key);
      }
    }
  }
  if (sum !== 499500 * 10) {
    console.log('Error in sum calculation: ' + sum);
  }
});

console.log('----------------------------------------------');
