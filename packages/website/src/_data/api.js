import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const generated = join(__dirname, '..', '..', '_generated', 'stdlib-api.json');

/**
 * The standard library's extracted API.
 *
 * `scripts/generate-api.js` produces the file this reads, and Wireit runs
 * that before Eleventy. A missing file means someone ran Eleventy directly;
 * the pages then build empty rather than failing, which is easier to
 * diagnose than a stack trace from a template.
 */
const load = () => {
  try {
    return JSON.parse(readFileSync(generated, 'utf8'));
  } catch {
    console.warn(
      `No ${generated}; the stdlib reference will be empty. ` +
        'Run `npm run build -w @zena-lang/website`.',
    );
    return {zenadoc: 1, package: {name: 'zena'}, modules: []};
  }
};

const docs = load();

/** Members grouped the way a page shows them. */
const MEMBER_ORDER = [
  'constructor',
  'field',
  'getter',
  'setter',
  'method',
  'operator',
  'variant',
  'enumMember',
];

const byKind = (members = []) =>
  [...members].sort(
    (a, b) => MEMBER_ORDER.indexOf(a.kind) - MEMBER_ORDER.indexOf(b.kind),
  );

/**
 * Declarations grouped by kind, in the order a reader wants them: the
 * types a module is about, then the functions over them, then the
 * aliases and constants.
 */
const KIND_GROUPS = [
  {kind: 'class', title: 'Classes'},
  {kind: 'interface', title: 'Interfaces'},
  {kind: 'mixin', title: 'Mixins'},
  {kind: 'enum', title: 'Enums'},
  {kind: 'typeAlias', title: 'Type aliases'},
  {kind: 'function', title: 'Functions'},
  {kind: 'variable', title: 'Variables'},
  {kind: 'symbol', title: 'Symbols'},
];

const groupsFor = (declarations) =>
  KIND_GROUPS.map(({kind, title}) => ({
    kind,
    title,
    declarations: declarations
      .filter((d) => d.kind === kind)
      .map((d) => ({...d, members: byKind(d.members)})),
  })).filter((group) => group.declarations.length > 0);

/** Every declaration id, so a type reference can be linked when it names one. */
const index = new Map();
for (const module of docs.modules) {
  for (const declaration of module.declarations ?? []) {
    index.set(declaration.name, {
      module: module.name,
      anchor: declaration.anchor,
    });
  }
}

export default {
  ...docs,
  stdlib: docs.modules.map((module) => ({
    ...module,
    url: `/reference/stdlib/${module.name}/`,
    groups: groupsFor(module.declarations ?? []),
    count: (module.declarations ?? []).length,
  })),
  /** name → {module, anchor}, for linking a type reference to its page. */
  index: Object.fromEntries(index),
};
