/**
 * Groups the functions size-report.js lists into categories. Run from
 * the repository root on the report's output:
 *
 *     node probe/size-report.js probe/demo-g-O2.wasm | node probe/size-categories.js
 */
import {readFileSync} from 'node:fs';
const lines = readFileSync(0, 'utf8').split('\n');
const categories = [
  [
    'number parsing (attribute text → number)',
    /^(parseF64|decimalToF64|pow10Borrow|uscale|packF64|unpackF64|unpackF32|addCarry)$/,
  ],
  [
    'number formatting (css values)',
    /^(formatDecimal|shortestDigits|floatToStringImpl|writeI32|nonFiniteToString)$/,
  ],
  [
    'string building (asciiLower, css, StringBuilder)',
    /^(StringBuilder_|GrowableArray_s\d+_arr_u8|String_s\d+\.(copyBytesTo|fromByteArray)|asciiLower|css$)/,
  ],
  [
    'Iterable vtable members never called',
    /(FilteredIterable|FilterIterator|GrowableArray_s\d+_TemplateValue.*\.(contains|find|all|some|filter)$|_trampoline$)/,
  ],
  ['GrowableArray specializations (other)', /^GrowableArray(Iterator)?_s\d+_/],
  ['protocol accessor exports', /^webui_/],
  [
    'property registration and decorator context',
    /^(registerProperty|closure_impl_core|defineElement|declareElement|ElementDefinition_|propertyKind|kindOf|kindOfBox|boxNumber|setHostProperty|setNumberProperty|applyAttribute|removeAttribute|\$erasedEq|valueAt)|_context_|\.(get|set)#/,
  ],
  [
    'the three elements (user code)',
    /^(Counter_|TodoList_|Badge_|closure_impl_elements|function_adapt_elements)/,
  ],
  ['start (string constants, probe instances)', /^__start$/],
  ['other', /./],
];
const totals = new Map(
  categories.map(([name]) => [name, {bytes: 0, count: 0}]),
);
let inFunctions = false;
for (const line of lines) {
  if (line.startsWith('functions:')) {
    inFunctions = true;
    continue;
  }
  if (!inFunctions) continue;
  const m = /^\s*(\d+)\s+(.+)$/.exec(line);
  if (!m) continue;
  const size = Number(m[1]);
  const name = m[2];
  for (const [cat, re] of categories) {
    if (re.test(name)) {
      const t = totals.get(cat);
      t.bytes += size;
      t.count += 1;
      break;
    }
  }
}
let all = 0;
for (const [cat, t] of totals) {
  all += t.bytes;
  console.log(
    `${String(t.bytes).padStart(6)}  ${String(t.count).padStart(3)} fns  ${cat}`,
  );
}
console.log(`${String(all).padStart(6)}  total code`);
