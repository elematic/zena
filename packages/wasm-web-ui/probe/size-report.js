/**
 * Where the bytes of a module go. Reads a module built with `-g` (so the
 * name section names the functions) and prints: section sizes, the
 * import and export lists with their byte cost, the type section by
 * kind, and every function's code size, named. Run from the repository
 * root:
 *
 *     node packages/wasm-web-ui/probe/size-report.js probe/demo-g-O2.wasm
 */
import {readFileSync} from 'node:fs';

const bytes = new Uint8Array(readFileSync(process.argv[2]));
let pos = 8;
const u32 = () => {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
};
const s33 = () => {
  let result = 0;
  let shift = 0;
  let b;
  do {
    b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  if (shift < 32 && b & 0x40) result |= -1 << shift;
  return result;
};
const name = () => {
  const len = u32();
  const s = new TextDecoder().decode(bytes.subarray(pos, pos + len));
  pos += len;
  return s;
};

const sections = [];
const funcNames = new Map();
const typeNames = new Map();
let importedFuncs = 0;
const imports = [];
const exportsList = [];
let codeSizes = [];
let typeKinds = {struct: 0, array: 0, func: 0, recGroups: 0, subtyped: 0};
let globals = [];

const skipValType = () => {
  const b = bytes[pos++];
  if (b === 0x63 || b === 0x64) {
    // ref null ht / ref ht
    s33();
  }
};
const skipStorageType = () => {
  const b = bytes[pos];
  if (b === 0x78 || b === 0x77) {
    pos++;
  } else {
    skipValType();
  }
};
const parseFieldType = () => {
  skipStorageType();
  pos++; // mutability
};
const parseSubType = () => {
  let b = bytes[pos];
  if (b === 0x50 || b === 0x4f) {
    pos++;
    const n = u32();
    if (n > 0) typeKinds.subtyped++;
    for (let i = 0; i < n; i++) u32();
    b = bytes[pos];
  }
  pos++;
  if (b === 0x60) {
    typeKinds.func++;
    const np = u32();
    for (let i = 0; i < np; i++) skipValType();
    const nr = u32();
    for (let i = 0; i < nr; i++) skipValType();
  } else if (b === 0x5f) {
    typeKinds.struct++;
    const nf = u32();
    for (let i = 0; i < nf; i++) parseFieldType();
  } else if (b === 0x5e) {
    typeKinds.array++;
    parseFieldType();
  } else {
    throw new Error(`type form 0x${b.toString(16)} at ${pos}`);
  }
};

while (pos < bytes.length) {
  const id = bytes[pos++];
  const size = u32();
  const start = pos;
  const end = pos + size;
  let label = `section ${id}`;
  if (id === 0) {
    const n = name();
    label = `custom "${n}"`;
    if (n === 'name') {
      while (pos < end) {
        const sub = bytes[pos++];
        const subSize = u32();
        const subEnd = pos + subSize;
        if (sub === 1) {
          const n = u32();
          for (let i = 0; i < n; i++) funcNames.set(u32(), name());
        } else if (sub === 4) {
          const n = u32();
          for (let i = 0; i < n; i++) typeNames.set(u32(), name());
        }
        pos = subEnd;
      }
    }
  } else if (id === 1) {
    label = 'types';
    const n = u32();
    for (let i = 0; i < n; i++) {
      if (bytes[pos] === 0x4e) {
        pos++;
        typeKinds.recGroups++;
        const m = u32();
        for (let j = 0; j < m; j++) parseSubType();
      } else {
        parseSubType();
      }
    }
  } else if (id === 2) {
    label = 'imports';
    const n = u32();
    for (let i = 0; i < n; i++) {
      const s = pos;
      const mod = name();
      const field = name();
      const kind = bytes[pos++];
      if (kind === 0) {
        u32();
        importedFuncs++;
      } else if (kind === 3) {
        skipValType();
        pos++;
      } else {
        throw new Error(`import kind ${kind}`);
      }
      imports.push({mod, field, size: pos - s});
    }
  } else if (id === 7) {
    label = 'exports';
    const n = u32();
    for (let i = 0; i < n; i++) {
      const s = pos;
      const field = name();
      const kind = bytes[pos++];
      const index = u32();
      exportsList.push({field, kind, index, size: pos - s});
    }
  } else if (id === 6) {
    label = 'globals';
    const n = u32();
    for (let i = 0; i < n; i++) {
      const s = pos;
      skipValType();
      pos++;
      // skip the init expression up to `end` (0x0b) at depth 0; init
      // exprs here are constants, ref.func, ref.null, struct.new, array.new_fixed
      while (bytes[pos] !== 0x0b) pos++;
      pos++;
      globals.push(pos - s);
    }
  } else if (id === 10) {
    label = 'code';
    const n = u32();
    for (let i = 0; i < n; i++) {
      const s = pos;
      const bodySize = u32();
      pos += bodySize;
      codeSizes.push({index: importedFuncs + i, size: pos - s});
    }
  } else {
    label =
      {
        3: 'functions',
        4: 'tables',
        5: 'memories',
        8: 'start',
        9: 'elements',
        11: 'data',
        12: 'data count',
        13: 'tags',
      }[id] ?? label;
  }
  sections.push({label, size: end - start + 1 + (start - (start - 1))});
  pos = end;
}

const total = bytes.length;
console.log(`total ${total} bytes\n`);
console.log('sections:');
for (const s of sections)
  console.log(`  ${s.label.padEnd(20)} ${String(s.size).padStart(7)}`);

console.log(`\ntypes: ${JSON.stringify(typeKinds)}`);

const byModule = new Map();
for (const i of imports) {
  byModule.set(i.mod, (byModule.get(i.mod) ?? 0) + i.size);
}
console.log('\nimports by module (bytes):');
for (const [m, s] of byModule)
  console.log(
    `  ${m.padEnd(16)} ${String(s).padStart(6)}  ${imports.filter((i) => i.mod === m).length} entries`,
  );
if (process.argv.includes('--imports')) {
  for (const i of imports) console.log(`    ${i.mod}.${i.field}`);
}

console.log('\nexports:');
let exportBytes = 0;
for (const e of exportsList) {
  exportBytes += e.size;
}
console.log(`  ${exportsList.length} exports, ${exportBytes} bytes`);
for (const e of exportsList) console.log(`    ${e.field} (${e.size} B)`);

console.log(
  `\nglobals: ${globals.length}, ${globals.reduce((a, b) => a + b, 0)} bytes`,
);

const named = codeSizes.map((c) => ({
  ...c,
  name: funcNames.get(c.index) ?? `func[${c.index}]`,
}));
named.sort((a, b) => b.size - a.size);
const codeTotal = named.reduce((a, c) => a + c.size, 0);
console.log(`\nfunctions: ${named.length}, ${codeTotal} bytes of code`);
for (const f of named)
  console.log(`  ${String(f.size).padStart(6)}  ${f.name}`);
