// Node baseline for the sieve workload; self-reports inner ms.
const t0 = process.hrtime.bigint();
const n = 300000;
const composite = new Uint8Array(n + 1);
let count = 0;
for (let i = 2; i <= n; i++) {
  if (!composite[i]) {
    count++;
    for (let j = i + i; j <= n; j += i) composite[j] = 1;
  }
}
const t1 = process.hrtime.bigint();
if (count === -1) console.error('defeats DCE');
console.log(String(Number(t1 - t0) / 1e6));
