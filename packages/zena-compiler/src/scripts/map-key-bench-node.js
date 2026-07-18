import {performance} from 'perf_hooks';

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
console.log('Running Node.js Map Key Benchmarks (V8)...');
if (filter) {
  console.log('Filter: ' + filter);
}
console.log('==============================================');

const classNames = [];
const interfaceNames = [];
const memberNames = [];

for (let i = 0; i < 100; i++) {
  classNames.push('Class' + i);
  interfaceNames.push('Interface' + i);
  memberNames.push('member' + i);
}

// Helper to run 2-part string key Map lookups
const runMapStringKey2 = () => {
  const map = new Map();

  // Insert 10,000 keys
  for (let i = 0; i < 100; i++) {
    const cName = classNames[i];
    for (let j = 0; j < 100; j++) {
      const key = cName + '::' + interfaceNames[j];
      map.set(key, i * 100 + j);
    }
  }

  // Look up 100,000 keys on the fly
  let sum = 0;
  for (let k = 0; k < 100000; k++) {
    const key =
      classNames[k % 100] + '::' + interfaceNames[Math.floor(k / 100) % 100];
    if (map.has(key)) {
      sum = sum + map.get(key);
    }
  }
  if (sum !== 499950000) {
    console.log('Error in sum: ' + sum);
  }
};

// Helper to run 3-part string key Map lookups
const runMapStringKey3 = () => {
  const map = new Map();

  // Insert 8,000 keys
  for (let i = 0; i < 20; i++) {
    const cName = classNames[i];
    for (let j = 0; j < 20; j++) {
      const iName = interfaceNames[j];
      for (let l = 0; l < 20; l++) {
        const key = cName + '::' + iName + '_' + memberNames[l];
        map.set(key, i * 400 + j * 20 + l);
      }
    }
  }

  // Look up 80,000 keys on the fly
  let sum = 0;
  for (let k = 0; k < 80000; k++) {
    const key =
      classNames[k % 20] +
      '::' +
      interfaceNames[Math.floor(k / 20) % 20] +
      '_' +
      memberNames[Math.floor(k / 400) % 20];
    if (map.has(key)) {
      sum = sum + map.get(key);
    }
  }
  if (sum !== 319960000) {
    console.log('Error in sum: ' + sum);
  }
};

// 1. MapStringKey2
runTest('MapStringKey2 (N=100,000)', runMapStringKey2);

// 2. MapCustomKey2 (Idiomatic JS: string keys in Map)
runTest('MapCustomKey2 (N=100,000)', runMapStringKey2);

// 3. MapCaseKey2 (Idiomatic JS: string keys in Map)
runTest('MapCaseKey2 (N=100,000)', runMapStringKey2);

// 4. MapStringKey3
runTest('MapStringKey3 (N=80,000)', runMapStringKey3);

// 5. MapCustomKey3 (Idiomatic JS: string keys in Map)
runTest('MapCustomKey3 (N=80,000)', runMapStringKey3);

// 6. MapCaseKey3 (Idiomatic JS: string keys in Map)
runTest('MapCaseKey3 (N=80,000)', runMapStringKey3);

console.log('----------------------------------------------');
