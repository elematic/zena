import assert from 'node:assert';
import {suite, test} from 'node:test';
import {compileAndInstantiate, compileAndRun} from './utils.js';

suite('CodeGenerator - Break and Continue', () => {
  suite('break statement', () => {
    test('should break out of while loop', async () => {
      const input = `
        export let findFirst = (limit: i32) => {
          var i = 0;
          while (i < limit) {
            if (i == 5) {
              break;
            }
            i = i + 1;
          }
          return i;
        };
      `;
      const {findFirst} = (await compileAndInstantiate(input)) as {
        findFirst: (limit: number) => number;
      };
      assert.strictEqual(findFirst(10), 5);
      assert.strictEqual(findFirst(3), 3); // Loop exits naturally
    });

    test('should break out of for loop', async () => {
      const input = `
        export let sumUntil = (limit: i32) => {
          var sum = 0;
          for (var i = 0; i < 100; i = i + 1) {
            if (i >= limit) {
              break;
            }
            sum = sum + i;
          }
          return sum;
        };
      `;
      const {sumUntil} = (await compileAndInstantiate(input)) as {
        sumUntil: (limit: number) => number;
      };
      assert.strictEqual(sumUntil(5), 10); // 0+1+2+3+4 = 10
      assert.strictEqual(sumUntil(0), 0);
    });

    test('should break from nested if inside while', async () => {
      const input = `
        export let findMultipleOf3 = (start: i32, limit: i32) => {
          var i = start;
          while (i < limit) {
            if (i > 0) {
              var mod = i - ((i / 3) as i32) * 3;
              if (mod == 0) {
                break;
              }
            }
            i = i + 1;
          }
          return i;
        };
      `;
      const {findMultipleOf3} = (await compileAndInstantiate(input)) as {
        findMultipleOf3: (start: number, limit: number) => number;
      };
      assert.strictEqual(findMultipleOf3(1, 10), 3);
      assert.strictEqual(findMultipleOf3(4, 10), 6);
    });

    test('should break from innermost loop only', async () => {
      const input = `
        export let countBreaks = () => {
          var outerCount = 0;
          var innerCount = 0;
          var i = 0;
          while (i < 3) {
            outerCount = outerCount + 1;
            var j = 0;
            while (j < 10) {
              innerCount = innerCount + 1;
              if (j == 2) {
                break;
              }
              j = j + 1;
            }
            i = i + 1;
          }
          // outerCount should be 3, innerCount should be 9 (3 iterations * 3 each before break)
          return outerCount * 100 + innerCount;
        };
      `;
      const result = await compileAndRun(input, 'countBreaks');
      assert.strictEqual(result, 309); // 3 * 100 + 9
    });
  });

  suite('continue statement', () => {
    test('should continue in while loop', async () => {
      const input = `
        export let sumEven = (limit: i32) => {
          var sum = 0;
          var i = 0;
          while (i < limit) {
            i = i + 1;
            if (i - ((i / 2) as i32) * 2 != 0) {
              continue;
            }
            sum = sum + i;
          }
          return sum;
        };
      `;
      const {sumEven} = (await compileAndInstantiate(input)) as {
        sumEven: (limit: number) => number;
      };
      assert.strictEqual(sumEven(10), 30); // 2+4+6+8+10 = 30
      assert.strictEqual(sumEven(5), 6); // 2+4 = 6
    });

    test('should continue in for loop', async () => {
      const input = `
        export let sumOdd = (limit: i32) => {
          var sum = 0;
          for (var i = 0; i < limit; i = i + 1) {
            if (i - ((i / 2) as i32) * 2 == 0) {
              continue;
            }
            sum = sum + i;
          }
          return sum;
        };
      `;
      const {sumOdd} = (await compileAndInstantiate(input)) as {
        sumOdd: (limit: number) => number;
      };
      assert.strictEqual(sumOdd(10), 25); // 1+3+5+7+9 = 25
      assert.strictEqual(sumOdd(5), 4); // 1+3 = 4
    });

    test('should continue from nested if inside while', async () => {
      const input = `
        export let countNonMultiplesOf3 = (limit: i32) => {
          var count = 0;
          var i = 0;
          while (i < limit) {
            i = i + 1;
            if (i > 0) {
              var mod = i - ((i / 3) as i32) * 3;
              if (mod == 0) {
                continue;
              }
            }
            count = count + 1;
          }
          return count;
        };
      `;
      const {countNonMultiplesOf3} = (await compileAndInstantiate(input)) as {
        countNonMultiplesOf3: (limit: number) => number;
      };
      assert.strictEqual(countNonMultiplesOf3(9), 6); // 1,2,4,5,7,8 = 6 numbers
      assert.strictEqual(countNonMultiplesOf3(3), 2); // 1,2 = 2 numbers
    });

    test('should continue in innermost loop only', async () => {
      const input = `
        export let testNestedContinue = () => {
          var total = 0;
          var i = 0;
          while (i < 3) {
            var j = 0;
            while (j < 5) {
              j = j + 1;
              if (j == 2) {
                continue;
              }
              total = total + 1;
            }
            i = i + 1;
          }
          // 3 outer iterations, each with 5 inner iterations minus 1 skipped = 4 each
          return total;
        };
      `;
      const result = await compileAndRun(input, 'testNestedContinue');
      assert.strictEqual(result, 12); // 3 * 4 = 12
    });
  });

  suite('break and continue together', () => {
    test('should handle both break and continue in same loop', async () => {
      const input = `
        export let sumUntilBreakSkipOdd = (limit: i32) => {
          var sum = 0;
          var i = 0;
          while (true) {
            i = i + 1;
            if (i > limit) {
              break;
            }
            if (i - ((i / 2) as i32) * 2 != 0) {
              continue;
            }
            sum = sum + i;
          }
          return sum;
        };
      `;
      const {sumUntilBreakSkipOdd} = (await compileAndInstantiate(input)) as {
        sumUntilBreakSkipOdd: (limit: number) => number;
      };
      assert.strictEqual(sumUntilBreakSkipOdd(10), 30); // 2+4+6+8+10 = 30
    });

    test('should handle break and continue in nested loops', async () => {
      const input = `
        export let matrixSum = () => {
          var sum = 0;
          var i = 0;
          while (i < 5) {
            i = i + 1;
            if (i == 3) {
              continue; // Skip row 3
            }
            var j = 0;
            while (j < 5) {
              j = j + 1;
              if (j == 4) {
                break; // Stop at column 4
              }
              sum = sum + 1;
            }
          }
          // 4 rows (skipping row 3), each with 3 columns (stopping at 4) = 12
          return sum;
        };
      `;
      const result = await compileAndRun(input, 'matrixSum');
      assert.strictEqual(result, 12);
    });
  });

  suite('edge cases', () => {
    test('should break immediately', async () => {
      const input = `
        export let breakImmediate = () => {
          var count = 0;
          while (true) {
            break;
            count = count + 1;
          }
          return count;
        };
      `;
      const result = await compileAndRun(input, 'breakImmediate');
      assert.strictEqual(result, 0);
    });

    test('should continue at end of loop (no effect)', async () => {
      const input = `
        export let continueAtEnd = () => {
          var count = 0;
          var i = 0;
          while (i < 3) {
            i = i + 1;
            count = count + 1;
            continue;
          }
          return count;
        };
      `;
      const result = await compileAndRun(input, 'continueAtEnd');
      assert.strictEqual(result, 3);
    });

    test('should handle break in for loop without test', async () => {
      const input = `
        export let infiniteForBreak = () => {
          var count = 0;
          for (var i = 0; ; i = i + 1) {
            count = count + 1;
            if (count >= 5) {
              break;
            }
          }
          return count;
        };
      `;
      const result = await compileAndRun(input, 'infiniteForBreak');
      assert.strictEqual(result, 5);
    });
  });
});
