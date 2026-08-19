// Recursive fib(27) in AssemblyScript.
function fib(n: i32): i32 {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

export function main(): i32 {
  return fib(27);
}
