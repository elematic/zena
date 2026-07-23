import {performance} from 'perf_hooks';

const filter = process.argv[2] || '';

const runTest = (name, testFunc) => {
  if (filter && !name.includes(filter)) {
    return;
  }
  // Warm up
  testFunc();

  const start = performance.now();
  testFunc();
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(2)} ms`);
};

console.log('==============================================');
console.log('Running Node.js Map Benchmarks (V8)...');
if (filter) {
  console.log('Filter: ' + filter);
}
console.log('==============================================');

// 1. HashMap String Insertion (N=50,000)
runTest('HashMapInsertString (N=50,000)', () => {
  const map = new Map();
  for (let i = 0; i < 50000; i++) {
    const key = 'key_' + i;
    map.set(key, i);
  }
});

// 2. HashMap String Lookup (N=100,000)
runTest('HashMapLookupString (N=100,000)', () => {
  const map = new Map();
  const keys = [];
  for (let i = 0; i < 10000; i++) {
    const key = 'key_' + i;
    keys.push(key);
    map.set(key, i);
  }

  let sum = 0;
  for (let j = 0; j < 10; j++) {
    for (let k = 0; k < 10000; k++) {
      const key = keys[k];
      if (map.has(key)) {
        sum = sum + map.get(key);
      }
    }
  }
  if (sum !== 499950000) {
    console.log('Error in sum: ' + sum);
  }
});

// 3. HashMap Integer Insertion (N=50,000)
runTest('HashMapInsertInt (N=50,000)', () => {
  const map = new Map();
  for (let i = 0; i < 50000; i++) {
    map.set(i, i);
  }
});

// 4. HashMap Integer Lookup (N=100,000)
runTest('HashMapLookupInt (N=100,000)', () => {
  const map = new Map();
  for (let i = 0; i < 10000; i++) {
    map.set(i, i);
  }

  let sum = 0;
  for (let j = 0; j < 10; j++) {
    for (let k = 0; k < 10000; k++) {
      if (map.has(k)) {
        sum = sum + map.get(k);
      }
    }
  }
  if (sum !== 499950000) {
    console.log('Error in sum: ' + sum);
  }
});

// 5. OrderedMap String Insertion (N=50,000)
runTest('OrderedMapInsertString (N=50,000)', () => {
  // In JS, Map is ordered by insertion order, so we run the same test
  const map = new Map();
  for (let i = 0; i < 50000; i++) {
    const key = 'key_' + i;
    map.set(key, i);
  }
});

// 6. OrderedMap String Lookup (N=100,000)
runTest('OrderedMapLookupString (N=100,000)', () => {
  const map = new Map();
  const keys = [];
  for (let i = 0; i < 10000; i++) {
    const key = 'key_' + i;
    keys.push(key);
    map.set(key, i);
  }

  let sum = 0;
  for (let j = 0; j < 10; j++) {
    for (let k = 0; k < 10000; k++) {
      const key = keys[k];
      if (map.has(key)) {
        sum = sum + map.get(key);
      }
    }
  }
  if (sum !== 499950000) {
    console.log('Error in sum: ' + sum);
  }
});

console.log('----------------------------------------------');
