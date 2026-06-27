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
const addNoInline = (a, b) => {
  if (a < -1000000) {
    let x = a;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    x = x + 1;
    return x;
  }
  return a + b;
};

const testNoInlineCall = (n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = addNoInline(sum, 1);
  }
  return sum;
};
const makeClosure = (offset) => {
  return (x) => x + offset;
};

const runClosureBenchmark = (closure, n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = closure(sum);
  }
  return sum;
};

class BaseClass {
  getValue() {
    return 1;
  }
}

class SubClassOfBase extends BaseClass {
  getValue() {
    return 2;
  }
}

class BaseClassWithOverride {
  getValue() {
    return 1;
  }
}

class SubClassWithOverride extends BaseClassWithOverride {
  getValue() {
    return 2;
  }
}

class FinalClass {
  getValue() {
    return 1;
  }
}

class CastContainer {
  constructor(value) {
    this.value = value;
  }
}

class DirectContainer {
  constructor(value) {
    this.value = value;
  }
}

class CustomCollection {
  constructor(arr) {
    this.arr = arr;
  }
  [Symbol.iterator]() {
    let index = 0;
    const arr = this.arr;
    const len = arr.length;
    return {
      next() {
        if (index < len) {
          const value = arr[index];
          index++;
          return {done: false, value: value};
        }
        return {done: true, value: undefined};
      },
    };
  }
}

const runForLoopBenchmark = (arr) => {
  let sum = 0;
  const len = arr.length;
  for (let i = 0; i < len; i++) {
    sum = sum + arr[i];
  }
  return sum;
};

const runForOfArrayBenchmark = (arr) => {
  let sum = 0;
  for (const x of arr) {
    sum = sum + x;
  }
  return sum;
};

const runWhileArrayBenchmark = (arr) => {
  let sum = 0;
  const len = arr.length;
  let i = 0;
  while (i < len) {
    sum = sum + arr[i];
    i++;
  }
  return sum;
};

const runForOfArrayInterfaceBenchmark = (arr) => {
  let sum = 0;
  for (const x of arr) {
    sum = sum + x;
  }
  return sum;
};

const runForOfGrowableArrayBenchmark = (arr) => {
  let sum = 0;
  for (const x of arr) {
    sum = sum + x;
  }
  return sum;
};

const runForOfGrowableArrayInterfaceBenchmark = (arr) => {
  let sum = 0;
  for (const x of arr) {
    sum = sum + x;
  }
  return sum;
};

const runForOfImmutableArrayBenchmark = (arr) => {
  let sum = 0;
  for (const x of arr) {
    sum = sum + x;
  }
  return sum;
};

const runForOfImmutableArrayInterfaceBenchmark = (arr) => {
  let sum = 0;
  for (const x of arr) {
    sum = sum + x;
  }
  return sum;
};

const runForOfCustomBenchmark = (coll) => {
  let sum = 0;
  for (const x of coll) {
    sum = sum + x;
  }
  return sum;
};

const runDirectAccessBenchmark = (container, n) => {
  let lenSum = 0;
  for (let i = 0; i < n; i++) {
    const s = container.value;
    lenSum = lenSum + s.length;
  }
  return lenSum;
};

const runCastAccessBenchmark = (container, n) => {
  let lenSum = 0;
  for (let i = 0; i < n; i++) {
    const s = container.value;
    lenSum = lenSum + s.length;
  }
  return lenSum;
};

const runDevirtNoInferBenchmark = (obj, n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = sum + obj.getValue();
  }
  return sum;
};

const runDevirtInferBenchmark = (n) => {
  const obj = new BaseClass();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = sum + obj.getValue();
  }
  return sum;
};

const runDevirtNoInferOverrideBenchmark = (obj, n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = sum + obj.getValue();
  }
  return sum;
};

const runDevirtInferOverrideBenchmark = (n) => {
  const obj = new SubClassWithOverride();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = sum + obj.getValue();
  }
  return sum;
};

const runStaticCallBenchmark = (obj, n) => {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = sum + obj.getValue();
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

// 4. Function Call Benchmarks (N=10,000,000)
const closure = makeClosure(1);
runTest('FunctionCallSimple (N=10,000,000)', () => {
  const res = testSimpleCall(10000000);
  if (res !== 10000000) {
    console.log('Error in FunctionCallSimple(10,000,000): ' + res);
  }
});

runTest('FunctionCallNoInline (N=10,000,000)', () => {
  const res = testNoInlineCall(10000000);
  if (res !== 10000000) {
    console.log('Error in FunctionCallNoInline(10,000,000): ' + res);
  }
});

runTest('FunctionCallClosure (N=10,000,000)', () => {
  const res = runClosureBenchmark(closure, 10000000);
  if (res !== 10000000) {
    console.log('Error in FunctionCallClosure(10,000,000): ' + res);
  }
});

// 5. Loop Iteration Benchmarks (N=10,000 x 1,000)
const arr = new Array(1000).fill(1);
const growableArr = new Array(1000).fill(1);
const customColl = new CustomCollection(arr);
const immutableArr = arr;
runTest('LoopForLoop (N=10,000,000)', () => {
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    sum = sum + runForLoopBenchmark(arr);
  }
  if (sum !== 10000000) {
    console.log('Error in LoopForLoop: ' + sum);
  }
});

runTest('LoopWhileArray (N=10,000,000)', () => {
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    sum = sum + runWhileArrayBenchmark(arr);
  }
  if (sum !== 10000000) {
    console.log('Error in LoopWhileArray: ' + sum);
  }
});

runTest('LoopForInArray (N=10,000,000)', () => {
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    sum = sum + runForOfArrayBenchmark(arr);
  }
  if (sum !== 10000000) {
    console.log('Error in LoopForInArray: ' + sum);
  }
});

runTest('LoopForInArrayInterface (N=10,000,000)', () => {
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    sum = sum + runForOfArrayInterfaceBenchmark(arr);
  }
  if (sum !== 10000000) {
    console.log('Error in LoopForInArrayInterface: ' + sum);
  }
});

runTest('LoopForInGrowableArray (N=10,000,000)', () => {
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    sum = sum + runForOfGrowableArrayBenchmark(growableArr);
  }
  if (sum !== 10000000) {
    console.log('Error in LoopForInGrowableArray: ' + sum);
  }
});

runTest('LoopForInGrowableArrayInterface (N=10,000,000)', () => {
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    sum = sum + runForOfGrowableArrayInterfaceBenchmark(growableArr);
  }
  if (sum !== 10000000) {
    console.log('Error in LoopForInGrowableArrayInterface: ' + sum);
  }
});

runTest('LoopForInImmutableArray (N=10,000,000)', () => {
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    sum = sum + runForOfImmutableArrayBenchmark(immutableArr);
  }
  if (sum !== 10000000) {
    console.log('Error in LoopForInImmutableArray: ' + sum);
  }
});

runTest('LoopForInImmutableArrayInterface (N=10,000,000)', () => {
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    sum = sum + runForOfImmutableArrayInterfaceBenchmark(immutableArr);
  }
  if (sum !== 10000000) {
    console.log('Error in LoopForInImmutableArrayInterface: ' + sum);
  }
});

runTest('LoopForInCustom (N=10,000,000)', () => {
  let sum = 0;
  for (let i = 0; i < 10000; i++) {
    sum = sum + runForOfCustomBenchmark(customColl);
  }
  if (sum !== 10000000) {
    console.log('Error in LoopForInCustom: ' + sum);
  }
});

// 6. Cast Benchmarks (N=10,000,000)
const directCont = new DirectContainer('hello');
const castCont = new CastContainer('hello');
runTest('CastDirectAccess (N=10,000,000)', () => {
  const res = runDirectAccessBenchmark(directCont, 10000000);
  if (res !== 50000000) {
    console.log('Error in CastDirectAccess: ' + res);
  }
});

runTest('CastWithCastAccess (N=10,000,000)', () => {
  const res = runCastAccessBenchmark(castCont, 10000000);
  if (res !== 50000000) {
    console.log('Error in CastWithCastAccess: ' + res);
  }
});

// 7. Devirtualization Benchmarks (N=10,000,000)
const baseObj = new BaseClass();
const finalObj = new FinalClass();
runTest('DevirtNoInferCall (N=10,000,000)', () => {
  const res = runDevirtNoInferBenchmark(baseObj, 10000000);
  if (res !== 10000000) {
    console.log('Error in DevirtNoInferCall: ' + res);
  }
});

runTest('DevirtInferCall (N=10,000,000)', () => {
  const res = runDevirtInferBenchmark(10000000);
  if (res !== 10000000) {
    console.log('Error in DevirtInferCall: ' + res);
  }
});

const overrideObj = new SubClassWithOverride();
runTest('DevirtNoInferOverrideCall (N=10,000,000)', () => {
  const res = runDevirtNoInferOverrideBenchmark(overrideObj, 10000000);
  if (res !== 20000000) {
    console.log('Error in DevirtNoInferOverrideCall: ' + res);
  }
});

runTest('DevirtInferOverrideCall (N=10,000,000)', () => {
  const res = runDevirtInferOverrideBenchmark(10000000);
  if (res !== 20000000) {
    console.log('Error in DevirtInferOverrideCall: ' + res);
  }
});

runTest('DevirtStaticCall (N=10,000,000)', () => {
  const res = runStaticCallBenchmark(finalObj, 10000000);
  if (res !== 10000000) {
    console.log('Error in DevirtStaticCall: ' + res);
  }
});

console.log('----------------------------------------------');
