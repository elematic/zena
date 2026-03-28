# Formatter Design

## Goal

Build a code formatter for Zena as the first post-parser deliverable of the
self-hosted compiler. The formatter needs only the parser — no type checking or
codegen. It proves the parser works (every valid program must round-trip) and is
immediately useful.

## Approach: Port Prettier's Algorithm

We port Prettier's document IR and line-breaking algorithm. Not "inspired by" —
a systematic, auditable port of the core machinery. We write Zena-specific
printer rules on top.

**Why Prettier, not dartfmt?**

- Prettier's IR is declarative (group/indent/line) vs dartfmt's imperative
  cost-based chunk splitting. Declarative is easier to reason about and debug.
- Prettier's algorithm is well-documented: based on Wadler's "A Prettier
  Printer" paper, with practical extensions.
- Prettier handles ~20 languages, so the core algorithm is thoroughly tested
  and handles edge cases we haven't thought of.
- The IR cleanly separates "what to print" (language-specific) from "how to
  break lines" (language-independent). We only need to write the first part.

**Why not write our own?**

- The line-breaking algorithm is the hard part. It involves a `fits` check
  that must correctly propagate break decisions through nested groups. Getting
  this wrong produces subtly bad output. Prettier has iterated on this for
  years.
- Writing our own would mean debugging the algorithm AND the printer rules
  simultaneously. Porting means we can trust the algorithm and focus on Zena
  syntax.

## No Configuration

The formatter has no configuration. One style, enforced everywhere. This
simplifies everything: no options threading, no conditional formatting paths, no
"which style is default" debates.

Fixed decisions:
- 2-space indentation
- 80-character line width
- Single quotes for strings
- Always semicolons
- Always braces on control flow

## Architecture

```
Source (.zena)
    │
    ▼
┌──────────┐
│  Parser  │  AST + Comment list
└────┬─────┘
     ▼
┌───────────────┐
│  Comment      │  Attach comments to AST nodes (leading/trailing/dangling)
│  Attachment   │
└────┬──────────┘
     ▼
┌───────────────┐
│  Printer      │  AST node → Doc IR (language-specific)
└────┬──────────┘
     ▼
┌───────────────┐
│  Doc Printer  │  Doc IR → String (language-independent, ported from Prettier)
└───────────────┘
```

Four components. The Doc Printer is a direct port. The Printer is Zena-specific.
Comment Attachment is semi-generic (most languages need similar logic). The
Parser already exists.

---

## Component 1: Doc IR (Port from Prettier)

The intermediate representation. A `Doc` is a string, an array of docs, or a
command. This is **the** thing we port faithfully.

### Types

```zena
// The core document type — a tagged union
type Doc = string | Array<Doc> | DocCommand;

enum DocCommandType {
  Group, Indent, Dedent, Align, IfBreak, Fill, Line, Softline, Hardline,
  LineSuffix, LineSuffixBoundary, BreakParent, Trim, IndentIfBreak,
  Label, LiteralLine, Cursor
}
```

### Commands (Ported 1:1 from Prettier)

| Command | Prettier equivalent | Semantics |
|---------|-------------------|-----------|
| `group(doc)` | `group` | Try to fit contents on one line. If not, break. |
| `group(doc, shouldBreak: true)` | `group({shouldBreak})` | Pre-broken group. |
| `group(doc, id: sym)` | `group({id})` | Named group for `ifBreak` cross-references. |
| `indent(doc)` | `indent` | Increase indentation by one level. |
| `dedent(doc)` | `dedent` | Decrease indentation by one level. |
| `align(n, doc)` | `align` | Increase indent by `n` spaces (not a level). |
| `line` | `line` | Space if flat, newline if broken. |
| `softline` | `softline` | Nothing if flat, newline if broken. |
| `hardline` | `hardline` | Always newline. Forces parent groups to break. |
| `literalline` | `literalline` | Always newline, no re-indentation (for template literals). |
| `ifBreak(broken, flat)` | `ifBreak` | Conditional on enclosing group's break status. |
| `ifBreak(broken, flat, groupId: sym)` | `ifBreak({groupId})` | Conditional on a named group. |
| `fill(parts)` | `fill` | Fill-wrap: break only at line boundaries that overflow. |
| `lineSuffix(doc)` | `lineSuffix` | Buffer content and flush before next newline (for trailing comments). |
| `lineSuffixBoundary` | `lineSuffixBoundary` | Force-flush `lineSuffix` buffer. |
| `breakParent` | `breakParent` | Force all ancestor groups to break. |
| `trim` | `trim` | Remove trailing whitespace on current line. |
| `indentIfBreak(doc, groupId)` | `indentIfBreak` | `ifBreak(indent(doc), doc, groupId)` optimized. |
| `label(tag, doc)` | `label` | Annotate doc for heuristic decisions. |

**What we skip:** `conditionalGroup` (Prettier itself calls it a "last resort"
that triggers exponential complexity), `cursor` (IDE integration, not needed
initially), `markAsRoot`/`dedentToRoot` (for embedded languages).

### Builder Functions

```zena
// Builders — thin wrappers that construct DocCommand values
let group = (doc: Doc, options?: GroupOptions): Doc => { ... };
let indent = (doc: Doc): Doc => { ... };
let line: Doc = { type: DocCommandType.Line };
let softline: Doc = { type: DocCommandType.Softline };
let hardline: Doc = { type: DocCommandType.Hardline };
let ifBreak = (broken: Doc, flat?: Doc, options?: IfBreakOptions): Doc => { ... };
let fill = (parts: Array<Doc>): Doc => { ... };
let join = (sep: Doc, docs: Array<Doc>): Doc => { ... };
let lineSuffix = (doc: Doc): Doc => { ... };
// etc.
```

### Source Mapping

| Prettier file | Zena file | Status |
|---|---|---|
| `src/document/builders/*.js` | `formatter/doc-builders.zena` | — |
| `src/document/printer/printer.js` | `formatter/doc-printer.zena` | — |
| `src/document/printer/indent.js` | `formatter/doc-indent.zena` | — |
| `src/document/utilities/*.js` | `formatter/doc-utils.zena` | — |

---

## Component 2: Doc Printer (Port from Prettier)

The line-breaking algorithm. This is the core of the port — the part that
makes it worth porting rather than writing from scratch.

### Algorithm Overview

The printer maintains a stack of `(indent, mode, doc)` triples. `mode` is
either `Flat` (try to fit on current line) or `Break` (group is broken).

```
function printDocToString(doc, options):
  cmds = [(rootIndent, Mode.Break, doc)]
  out = []
  pos = 0  // current column position

  while cmds is not empty:
    (ind, mode, doc) = cmds.pop()

    match doc:
      case string(s):
        out.push(s)
        pos += len(s)

      case Group { contents, shouldBreak, id }:
        if shouldBreak or mode == Break:
          // Check if contents fit on remaining line
          if not shouldBreak and fits(cmds, contents, ind, printWidth - pos):
            cmds.push(ind, Flat, contents)
            // record group as flat (for ifBreak cross-refs)
          else:
            cmds.push(ind, Break, contents)
            // record group as broken

      case Indent { contents }:
        cmds.push(increaseIndent(ind), mode, contents)

      case Line:
        if mode == Flat:
          out.push(" ")
          pos += 1
        else:
          out.push("\n" + ind.value)
          pos = ind.width

      case Softline:
        if mode == Flat:
          // nothing
        else:
          out.push("\n" + ind.value)
          pos = ind.width

      case Hardline:
        out.push("\n" + ind.value)
        pos = ind.width

      case IfBreak { breakContents, flatContents, groupId }:
        if groupId:
          // check named group's mode
          contentsToUse = groupModes[groupId] == Break ? breakContents : flatContents
        else:
          contentsToUse = mode == Break ? breakContents : flatContents
        cmds.push(ind, mode, contentsToUse)

      case Fill { parts }:
        // Fill algorithm: try to fit pairs of content+separator
        // If content fits but content+next doesn't, break the separator
        // Handles text-wrapping style layout
        ...

      // etc for all commands
```

### The `fits` Function

The critical piece. Checks whether a doc fits within the remaining width
**without breaking any groups**. This is what Prettier gets right and naive
implementations get wrong.

```
function fits(cmds, doc, indent, remainingWidth):
  // Operate on a copy of the command stack
  // Traverse doc in flat mode
  // If we encounter a hardline → doesn't fit (hardlines always break)
  // If remainingWidth goes negative → doesn't fit
  // If we exhaust the doc → fits

  restCmds = cmds  // peek at what comes after this group
  width = remainingWidth

  stack = [(indent, Flat, doc)]
  while stack is not empty and width >= 0:
    (ind, mode, d) = stack.pop()
    match d:
      case string(s): width -= len(s)
      case Group { contents }: stack.push(ind, Flat, contents)
      case Indent { contents }: stack.push(increaseIndent(ind), Flat, contents)
      case Line: if mode == Flat: width -= 1  // space
      case Softline: // nothing in flat mode
      case Hardline: return false  // hardlines always break
      case IfBreak { flatContents }: stack.push(ind, Flat, flatContents)
      ...

  return width >= 0
```

**Key detail:** The `fits` check also looks at `restCmds` — the remaining
commands on the main stack after the current group. This matters because a group
might fit in isolation but the content after it might push past the line width.
Prettier handles this by continuing the `fits` scan into the rest commands until
it hits a line break.

### `propagateBreaks`

A pre-pass over the doc tree that propagates `breakParent` and `hardline` up
through group ancestors. This is needed so that a hardline deep inside a
structure correctly breaks all enclosing groups without the printer having to
discover this during the main loop.

### Indentation Tracking

Prettier tracks indentation as a linked list of indent operations (indent,
dedent, align) rather than a simple counter. This handles mixed indentation
correctly (e.g., 2-level indent + 3-space align). We port this representation.

### Source Mapping

| Prettier source | What it does | Port priority |
|---|---|---|
| `printer.js` core loop | The `printDocToString` function | P0 — port first |
| `printer.js` `fits()` | Line-fitting check | P0 — port with core loop |
| `printer.js` `propagateBreaks()` | Pre-pass for hardline propagation | P0 — port with core loop |
| `indent.js` | Indent representation and generation | P0 — needed by core loop |
| `builders/*.js` | Doc command constructors | P0 — needed by printer |
| `utilities/*.js` | `stripTrailingHardline`, `cleanDoc`, etc. | P1 — port as needed |

---

## Component 3: Comment Attachment

Comments must be preserved. The parser collects comments with source positions.
Before printing, we attach each comment to the nearest AST node as leading,
trailing, or dangling.

### Strategy

1. **Parser collects comments**: During lexing, accumulate all comments with
   their source positions into a side list (not on AST nodes).

2. **Attachment pass**: Walk the AST and comment list together. For each comment,
   find the AST node it belongs to using position comparison:
   - **Leading**: Comment appears before a node, on its own line or at start of line.
   - **Trailing**: Comment appears after a node, on the same line.
   - **Dangling**: Comment inside an empty body (e.g., `class Foo { /* comment */ }`).

3. **Printer reads attached comments**: When printing a node,
   `printLeadingComments(node)` and `printTrailingComments(node)` emit the
   comments using `lineSuffix` (for trailing) and `hardline` (for leading).

### Prettier's Comment Algorithm

Prettier's comment attachment is one of its most complex parts (~1000 lines).
It handles edge cases like:

- Comments between `if` and `{`
- Comments at the end of argument lists
- Comments in empty blocks
- Comments between chained method calls

We can start simpler and handle edge cases incrementally. The core insight from
Prettier: use `lineSuffix` for trailing comments so they stick to the end of
the line they're on, regardless of how the surrounding code reformats.

### Port Strategy for Comments

Start with basic leading/trailing per Prettier's general approach. Add
Zena-specific edge cases as we encounter them in real code. This is the one area
where we diverge most from Prettier's source (since comments interact with
language-specific syntax), but the infrastructure patterns are the same.

---

## Component 4: Printer (Zena-Specific)

The printer converts Zena AST nodes into Doc IR. This is where all
language-specific formatting decisions live. Each AST node type has a printing
function.

### Printing Functions by AST Category

Listed roughly in order of implementation priority.

**Tier 1 — Expressions & basics** (needed for any output):

| AST Node | Formatting approach |
|---|---|
| `NumberLiteral` | Print raw value |
| `StringLiteral` | Normalize to single quotes |
| `BooleanLiteral` | `true` / `false` |
| `NullLiteral` | `null` |
| `Identifier` | Print name |
| `BinaryExpression` | `group([left, " ", op, indent([line, right])])` |
| `UnaryExpression` | `[op, arg]` or `[arg, op]` |
| `AssignmentExpression` | `group([left, " = ", indent([line, right])])` |
| `MemberExpression` | `[object, ".", property]` with chain grouping |
| `IndexExpression` | `[object, "[", index, "]"]` |
| `CallExpression` | `group(["(", indent([softline, args]), softline, ")"])` |
| `NewExpression` | `["new ", callee, "(", args, ")"]` |
| `ThisExpression` | `this` |
| `SuperExpression` | `super` |
| `TemplateLiteral` | Template parts with embedded expressions |
| `AsExpression` / `IsExpression` | `[expr, " as ", type]` |
| `PipelineExpression` | `group([left, indent([line, "|> ", right])])` |
| `RangeExpression` | `[start, "..", end]` |
| `ThrowExpression` | `["throw ", expr]` |

**Tier 2 — Statements**:

| AST Node | Formatting approach |
|---|---|
| `VariableDeclaration` | `[let/var, " ", name, typeAnnot?, " = ", indent(init), ";"]` |
| `ExpressionStatement` | `[expr, ";"]` |
| `BlockStatement` | `["{", indent([hardline, stmts]), hardline, "}"]` |
| `ReturnStatement` | `["return", expr?, ";"]` |
| `BreakStatement` / `ContinueStatement` | `["break;"]` / `["continue;"]` |
| `IfStatement` | Group with `else` chaining |
| `WhileStatement` | `["while (", cond, ") ", body]` |
| `ForStatement` | `["for (", init, "; ", test, "; ", update, ") ", body]` |
| `ForInStatement` | `["for (let ", pattern, " in ", expr, ") ", body]` |

**Tier 3 — Functions & closures**:

| AST Node | Formatting approach |
|---|---|
| `FunctionExpression` | Params group + return type + body (block or expr) |
| `Parameter` | `[name, "?", ": ", type, " = ", default]` |
| `TypeParameter` | `[name, " extends ", constraint]` |

**Tier 4 — Classes & types**:

| AST Node | Formatting approach |
|---|---|
| `ClassDeclaration` | Header group (name, extends, with, implements) + body |
| `FieldDefinition` | `[mutability, name, ": ", type, " = ", init, ";"]` |
| `MethodDefinition` | Signature + body |
| `AccessorDeclaration` | `get`/`set` + name + body |
| `InterfaceDeclaration` | Like class but only signatures |
| `MixinDeclaration` | Like class |
| `EnumDeclaration` | `["enum ", name, " {", indent(members), "}"]` |
| `TypeAliasDeclaration` | `["type ", name, " = ", type, ";"]` |

**Tier 5 — Patterns & advanced**:

| AST Node | Formatting approach |
|---|---|
| `MatchExpression` | `["match (", expr, ") {", indent(cases), "}"]` |
| `MatchCase` | `["case ", pattern, guard?, ": ", body]` |
| `RecordPattern` / `TuplePattern` | Like corresponding literals |
| `ClassPattern` | `[name, " {", fields, "}"]` |
| `TryExpression` | `["try ", body, " catch", catchClause, " finally", finally]` |
| `ImportDeclaration` | `["import {", specifiers, "} from ", source, ";"]` |
| `Decorator` | `["@", name, "(", args, ")"]` |
| `DeclareFunction` | `["declare function ", name, sig, ";"]` |

### Key Formatting Patterns

**Argument lists** (function params, call args, type args):

```zena
// Short: stays on one line
add(1, 2)

// Long: each arg on its own line
createWidget(
  name,
  width,
  height,
  color,
)
```

Doc: `group(["(", indent([softline, join([",", line], args)]), softline, ")"])`

**Method chains**:

```zena
// Short: one line
arr.map(f).filter(g)

// Long: each call on its own line
arr
  .map(f)
  .filter(g)
  .reduce(h, init)
```

Doc: `group([object, indent([softline, ".", method, "(", args, ")"] for each)])` 

**Binary expression chains**:

```zena
// Short: one line
a + b + c

// Long: break before operator
a
  + b
  + c
```

Doc: `group([left, indent([line, op, " ", right])])` 

**If-else chains**:

```zena
if (cond1) {
  body1
} else if (cond2) {
  body2
} else {
  body3
}
```

No extra indentation for `else if`. Print as a flat chain, not nested.

**Class declarations**:

```zena
// Short: one line header
class Point extends Base implements Drawable {

// Long: break after each clause
class Widget
  extends Base
  with Serializable, Equatable
  implements Drawable, Clickable {
```

Doc: `group([header, indent([line, "extends ", base, line, "with ", mixins, line, "implements ", ifaces]), " {"])`

---

## Porting Methodology

The core risk with AI-assisted porting is "write something new and call it a
port." Here's how we stay systematic.

### Phase 1: Port the Doc Printer (Language-Independent)

This is a direct, auditable port. The Prettier source is ~600 lines of
JavaScript across `printer.js`, `indent.js`, and the builder files. The
algorithm is language-independent.

**Process:**

1. **Read the Prettier source** file by file. For each file:
   - List every function/export.
   - Note every data structure.
   - Note every constant/enum.

2. **Create a mapping document** (a checklist in this file — see Appendix A)
   mapping each Prettier function to its Zena equivalent.

3. **Port function by function**, in dependency order:
   - Indent representation (`indent.js`) first.
   - Doc builders (`builders/*.js`) second.
   - Core printer loop (`printer.js`: `printDocToString`) third.
   - `fits` function fourth.
   - `propagateBreaks` fifth.
   - Utilities last.

4. **Test each function in isolation.** The doc printer can be tested without
   any AST — just construct Doc values directly and check string output:
   ```zena
   // Test: group that fits on one line
   let doc = group(["hello", " ", "world"]);
   assert(printDoc(doc, 80) == "hello world");

   // Test: group that breaks
   let doc = group(["hello", line, "world"]);
   assert(printDoc(doc, 5) == "hello\nworld");
   ```

5. **Verify against Prettier's own doc tests.** Prettier has tests that
   exercise the doc printer directly (not through language parsing). Port these.

### Phase 2: Port Comment Attachment (Semi-Generic)

Start with Prettier's general comment attachment algorithm, adapted for Zena's
AST. Port incrementally — start with basic leading/trailing, add dangling and
edge cases as we write printer rules.

### Phase 3: Write Zena Printer Rules (Zena-Specific)

This part is NOT a port — Zena's syntax is different from JS. But we follow
Prettier's structural patterns:

1. One printing function per AST node type.
2. Each function returns a `Doc`.
3. Use the same IR commands (group, indent, line, etc.) that Prettier uses.
4. Follow Prettier's heuristics for similar constructs (e.g., argument lists,
   binary expressions, ternaries).

**Implementation order:** Follow the Tiers above (expressions → statements →
functions → classes → patterns). Each tier is independently testable.

### Phase 4: Integration Testing

Write snapshot tests: input Zena source → formatted output. Start with the
`examples/` directory and expand to cover all syntax.

---

## Testing Strategy

### Unit Tests: Doc Printer

Test the doc-to-string algorithm in isolation. Construct Doc values manually
and verify output. These can be ported from Prettier's doc tests.

```zena
test('group fits on line', () => {
  let doc = group(["a", ",", line, "b", ",", line, "c"]);
  assert(print(doc, 80) == "a, b, c");
});

test('group breaks when too wide', () => {
  let doc = group(["a", ",", line, "b", ",", line, "c"]);
  assert(print(doc, 5) == "a,\nb,\nc");
});

test('nested groups break outer first', () => {
  let outer = group(["(", indent([softline, group(["a", ",", line, "b"]), ",", line, "c"]), softline, ")"]);
  // When outer breaks, inner might still fit
  ...
});

test('fill wraps at line width', () => {
  let doc = fill(["word1", line, "word2", line, "word3", line, "word4"]);
  assert(print(doc, 15) == "word1 word2\nword3 word4");
});

test('hardline forces break', () => {
  let doc = group(["a", hardline, "b"]);
  assert(print(doc, 80) == "a\nb");
});

test('ifBreak selects based on group', () => {
  let doc = group(["a", ifBreak(",", ""), line, "b"]);
  // Flat: "a b"  Broken: "a,\nb"
  ...
});
```

### Snapshot Tests: End-to-End

Input → parse → print → compare to expected output. Store expected outputs as
`.expected` files alongside test inputs.

```
test-files/
  formatter/
    basic-expressions.zena       # input
    basic-expressions.expected   # expected formatted output
    classes.zena
    classes.expected
    ...
```

A test runner reads each `.zena` file, formats it, and compares to `.expected`.
To update snapshots: format and overwrite.

### Idempotency Tests

A correct formatter must be idempotent: `format(format(x)) == format(x)`. For
every test case, verify that formatting twice produces the same result.

### Round-Trip Tests

For every test case, verify that `parse(format(parse(source)))` produces the
same AST as `parse(source)` (modulo whitespace/comment positions). This catches
printer bugs that would produce syntactically different code.

---

## Porting Prettier's Tests

Prettier's JS-specific tests aren't directly useful (different syntax). But
Prettier has two categories of tests we can leverage:

1. **Doc printer tests** — test the IR → string algorithm. These are
   language-independent and we should port them directly. They test `group`,
   `indent`, `line`, `fill`, `ifBreak` behavior.

2. **Structural patterns** — how Prettier formats argument lists, method
   chains, binary expressions, et al. These translate to Zena because the
   patterns are syntactically similar. We don't port the tests literally, but
   we write equivalent Zena tests for the same formatting patterns.

---

## Tracking Progress

### Appendix A: Doc Printer Port Checklist

Track each Prettier source function and its Zena equivalent.

**`src/document/builders/`**

| Prettier function | Zena function | Status |
|---|---|---|
| `group(contents, opts)` | `group` | — |
| `indent(contents)` | `indent` | — |
| `dedent(contents)` | `dedent` | — |
| `align(widthOrString, contents)` | `align` | — |
| `fill(parts)` | `fill` | — |
| `ifBreak(breakContents, flatContents, opts)` | `ifBreak` | — |
| `indentIfBreak(contents, opts)` | `indentIfBreak` | — |
| `lineSuffix(contents)` | `lineSuffix` | — |
| `join(sep, docs)` | `join` | — |
| `label(label, doc)` | `label` | — |
| `line` | `line` | — |
| `softline` | `softline` | — |
| `hardline` | `hardline` | — |
| `literalline` | `literalline` | — |
| `breakParent` | `breakParent` | — |
| `lineSuffixBoundary` | `lineSuffixBoundary` | — |
| `trim` | `trim` | — |
| `cursor` | — | Skip |
| `conditionalGroup` | — | Skip |

**`src/document/printer/`**

| Prettier function | Zena function | Status |
|---|---|---|
| `printDocToString(doc, opts)` | `printDocToString` | — |
| `fits(next, restCommands, width, ...)` | `fits` | — |
| `propagateBreaks(doc)` | `propagateBreaks` | — |
| `generateIndent(ind, newPart, opts)` | `generateIndent` | — |
| `makeIndent(ind, opts)` | `makeIndent` | — |
| `makeAlign(ind, widthOrString, opts)` | `makeAlign` | — |
| `rootIndent()` | `rootIndent` | — |
| `trim(out)` | `trimOutput` | — |

**`src/document/utilities/`**

| Prettier function | Zena function | Status |
|---|---|---|
| `stripTrailingHardline(doc)` | `stripTrailingHardline` | — |
| `cleanDoc(doc)` | — | Port if needed |
| `getDocType(doc)` | — | Port if needed |
| `willBreak(doc)` | `willBreak` | — |
| `canBreak(doc)` | — | Port if needed |

### Appendix B: Zena Printer Checklist

Track each AST node type and its print function.

**Tier 1 — Expressions (P0)**

| AST Node | Print function | Status |
|---|---|---|
| `NumberLiteral` | `printNumberLiteral` | — |
| `StringLiteral` | `printStringLiteral` | — |
| `BooleanLiteral` | `printBooleanLiteral` | — |
| `NullLiteral` | `printNullLiteral` | — |
| `Identifier` | `printIdentifier` | — |
| `BinaryExpression` | `printBinaryExpression` | — |
| `UnaryExpression` | `printUnaryExpression` | — |
| `AssignmentExpression` | `printAssignmentExpression` | — |
| `MemberExpression` | `printMemberExpression` | — |
| `IndexExpression` | `printIndexExpression` | — |
| `CallExpression` | `printCallExpression` | — |
| `NewExpression` | `printNewExpression` | — |
| `ThisExpression` | `printThisExpression` | — |
| `SuperExpression` | `printSuperExpression` | — |
| `TemplateLiteral` | `printTemplateLiteral` | — |
| `TaggedTemplateExpression` | `printTaggedTemplate` | — |
| `AsExpression` | `printAsExpression` | — |
| `IsExpression` | `printIsExpression` | — |
| `PipelineExpression` | `printPipelineExpression` | — |
| `RangeExpression` | `printRangeExpression` | — |
| `ThrowExpression` | `printThrowExpression` | — |
| `ArrayLiteral` | `printArrayLiteral` | — |
| `RecordLiteral` | `printRecordLiteral` | — |
| `TupleLiteral` | `printTupleLiteral` | — |
| `InlineTupleLiteral` | `printInlineTupleLiteral` | — |
| `MapLiteral` | `printMapLiteral` | — |
| `IfExpression` | `printIfExpression` | — |

**Tier 2 — Statements (P0)**

| AST Node | Print function | Status |
|---|---|---|
| `Module` | `printModule` | — |
| `VariableDeclaration` | `printVariableDeclaration` | — |
| `ExpressionStatement` | `printExpressionStatement` | — |
| `BlockStatement` | `printBlockStatement` | — |
| `ReturnStatement` | `printReturnStatement` | — |
| `BreakStatement` | `printBreakStatement` | — |
| `ContinueStatement` | `printContinueStatement` | — |
| `IfStatement` | `printIfStatement` | — |
| `WhileStatement` | `printWhileStatement` | — |
| `ForStatement` | `printForStatement` | — |
| `ForInStatement` | `printForInStatement` | — |

**Tier 3 — Functions (P1)**

| AST Node | Print function | Status |
|---|---|---|
| `FunctionExpression` | `printFunctionExpression` | — |
| `Parameter` | `printParameter` | — |
| `TypeParameter` | `printTypeParameter` | — |

**Tier 4 — Classes & Types (P1)**

| AST Node | Print function | Status |
|---|---|---|
| `ClassDeclaration` | `printClassDeclaration` | — |
| `FieldDefinition` | `printFieldDefinition` | — |
| `MethodDefinition` | `printMethodDefinition` | — |
| `AccessorDeclaration` | `printAccessorDeclaration` | — |
| `InterfaceDeclaration` | `printInterfaceDeclaration` | — |
| `MixinDeclaration` | `printMixinDeclaration` | — |
| `EnumDeclaration` | `printEnumDeclaration` | — |
| `TypeAliasDeclaration` | `printTypeAliasDeclaration` | — |

**Tier 5 — Patterns & Advanced (P2)**

| AST Node | Print function | Status |
|---|---|---|
| `MatchExpression` | `printMatchExpression` | — |
| `MatchCase` | `printMatchCase` | — |
| `RecordPattern` | `printRecordPattern` | — |
| `TuplePattern` | `printTuplePattern` | — |
| `InlineTuplePattern` | `printInlineTuplePattern` | — |
| `ClassPattern` | `printClassPattern` | — |
| `LogicalPattern` | `printLogicalPattern` | — |
| `AsPattern` | `printAsPattern` | — |
| `TryExpression` | `printTryExpression` | — |
| `CatchClause` | `printCatchClause` | — |
| `ImportDeclaration` | `printImportDeclaration` | — |
| `ExportAllDeclaration` | `printExportAllDeclaration` | — |
| `Decorator` | `printDecorator` | — |
| `DeclareFunction` | `printDeclareFunction` | — |

**Type Annotations**

| AST Node | Print function | Status |
|---|---|---|
| `NamedTypeAnnotation` | `printNamedType` | — |
| `UnionTypeAnnotation` | `printUnionType` | — |
| `FunctionTypeAnnotation` | `printFunctionType` | — |
| `RecordTypeAnnotation` | `printRecordType` | — |
| `TupleTypeAnnotation` | `printTupleType` | — |
| `InlineTupleTypeAnnotation` | `printInlineTupleType` | — |
| `LiteralTypeAnnotation` | `printLiteralType` | — |
| `ThisTypeAnnotation` | `printThisType` | — |

---

## File Layout

```
packages/zena-compiler/zena/lib/formatter/
  doc-builders.zena      # Doc IR constructors (ported from Prettier)
  doc-printer.zena       # printDocToString, fits, propagateBreaks (ported)
  doc-indent.zena        # Indent representation (ported)
  doc-utils.zena         # Utility functions (ported)
  comment-attachment.zena # Comment → AST node attachment
  printer.zena           # Main dispatch: AST node → Doc
  print-expressions.zena # Expression node printers
  print-statements.zena  # Statement node printers
  print-classes.zena     # Class/interface/mixin printers
  print-patterns.zena    # Pattern node printers
  print-types.zena       # Type annotation printers
  print-comments.zena    # Comment printing helpers
  format.zena            # Public API: format(source) → string

packages/zena-compiler/zena/test/formatter/
  doc-printer_test.zena  # Doc IR → string tests (ported from Prettier)
  expressions_test.zena  # Expression formatting snapshots
  statements_test.zena   # Statement formatting snapshots
  classes_test.zena      # Class formatting snapshots
  patterns_test.zena     # Pattern formatting snapshots
  comments_test.zena     # Comment preservation tests
  idempotency_test.zena  # format(format(x)) == format(x)
```

---

## Implementation Order

1. **Doc IR types + builders** — data structures only, no logic. Fast to write,
   unblocks everything else.
2. **Doc printer (core loop + fits + indent)** — the ported algorithm. Test with
   hand-built Doc values.
3. **Printer: literals + identifiers** — trivial but proves the pipeline works
   end-to-end.
4. **Printer: expressions** — binary, unary, call, member access. This is where
   formatting decisions start to matter.
5. **Printer: statements** — if, while, for, blocks, variable declarations.
6. **Comment attachment + printing** — needed before real code can round-trip.
7. **Printer: functions** — arrow functions, parameters, type parameters.
8. **Printer: classes, interfaces, mixins** — headers and member lists.
9. **Printer: patterns, match, try/catch** — advanced syntax.
10. **Printer: imports, exports, decorators, declares** — module-level syntax.
11. **Integration: `format(source) → string`** — the public API.

Each step has the full test cycle: unit test, snapshot test, idempotency test.

---

## Open Questions

1. **Comment storage**: Should comments live in a side list (like Prettier) or
   as AST node properties? Side list is simpler for the parser but requires an
   attachment pass. Node properties skip the attachment pass but require the
   parser to do more work. Prettier uses a side list. Recommend: side list.

2. **Trailing commas**: Always add trailing commas in multi-line lists? Prettier
   does this by default for JS. It's good for diffs. Recommend: yes.

3. **Empty line preservation**: Preserve one blank line between statements/
   declarations when the input has them? Prettier preserves up to one blank line.
   Recommend: same — collapse multiple blank lines to one, preserve single blank
   lines.

4. **Expression body vs block body for arrows**: When to use `=> expr` vs
   `=> { return expr; }`? Recommend: use expression body when the expression
   fits on one line with the arrow; block body otherwise.

5. **Method chain breaking threshold**: Break method chains when they have 3+
   calls? 2+? Prettier uses heuristics (break if there are 3+ calls, or if any
   call has complex arguments). Start with a simple threshold and tune.
