# The PDS (For AI Agents)

`packages/pds` is an AT Protocol PDS written in Zena, ported from pds.js,
and the base of the Zena package host. Read
[docs/design/pds.md](../../docs/design/pds.md) before starting work: it
pins the pds.js revision being ported and sets the order of the work. The
package host's protocol is in
[docs/design/package-manager.md](../../docs/design/package-manager.md),
"Hosting, keys and maintainers" and "Abuse and moderation", and its
lexicons are in `packages/package-manager/lexicons`.

## Porting

- Each ported module's header comment names the pds.js file it comes from,
  relative to the pds.js repository root, for example
  `packages/core/src/mst.js`.
- Port behaviour, not JavaScript idiom: use Zena classes, sealed classes and
  typed records where pds.js uses plain objects and string tags.
- Port the tests that come with a module where they exercise logic that does
  not depend on JavaScript. Known-answer vectors go under
  `zena/test/fixtures/`, with their source and revision recorded beside
  them.
- When the pinned pds.js revision changes, update docs/design/pds.md.
- pds.js is MIT licensed, and its notice is in `LICENSE-pds-js`.

## Where code goes

- General atproto code, which a client or another service could use too,
  goes in `packages/atproto`: encodings, the data model, repositories,
  identity, service auth, sessions. This package holds what only a PDS
  does: storage, accounts, serving repositories, and the host extension.
- When Zena itself is missing something, the fix goes in the compiler or
  the standard library, in the same change if it is small.
