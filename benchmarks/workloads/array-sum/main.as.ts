// Array sum AssemblyScript benchmark.
export function main(): i32 {
  let xs = [1, 2, 3];
  let total: i32 = 0;
  for (let i = 0; i < xs.length; i++) {
    total += xs[i];
  }
  return total;
}
