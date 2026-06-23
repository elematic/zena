import {performance} from 'perf_hooks';

const filter = process.argv[2] || '';

const runTest = (name, testFunc) => {
  if (filter && !name.includes(filter)) {
    return;
  }
  // Warm up the JIT compiler
  testFunc();

  const start = performance.now();
  testFunc();
  const end = performance.now();
  console.log(`${name}: ${(end - start).toFixed(2)} ms`);
};

const fibRecursive = (n) => {
  if (n <= 1) {
    return n;
  }
  return fibRecursive(n - 1) + fibRecursive(n - 2);
};

const fibIterative = (n) => {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const temp = (a + b) % 1000000;
    a = b;
    b = temp;
  }
  return a;
};

const add = (a, b) => a + b;

const testSimpleCall = (n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = add(sum, 1);
  }
  return sum;
};

console.log('==============================================');
console.log('Running Node.js Basic Benchmarks (V8)...');
if (filter) {
  console.log('Filter: ' + filter);
}
console.log('==============================================');

// 1. Recursive Fibonacci (N=35)
runTest('FibonacciRecursive35', () => {
  const res = fibRecursive(35);
  if (res !== 9227465) {
    console.log('Error in fibRecursive(35): ' + res);
  }
});

// 2. Recursive Fibonacci (N=40)
runTest('FibonacciRecursive40', () => {
  const res = fibRecursive(40);
  if (res !== 102334155) {
    console.log('Error in fibRecursive(40): ' + res);
  }
});

// 3. Iterative Fibonacci (N=10,000,000)
runTest('FibonacciIterative (N=10,000,000)', () => {
  const res = fibIterative(10000000);
  if (res !== 820001) {
    console.log('Error in fibIterative(10,000,000): ' + res);
  }
});

// 4. Simple Function Calls (N=10,000,000)
runTest('FunctionCallSimple (N=10,000,000)', () => {
  const res = testSimpleCall(10000000);
  if (res !== 10000000) {
    console.log('Error in FunctionCallSimple(10,000,000): ' + res);
  }
});

console.log('----------------------------------------------');
