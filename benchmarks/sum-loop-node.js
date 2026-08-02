// Node baseline for the sum-loop workload; self-reports inner ms.
const t0 = process.hrtime.bigint();
let sum = 0;
for (let i = 0; i < 5000000; i++) {
  if (i % 3 === 0) sum += i % 7;
  else sum -= i % 5;
}
const t1 = process.hrtime.bigint();
if (sum === Number.MIN_SAFE_INTEGER) console.error('defeats DCE');
console.log(String(Number(t1 - t0) / 1e6));
