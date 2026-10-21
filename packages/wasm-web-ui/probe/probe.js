import {readFileSync} from 'node:fs';

const bytes = readFileSync(new URL('./probe.wasm', import.meta.url));
const module = await WebAssembly.compile(bytes, {
  builtins: ['js-string'],
  importedStringConstants: '_',
});
console.log('imports:', WebAssembly.Module.imports(module));
console.log(
  'exports:',
  WebAssembly.Module.exports(module).map((e) => e.name),
);

const importObject = {};
for (const imp of WebAssembly.Module.imports(module)) {
  if (imp.module === 'wasm:js-string' || imp.module === '_') continue;
  importObject[imp.module] ??= {};
  importObject[imp.module][imp.name] = (...args) => {
    console.log('import called', imp.module, imp.name, args);
    return null;
  };
}
const {exports} = await WebAssembly.instantiate(module, importObject);

const r1 = exports.render('Ada', 41);
const r2 = exports.render('Grace', 42);
const s1 = exports.resultStrings(r1);
const s2 = exports.resultStrings(r2);
console.log('strings identity ===', s1 === s2, 'typeof', typeof s1);
const wm = new WeakMap();
wm.set(s1, 'cached');
console.log('WeakMap hit on second result', wm.get(s2));
console.log('strings count', exports.stringsCount(s1));
for (let i = 0; i < exports.stringsCount(s1); i++) {
  console.log('  ', JSON.stringify(exports.stringsAt(s1, i)));
}
const n = exports.valueCount(r1);
for (let i = 0; i < n; i++) {
  const kind = exports.valueKind(r1, i);
  const ref = kind === 1 ? exports.valueExtern(r1, i) : exports.valueRef(r1, i);
  if (kind === 1) console.log('  text value:', JSON.stringify(ref));
  console.log(
    'value',
    i,
    'kind',
    kind,
    'ref',
    typeof ref,
    kind === 2 ? exports.valueNumber(r1, i) : '',
  );
  if (kind === 5) {
    const c = exports.listCount(ref);
    console.log('  list of', c);
    for (let j = 0; j < c; j++) {
      const item = exports.listRef(ref, j);
      const is = exports.resultStrings(item);
      console.log(
        '  item strings identical across items:',
        is === exports.resultStrings(exports.listRef(ref, 0)),
      );
    }
  }
  if (kind === 6) {
    const ev = {type: 'click'};
    exports.invoke(ref, ev);
    exports.invoke(ref, ev);
    console.log('  clicks after invoking twice', exports.clickCount());
  }
}
const obj = {host: true};
console.log('echo identity', exports.echo(obj) === obj);
