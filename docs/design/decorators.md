# Decorators

## Overview

A decorator is written `@name` in front of a declaration and changes how
the compiler treats it. Zena has two kinds:

- **Builtin decorators** the compiler defines: `@external` and
  `@intrinsic` on `declare function`s and on methods, `@intrinsic` on
  `declare type`. These are not names in any scope.
- **Field decorators** a program or library declares with the
  `decorator` keyword and applies to a class field. A field decorator
  replaces the field with an accessor it defines and adds the storage and
  state the accessor needs to the class. This is the subject of this
  document.

Field decorators cover the cases a signals library and a Lit-style
`@property` need: intercept every read and write of a field, and keep
extra per-field state (a version counter, a dependency list) in the same
object as the value, with no separate allocation and no pointer to
follow.

Decorator syntax is a decorator expression: `@foo`, `@foo.bar`, or
`@foo(args)` with ordinary expressions as arguments. The parser accepts
all three everywhere a decorator may appear. The checker resolves only
a bare name to a field decorator today; dotted names and arguments are
parsed and reported as not yet supported (see "Not yet implemented").

## A field decorator

```zena
import {trackRead, notifyWrite} from './graph.zena';

export decorator signal<T>(var value: T) {
  var #value: T;              // storage: receives the decorated field's value
  var #version: i32 = 0;      // per-field state, next to the value
  value: T {
    get {
      trackRead(this, this.#version);
      return this.#value;
    }
    set(v) {
      this.#value = v;
      this.#version += 1;
      notifyWrite(this);
    }
  }
}
```

```zena
import {signal} from './signal.zena';

class Counter {
  @signal var count: i32 = 0;
  @signal var label: String = '';
}
```

Reading `c.count` calls the getter; `c.count = 1` calls the setter. The
struct for `Counter` holds four fields: the two values and the two
version counters. `trackRead` and `notifyWrite` are names in the
decorator's module; `Counter`'s module never imports them.

### The declaration

```
decorator Name<TypeParams>([var] subject: Type) { members }
```

The header names a placeholder field, the **subject**. The body is a
class body written against it, with three rules:

1. **One public member**, an accessor named like the subject. The
   accessor has a getter, and a setter exactly when the subject is `var`.
   This accessor is what the host class gains under the decorated
   field's name.
2. **A private field named `#<subject>`**, the storage. The decorated
   field's initializer, `this.<field>` constructor parameters and
   initializer-list entries all write this field directly. Its own
   initializer, if any, is the default used when the decorated field has
   none.
3. **Everything else is private**: further fields and methods, each
   named with `#`. These are the decorator's state and helpers.

A decorator has no constructor, no `on` clause and no `with` clause.
Like a mixin, its body's names resolve in the module that declares it.

### Applying it

`@name` on a plain instance field with a type annotation applies the
decorator named `name`. The checker verifies:

- `name` resolves to a decorator. A mixin, class or anything else is an
  error, and so is a `with` clause naming a decorator.
- The field's mutability matches the subject's: a `var` subject applies
  to `var` fields, an immutable subject to immutable fields. The field
  then has a setter exactly when the decorator wrote one.
- The field's declared type binds the decorator's type parameter. When
  the subject is typed by a bare type parameter (`value: T`), `T` is the
  field's type; when the subject has a concrete type, the field's type
  must be assignable to it. A decorator with a type parameter the subject
  does not name cannot be applied, since nothing binds it.
- A field takes at most one decorator, and the field is not static,
  abstract, declared, or a `var(#x) x` field.

Reads and writes of the field, anywhere, go through the accessor. The
only writes that bypass it are the three initialization forms above,
which store into the storage field, as they would for a plain field.

## Implementation

A field decorator is a mixin applied to one field at a time, and is
implemented as one. The declaration parses to a `MixinDeclaration` with a
`decoratorSubject`, and the checker registers a `MixinType` carrying the
subject's name, mutability and type. Applying `@signal` to `count` in
`Counter` inserts an intermediate class into `Counter`'s superclass
chain, exactly as `class Counter with M` does for a mixin, so the
machinery that compiles mixin bodies once per host class and resolves
their names in their own module carries decorators unchanged. Three
things differ from a mixin application (`applyFieldDecorator` in
`checker.zena`):

- **Scope key.** A mixin's private fields are namespaced in the host
  struct by the mixin's scope key, which is shared across applications
  because one class applies a mixin once. A decorator is applied once
  per field, so its application's key is the declaration's key with the
  field's name appended: `signal_This@signal.zena@count`. Two
  applications of one decorator in one class get two storage fields and
  two version counters.
- **Subject rename.** The body's accessor is written against the
  placeholder (`value`) and registered on the host under the field's
  name (`get#count`, `set#count`). The intermediate class records the
  placeholder and the field name (`ClassType.decoratorSubjectName`,
  `decoratorFieldName`), and every codegen pass that registers an
  accessor by its written name applies the rename: the member-collection
  loops in `specialization.zena` and the referrer-driven registration in
  `analysis.zena`.
- **Type arguments.** The intermediate is instantiated with the field's
  type bound to the decorator's type parameter. One class may apply a
  generic decorator to fields of different types, and the host's
  flattened substitution context then holds the parameter once per
  application, so a decorator body binds its own application's arguments
  first (`type-mapping.zena`, the per-function substitution).

The host class registers no member for the decorated field. Its
`decoratedFields` map records each application's scope and storage key,
and the passes that would otherwise register or initialize the field
consult it: field registration in the checker skips it, the codegen loops
skip its synthesized accessors, and constructor lowering routes the
field's initializer, `this.` parameters and initializer-list entries to
the storage key.

One shared body node stands for every application, so a code path that
starts from a node cannot tell which application it belongs to. The
referrer-driven registration in reachability therefore registers a copy
for every decorator intermediate in the host's chain whose declaration
body contains the node (`findDecoratorIntermediates`). Before this,
only the nearest application's accessor was reached, and the first
decorated field's getter was dropped from the module.

## Not yet implemented

- **Arguments.** `@property({attribute: false})` parses, and applying a
  decorator with arguments is an error. The intended semantics is a
  decorator declaration with value parameters after the subject,
  spliced where the body names them; whether a splice is evaluated once
  per reference or once per class is the open question.
- **Dotted names.** `@signals.state` parses; the checker reports it as
  unsupported. It needs the namespace-import lookup the type checker uses
  for `ns.Type`.
- **Closures in decorator bodies that touch private state.** A closure's
  private scope is derived from the declaration it is written in, which
  for a decorator is the declaration-level key rather than the
  application's. Such a closure fails to lower. Accessor and method
  bodies themselves are fine.
- **Methods, classes and functions as decorator targets**, and
  **decorating an expression** to apply a macro to it. These are
  the macro tier (below).

## Shared state across applications

A field decorator today sees only its own field. Lit's `@property()`
needs more: every decorated property of a class registers in one table
of property metadata, the setter records the change in a per-instance
set and schedules an update, and users expect `@property` to bring that
behavior with it rather than require the class to implement it.

The rule that shapes the answer: **a decorator adds nothing public to the
host class except the member it decorates.** Everything else it brings is
private, in one of two scopes:

- **Per application** (the default, implemented): a private member is one
  copy per decorated field, under the application's scope key. `#value`
  and `#version` in the `signal` example are these. Two decorated fields
  never see each other's copies, so the decorator author names them
  freely.
- **Shared** (`shared`): a private member marked `shared` is one copy per
  host class, under the declaration's scope key, which is how a mixin's
  privates already work. Every application of the decorator in a class
  reads the same field and calls the same method; the first application
  introduces it, and its initializer runs once.

```zena
decorator property<T>(var value: T) {
  var #value: T;
  shared var #changed = new Set<String>();   // one per instance, all properties
  shared #scheduleUpdate(): void { ... }      // one copy per class
  value: T {
    get { return this.#value; }
    set(v) {
      this.#value = v;
      this.#changed.add(/* the field's name: see below */);
      this.#scheduleUpdate();
    }
  }
}
```

Shared members are the decorator's private business, so they do not
collide with the host's privates or another decorator's, and a class that
applies `@property` gets the update machinery without implementing or
seeing anything. A shared member must be private, cannot be the storage
field (which is one per field by definition), and its type cannot mention
the decorator's type parameters, since those are bound per application
and the one copy serves them all.

In the implementation, a shared member stores under
`<declaration scope>::#name` instead of `<application scope>::#name`
(`MixinType.sharedMembers` says which). The second application of a
decorator in one class finds the first's intermediate in the host's chain
and adds no shared members of its own (`applyFieldDecorator`), and
constructor lowering skips a shared initializer whose field is already
set (`#decoratorFieldValues`). Codegen registers a shared method under
the declaration key (`#memberScopeOf` in `specialization.zena`, and the
referrer path in `analysis.zena`), and a decorator body that misses a
private name under its application key tries the declaration key next
(`#decoratorSharedScope` in `lowering.zena`), which is how a per-field
setter reaches a shared field or method. A shared method's own body
resolves privates under the declaration key only, so it cannot reach
per-field members; that is reported at lowering today rather than by the
checker.

**Constraining the host (`on`).** When the decorator does need public API
from the host, it declares the class or interface the host must extend or
implement, as a mixin's `on` clause does, and its body may call that API
on `this`. The checker types the body's `this` by the `on` type exactly as
for a mixin, and `applyFieldDecorator` checks the host's superclass and
`implements` list against it before inserting the intermediate. A
decorator does not take `with`: a mixin's members are public, which the
rule above excludes.

**Per-class registration.** The table that maps property names to options
is built once per class with one entry per application. Two things are
missing for the template tier to express it: `shared static` members
(mixins have no static members today, only static symbols), and a way for
the body to name the decorated field as a value, a `nameof`-style splice.
With both, a per-application private static with an initializer registers
its entry into the shared static table at module initialization. Until
then this is the procedural tier's job: a class decorator that walks the
members, as Lit pairs `@customElement` with `@property`.

## Relation to macros

[macros.md](macros.md) describes compile-time code execution: a macro is
a function from syntax to syntax that the compiler runs. A decorator
expression `@foo` is how such a function would be applied to a
declaration or an expression. Running user code at compile time needs the
compiler to load and run a user module during compilation, which the
self-hosted compiler cannot do yet.

In that tier a decorator is an ordinary function whose parameter type is
the target's syntax, so each target kind has a function type rather than a
`kind` tag checked at run time:

```zena
type FieldDecorator = (target: FieldDeclaration, ctx: DecoratorContext) => Array<ClassMember>;
type MethodDecorator = (target: MethodDeclaration, ctx: DecoratorContext) => Array<ClassMember>;
type ClassDecorator = (target: ClassDeclaration, ctx: DecoratorContext) => ClassDeclaration;
type ExpressionDecorator = (target: Expression, ctx: DecoratorContext) => Expression;
```

One name serving several kinds (`@signal` on a field and on a variable)
is then an overloaded function, and `@signal` picks the overload from what
follows it. TODO: this depends on overloading top-level functions by
parameter type, which Zena has only for methods and `declare function`s
today (language-reference.md §"Function Overloading"); the tracking issue
is to be filed.

The `decorator` declaration is the template-only tier of that design: a
field decorator written as a declarative macro would return the same
members as a quasi-quote, with the field's name, type and initializer
spliced in. The declaration form needs no macro runtime because the
compiler expands it by reference: the body's nodes are compiled per
application under a substitution, never copied, which is also what keeps
name resolution in the declaring module. A procedural macro that builds
new syntax needs node cloning with definition-site resolution, which is
the macro runtime's problem. When that lands, the declaration form stays
as the sugar for the common case.
