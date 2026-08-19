// Node baseline for the fib workload. Self-reports the measured region in
// milliseconds as the last stdout line, so `zena-cli bench` excludes Node
// startup — the process-spawn round-robin unit, Tachometer-style.
function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
const t0 = process.hrtime.bigint();
const result = fib(27);
const t1 = process.hrtime.bigint();
if (result === -1) console.error('unreachable, defeats DCE');
// String() so Node never wraps the number in ANSI color escapes.
console.log(String(Number(t1 - t0) / 1e6));
