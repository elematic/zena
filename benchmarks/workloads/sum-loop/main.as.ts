// Sum loop AssemblyScript benchmark.
export function main(): i32 {
  let sum: i32 = 0;
  let i: i32 = 0;
  while (i < 5000000) {
    if (i % 3 == 0) {
      sum += i % 7;
    } else {
      sum -= i % 5;
    }
    i += 1;
  }
  return sum % 256;
}
