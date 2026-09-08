import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const generated = join(__dirname, '..', '..', '_generated', 'stdlib-api.json');

/**
 * The standard library's extracted API.
 *
 * `scripts/generate-api.js` produces the file this reads, and Wireit runs
 * that before Eleventy.
 *
 * A missing file fails the build. It used to warn and return an empty
 * model, and that silently shipped a site whose whole standard library
 * reference was gone — 46 pages down to none, with the only evidence a
 * line in the build log. There is no correct site to build without this
 * file, so not building one is the honest outcome.
 */
const load = () => {
  let source;
  try {
    source = readFileSync(generated, 'utf8');
  } catch (e) {
    throw new Error(
      `Cannot read ${generated}: ${e.message}\n` +
        'The standard library reference is generated from it. Run ' +
        '`npm run api -w @zena-lang/website` to produce it, or ' +
        '`npm run build -w @zena-lang/website`, which does that first.',
    );
  }
  const docs = JSON.parse(source);
  if (!Array.isArray(docs.modules) || docs.modules.length === 0) {
    throw new Error(
      `${generated} describes no modules. Extraction produced an empty ` +
        'package, which means the stdlib was not read.',
    );
  }
  return docs;
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

/** Where each declaration is published, by the id a type link carries. */
const pages = new Map();
for (const module of docs.modules) {
  for (const declaration of module.declarations ?? []) {
    pages.set(
      declaration.id,
      `/reference/stdlib/${module.name}/#${declaration.anchor}`,
    );
  }
}

const escape = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;');

/**
 * A type as HTML, with the spans that name a documented declaration
 * turned into links.
 *
 * The extractor reports offsets rather than a type tree, so rendering
 * Zena's type syntax happens once in the extractor and this only has to
 * splice anchors in. A span whose target has no page — a
 * package-private type — stays plain text.
 */
const renderType = (ref) => {
  if (!ref) return null;
  const text = ref.text;
  const links = (ref.links ?? [])
    .filter((l) => pages.has(l.id))
    .sort((a, b) => a.start - b.start);
  let html = '';
  let at = 0;
  for (const link of links) {
    if (link.start < at) continue;
    html += escape(text.slice(at, link.start));
    const label = escape(text.slice(link.start, link.end));
    html += `<a href="${pages.get(link.id)}">${label}</a>`;
    at = link.end;
  }
  return html + escape(text.slice(at));
};

/** Attaches rendered HTML to every type a page shows. */
const withHtml = (ref) => (ref ? {...ref, html: renderType(ref)} : ref);

const MEMBER_CATEGORIES = [
  {title: 'Constructors', kinds: ['constructor']},
  {title: 'Properties', kinds: ['field', 'getter', 'setter']},
  {title: 'Methods', kinds: ['method']},
  {title: 'Operators', kinds: ['operator']},
  {title: 'Variants', kinds: ['variant']},
  {title: 'Members', kinds: ['enumMember']},
];

const groupMembers = (members = []) => {
  const groups = [];
  for (const cat of MEMBER_CATEGORIES) {
    const items = members.filter((m) => cat.kinds.includes(m.kind));
    if (items.length > 0) {
      groups.push({title: cat.title, members: items});
    }
  }
  return groups;
};

const groupBySource = (members = []) => {
  const sourceMap = new Map();
  for (const m of members) {
    const key = m.from ?? m.inheritedFrom ?? 'Unknown';
    if (!sourceMap.has(key)) {
      sourceMap.set(key, {
        from: key,
        fromName: m.fromName ?? (key ?? '').split('#').pop(),
        fromUrl: m.fromUrl ?? pages.get(key) ?? null,
        members: [],
      });
    }
    sourceMap.get(key).members.push(m);
  }
  return Array.from(sourceMap.values()).map((source) => ({
    ...source,
    memberGroups: groupMembers(source.members),
  }));
};

const decorate = (declaration) => {
  const declaredMembers = byKind(
    (declaration.members ?? []).filter((m) => !m.inheritedFrom),
  ).map((m) => ({...m, type: withHtml(m.type)}));

  const inheritedMembers = byKind(
    (declaration.members ?? []).filter((m) => m.inheritedFrom),
  ).map((m) => ({
    ...m,
    type: withHtml(m.type),
    from: m.inheritedFrom,
    fromName: (m.inheritedFrom ?? '').split('#').pop(),
    fromUrl: pages.get(m.inheritedFrom) ?? null,
  }));

  return {
    ...declaration,
    type: withHtml(declaration.type),
    extends: Array.isArray(declaration.extends)
      ? declaration.extends.map(withHtml)
      : withHtml(declaration.extends),
    implements: (declaration.implements ?? []).map(withHtml),
    mixins: (declaration.mixins ?? []).map(withHtml),
    members: declaredMembers,
    memberGroups: groupMembers(declaredMembers),
    // Kept apart so a page can show them under their own heading, and
    // hide them: a class that implements a wide interface inherits far
    // more than it declares, and the declared members are what a reader
    // came for.
    inherited: inheritedMembers,
    inheritedGroups: groupMembers(inheritedMembers),
    inheritedSources: groupBySource(inheritedMembers),
  };
};

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
    declarations: declarations.filter((d) => d.kind === kind).map(decorate),
  })).filter((group) => group.declarations.length > 0);

export default {
  ...docs,
  stdlib: docs.modules.map((module) => ({
    ...module,
    url: `/reference/stdlib/${module.name}/`,
    groups: groupsFor(module.declarations ?? []),
    count: (module.declarations ?? []).length,
  })),
  /** declaration id → page URL, for anything else that needs to link. */
  pages: Object.fromEntries(pages),
};
