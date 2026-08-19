// Sieve of Eratosthenes AssemblyScript benchmark.
export function main(): i32 {
  const n: i32 = 300000;
  const composite = new Uint8Array(n + 1);
  let count: i32 = 0;
  for (let i: i32 = 2; i <= n; i++) {
    if (composite[i] == 0) {
      count++;
      for (let j: i32 = i + i; j <= n; j += i) {
        composite[j] = 1;
      }
    }
  }
  return count % 256;
}
