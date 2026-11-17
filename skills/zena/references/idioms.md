# Zena idioms

One compiled example for each row of "Features to reach for" in
[SKILL.md](../SKILL.md). Each section names the TypeScript habit it replaces.

## Sealed classes and `match`

Replaces a `kind` field with an `if` chain. Adding a case makes every
`match` that lacks it a compile error, so the compiler lists the code to
update.

```zena
sealed class Shape {
  case Circle(radius: f64)
  case Rect(width: f64, height: f64)
  case Empty
}

function area(shape: Shape): f64 {
  return match (shape) {
    case Circle {radius}: 3.14159 * radius * radius
    case Rect {width, height}: width * height
    case Empty: 0.0
  };
}

// Patterns nest, test literals, bind with `let`, and take guards.
function describe(shape: Shape): String {
  return match (shape) {
    case Rect {width, height} if width == height: 'square'
    case Rect {width: 0.0}: 'degenerate'
    case Rect: 'rectangle'
    case Circle {radius} if radius > 100.0: 'big circle'
    case _: 'something else'
  };
}

export function main(): i32 {
  console.log(describe(new Rect(2.0, 2.0)));
  return area(new Circle(1.0)) as i32;
}
```

`match` also works on literals, tuples, records, enums and unions:

```zena
enum Level {
  Debug,
  Info,
  Error,
}

type Reply = (true, String) | (false, i32);

function label(level: Level): String {
  return match (level) {
    case Level.Debug: 'debug'
    case Level.Info: 'info'
    case Level.Error: 'error'
  };
}

function size(reply: Reply): i32 {
  return match (reply) {
    case (true, let text): text.utf8.length
    case (false, let code): code
  };
}

function bucket(n: i32): String {
  return match (n) {
    case 0: 'none'
    case 1 | 2 | 3: 'few'
    case let m if m < 0: 'negative'
    case _: 'many'
  };
}

export function main(): i32 {
  console.log(`${label(Level.Info)} ${bucket(2)}`);
  return size((true, 'four'));
}
```

## Case classes and records

A case class replaces a data class with a hand-written constructor and
`equals`. A record replaces an `interface` that describes a bag of fields.
Choose a class when the type has identity, behavior or invariants, and a
record for options, rows and one-off groupings. A record field marked `?`
may be absent, which is how an options object leaves a setting out.

```zena
// Nominal: a Point is only ever a Point. `==` compares fields.
class Point(x: f64, y: f64) {
  plus(other: Point): Point {
    return new Point(this.x + other.x, this.y + other.y);
  }
}

// Structural: any record with these fields is an Options.
type Options = {host: String, port: i32, secure: boolean};

function withPort(options: Options, port: i32): Options {
  return {...options, port};   // records are immutable; spread to change one
}

function address({host, port}: Options): String {
  return `${host}:${port}`;
}

// `timeout?` may be absent. Reading `request.timeout` is an error: take a
// default, or test for the field with a pattern.
type Request = {url: String, timeout?: i32};

function timeoutOf(request: Request): i32 {
  let {timeout = 5000} = request;
  return timeout;
}

function describe(request: Request): String {
  return match (request) {
    case {timeout}: `${request.url} within ${timeout} ms`
    case {!timeout}: request.url
  };
}

export function main(): i32 {
  let a = new Point(1.0, 2.0);
  let same = a.plus(new Point(0.0, 0.0)) == a;   // true
  let options = {host: 'localhost', port: 80, secure: false};
  console.log(address(withPort(options, 8080)));
  console.log(describe({url: '/a', timeout: timeoutOf({url: '/b'})}));
  return if (same && {x: 1} == {x: 1}) 0 else 1;
}
```

## Results without null

Replaces `T | null`, a sentinel such as `-1`, and a returned object that
carries two values. A primitive cannot be `null`, and an inline tuple costs
nothing: its elements are returned on the stack.

```zena
import {HashMap} from 'zena:collections';

// Two values.
function minMax(values: Array<i32>): inline (i32, i32) requires (values.length > 0) {
  var low = values[0];
  var high = values[0];
  for (let v in values) {
    if (v < low) { low = v; }
    if (v > high) { high = v; }
  }
  return (low, high);
}

// A value or nothing. `_` fills the slot that has no value.
function indexOf(values: Array<i32>, target: i32): inline (true, i32) | (false, _) {
  for (let i in 0..values.length) {
    if (values[i] == target) { return (true, i); }
  }
  return (false, _);
}

// `Option<T>` is the form to store in a field or a collection.
class Cache {
  var last: Option<i32> = none;
}

export function main(): i32 {
  let (low, high) = minMax([3, 1, 4]);

  // `if (let pattern = value)` tests and binds in one step.
  if (let (true, at) = indexOf([3, 1, 4], 4)) {
    console.log(`found at ${at}`);
  }

  // `??` unwraps a (true, value) or takes the default.
  let ages: HashMap<String, i32> = {'ada' => 36};
  let age = ages.get('ada') ?? 0;
  let missing = indexOf([3, 1, 4], 9) ?? -1;

  let cache = new Cache();
  cache.last = some(age);
  if (let Some {value} = cache.last) {
    console.log(`cached ${value}`);
  }
  return high - low + missing;
}
```

For a failure the caller is expected to handle, return `Result<T, E>` from
`zena:core`, which is `(true, T) | (false, E)`, instead of throwing:

```zena
import {Result, parseI32} from 'zena:core';

function parsePort(text: String): inline Result<i32, String> {
  if (let (true, n) = parseI32(text)) {
    return if (n >= 1 && n <= 65535) (true, n) else (false, 'out of range');
  }
  return (false, 'not a number');
}

export function main(): i32 {
  let why = match (parsePort('http')) {
    case (true, let port): `port ${port}`
    case (false, let reason): reason
  };
  console.log(why);
  return parsePort('80') ?? 8080;
}
```

References can be `null`. Use `T?`, `??`, `?.` and narrowing:

```zena
class User(name: String, manager: User?)

function bossName(user: User): String {
  return user.manager?.name ?? 'nobody';
}

function chain(user: User): i32 {
  var depth = 0;
  var current = user.manager;
  while (current != null) {
    depth += 1;
    current = current.manager;
  }
  return depth;
}

export function main(): i32 {
  let ada = new User('Ada', null);
  let bob = new User('Bob', ada);
  console.log(bossName(bob));
  return chain(bob);
}
```

## Contracts

Replaces `if (!ok) throw …` at the top of a function, and comments such as
"n must be positive". A clause is part of the signature, so a reviewer and
a caller both see it. A failed clause throws `ContractError` naming the
clause.

```zena
import {div} from 'zena:math';

function isSorted(values: Array<i32>): boolean {
  for (let i in 1..values.length) {
    if (values[i - 1] > values[i]) { return false; }
  }
  return true;
}

// `requires` narrows: `values` is not null in the body.
// `debug requires` runs under `zena test` and `-g` only, so it can be slow.
function search(values: Array<i32>?, target: i32): i32
  requires (values != null)
  debug requires (isSorted(values))
  ensures (result == -1 || values[result] == target)
{
  var low = 0;
  var high = values.length;
  while (low < high) invariant (0 <= low && high <= values.length) {
    let middle = low + div(high - low, 2);
    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return if (low < values.length && values[low] == target) low else -1;
}

class Account {
  var balance: i64 = 0;

  // `old(e)` is the value `e` had on entry.
  deposit(amount: i64): void
    requires (amount > 0)
    ensures (this.balance == old(this.balance) + amount)
  {
    this.balance += amount;
  }
}

export function main(): i32 {
  let account = new Account();
  account.deposit(5);
  return search([1, 3, 5, 7], 5);
}
```

Rules that the examples do not show:

- Only an unmarked `requires` narrows types in the body. `debug requires`
  and `static requires` do not, since a build may leave them out.
- A `static` clause is type-checked and never run. Its condition must not
  change anything. The compiler does not prove it yet.
- A constructor's `requires` names the parameters, also for a `this.x`
  parameter: `new(this.step) requires (step > 0);`.
- A function with an `ensures` clause cannot use `tail return`.
- A loop's `invariant` cannot name the variable of a `for … in` loop.

## Constructors

Replaces a constructor body that assigns `this.x = x`. Every field is
initialized before the body runs, so no code sees a half-built object. The
body is ordinary code: like a method, it cannot assign a field that is not
`var`.

```zena
class Rect {
  width: f64;
  height: f64;
  area: f64;
  var label: String = '';   // an initializer; `var`, so the body may assign it

  // An initializer list computes fields from parameters.
  new(w: f64, h: f64) : width = w, height = h, area = w * h;

  // A named constructor, called as `new Rect.square(2.0)`.
  new square(side: f64) : width = side, height = side, area = side * side {
    this.label = 'square';
  }
}

class Tile extends Rect {
  color: String;

  // `this.color` initializes the field. `super(…)` goes last in the list.
  new(this.color, side: f64) : super(side, side);
}

export function main(): i32 {
  let tile = new Tile('red', 3.0);
  console.log(`${tile.color} ${new Rect.square(2.0).label}`);
  return tile.area as i32;
}
```

## Distinct types

Replaces `type UserId = String` and bare numbers that stand for a unit. A
distinct type is erased at run time, keeps its base type's operations, and
does not mix with the base type or with another distinct type without `as`.
Any code can cast into a distinct type. An `opaque type` allows that cast
only in the library that declares it, so a value of the type must have come
through that library's functions.

```zena
distinct type UserId = String;
distinct type Meters = f64;
distinct type Seconds = f64;

function speed(distance: Meters, time: Seconds): f64 {
  return (distance as f64) / (time as f64);
}

function greet(id: UserId): String {
  return `hello ${id as String}`;
}

// Only this library can make a Slug, so every Slug has been checked.
opaque type Slug = String;

function slug(text: String): inline (true, Slug) | (false, _) {
  for (let byte in text.utf8) {
    if (byte == (32 as u8)) {
      return (false, _);
    }
  }
  return if (text.isEmpty) (false, _) else (true, text as Slug);
}

export function main(): i32 {
  let id = 'u-17' as UserId;
  console.log(greet(id));
  // speed(2.0 as Seconds, 10.0 as Meters) is a type error.
  if (let (true, s) = slug('first-post')) {
    console.log(s as String);
  }
  return speed(10.0 as Meters, 2.0 as Seconds) as i32;
}
```

## `using`

Replaces `try { … } finally { x.close(); }`. The value is released on every
way out of the block, in reverse order of declaration.

```zena
import {Disposable} from 'zena:core';

class Timer implements Disposable {
  label: String;
  new(this.label) {
    console.log(`start ${this.label}`);
  }

  [Disposable.dispose](): void {
    console.log(`stop ${this.label}`);
  }
}

function work(fail: boolean): i32 {
  using outer = new Timer('outer');
  using inner = new Timer('inner');
  if (fail) {
    throw new Error('failed');   // stops inner, then outer
  }
  return 0;                      // the same
}

export function main(): i32 {
  return try {
    work(true)
  } catch (e) {
    1
  };
}
```

For a resource that has to outlive one block (a file handle returned from a
function or stored in an object), declare a `resource class` and hold it as
`Own<T>`. See "Ownership" below.

## Extension classes and mixins

An extension class replaces a wrapper object around one value. It is a
typed view of the value with its own methods: the wrapper is erased, so a
`Path` is a `String` at run time, and `as` moves between the two at no
cost. A mixin replaces a base class that exists only to share methods.

```zena
extension class Path on String {
  new(text: String) : super(text);

  segments(): i32 {
    return (this as String).split('/').length;
  }
}

mixin Described {
  abstract name: String;

  describe(): String {
    return `<${this.name}>`;
  }
}

class Tool(name: String) with Described

export function main(): i32 {
  console.log(new Tool('hammer').describe());
  let path = new Path('usr/local/bin');
  let same = '/tmp' as Path;   // a view of an existing String
  return path.segments() + same.segments();
}
```

## Operators

Replaces `a.plus(b)`, `a.equals(b)` and `table.get(i)`. `operator []`
reads an index and `operator []=` writes one. Declaring
`compareTo` gives a class `<`, `<=`, `>` and `>=`.

```zena
class Money(cents: i64) {
  operator +(other: Money): Money {
    return new Money(this.cents + other.cents);
  }

  compareTo(other: Money): i32 {
    return if (this.cents < other.cents) -1
      else if (this.cents > other.cents) 1
      else 0;
  }
}

class Histogram {
  #buckets = new FixedArray<i32>(10, 0);

  operator [](bucket: i32): i32 {
    return this.#buckets[bucket];
  }

  operator []=(bucket: i32, count: i32): void {
    this.#buckets[bucket] = count;
  }
}

export function main(): i32 {
  let histogram = new Histogram();
  histogram[3] = 7;
  histogram[3] += 1;
  let richer = new Money(500) + new Money(1) > new Money(500);
  // A case class's `==` compares fields.
  let equal = new Money(5) == new Money(5);
  return if (richer && equal) histogram[3] else 0;
}
```

## Pipelines, ranges and iteration

`|>` replaces nested calls: `$` is the value from the left. `for … in`
replaces an index loop, and works on arrays, maps, ranges, strings and any
`Iterable`.

```zena
import {fixed} from 'zena:core';

function double(n: i32): i32 {
  return n * 2;
}

function clamp(n: i32, low: i32, high: i32): i32 {
  return if (n < low) low else if (n > high) high else n;
}

// A generator is an Iterator.
gen function evens(limit: i32): Iterator<i32> {
  for (let n in 0..limit) {
    if (n % 2 == 0) {
      yield n;
    }
  }
}

export function main(): i32 {
  let piped = 7 |> double($) |> clamp($, 0, 10) |> $ + 1;   // 11

  var sum = 0;
  for (let n in evens(10)) {
    sum += n;                                 // 0 + 2 + 4 + 6 + 8
  }

  let scores = {'ada' => 3, 'bob' => 5};      // a Map literal
  for (let {key, value} in scores) {          // a MapEntry
    console.log(`${key}: ${value}`);
  }

  let squares = [1, 2, 3].map((n) => n * n);  // callbacks need no annotations
  let middle = fixed([1, 2, 3, 4, 5])[1..4];  // [2, 3, 4]
  return piped + sum + squares[2] + middle.length;
}
```

To make a class iterable, implement `Iterable<T>` with the symbol-keyed
method `[Iterable.iterator]()`:

```zena
import {IterableUtils} from 'zena:core';

// IterableUtils supplies `map`, `filter`, `fold` and the rest of Iterable.
class Countdown with IterableUtils<i32> implements Iterable<i32> {
  from: i32;
  new(this.from);

  gen [Iterable.iterator](): Iterator<i32> {
    for (var n = this.from; n > 0; n -= 1) {
      yield n;
    }
  }
}

export function main(): i32 {
  var sum = 0;
  for (let n in new Countdown(3)) {
    sum += n;
  }
  return sum;
}
```

## Symbol-keyed members

Replaces a method name chosen to avoid collisions (`__inspect`,
`toDebugString`). A symbol is a member name that only code importing the
symbol can use. It is resolved at compile time. Protocols such as
`Iterable.iterator` and `Disposable.dispose` are symbols.

```zena
interface Inspectable {
  static symbol inspect;
  [Inspectable.inspect](): String;
}

// A symbol at the top level. Without `export`, only this library can call
// the members it names.
symbol audit;

class User implements Inspectable {
  name: String;
  new(this.name);

  [Inspectable.inspect](): String {
    return `User(${this.name})`;
  }

  [audit](): i32 {
    return this.name.utf8.length;
  }
}

export function main(): i32 {
  let user = new User('ada');
  // A dot before the bracket. `user[audit]()` would be an index.
  console.log(user.[Inspectable.inspect]());
  return user.[audit]();
}
```

## Strings

A `String` is Unicode text, and it has no integer index. Replaces `s[i]`,
`s.length` and loops over UTF-16 units. Iterating a string gives grapheme
clusters, which are what a reader sees as characters.

```zena
import {StringBuilder} from 'zena:core';

function initials(name: String): String {
  let out = new StringBuilder();
  for (let word in name.split(' ')) {
    if (!word.isEmpty) {
      out.append(word[word.startIndex]);   // the first grapheme
    }
  }
  return out.toString();
}

export function main(): i32 {
  let text = 'café 😀';
  var graphemes = 0;
  for (let g in text) {
    graphemes += 1;                        // 6
  }
  let bytes = text.utf8.length;            // 10
  let points = text.codePoints.count();    // 6

  // Slices take StringIndex ranges and share storage with the original.
  let second = text.indexAfter(text.startIndex);
  let rest = text[second..];               // 'afé 😀'

  console.log(`${initials('grace brewster hopper')} ${rest}`);
  return graphemes + bytes + points;
}
```

For parsing, use `StringReader` from `zena:core` (a cursor with `peekByte`,
`advance`, `mark` and `sliceFrom`) or `zena:regex`.

## Async and cancellation

`async` functions return `Future<T>` and start running when called.
Cancellation replaces an `AbortSignal` passed down a call chain: every
`await` is a checkpoint, a `TaskGroup` owns the right to cancel what it
started, and cancellation passes `catch` blocks without entering them.

```zena
import {TaskGroup} from 'zena:async';
import {milliseconds, sleep} from 'zena:time';

async function fetchSlowly(label: String): Future<String> {
  try {
    await sleep(milliseconds(50));
    return label;
  } cancel {
    console.log(`${label} cancelled`);   // runs, and the unwind continues
  } finally {
    console.log(`${label} cleaned up`);
  }
}

export async function main(): Future<i32> {
  // Calling starts both. Awaiting later lets them run concurrently.
  let a = fetchSlowly('a');
  let b = fetchSlowly('b');
  let both = `${await a}${await b}`;

  let group = new TaskGroup();
  let abandoned = group.spawn(() => fetchSlowly('c'));
  group.cancel();

  return both.utf8.length;
}
```

`shielded { … }` holds off cancellation for cleanup that must `await`.
`checkCancellation()` from `zena:async` is a checkpoint for a long loop that
never awaits. `Future.all` and `Future.race` combine futures.

## Ownership

For handles that garbage collection cannot release: files, sockets, WASI and
Component Model resources. A `resource class` is always held as `Own<T>`
(one owner; assigning or passing it moves it; it is released when its owner
goes out of scope) or `Borrow<T>` (a loan that lives only in parameters and
locals, so it needs no lifetime annotations).

```zena
import {Borrow, Disposable, Own} from 'zena:core';

resource class Connection {
  id: i32;
  new(this.id);

  [Disposable.dispose](this: Own<this>): void {
    console.log(`closed ${this.id}`);
  }
}

function open(id: i32): Own<Connection> {
  return new Connection(id);
}

function describe(connection: Borrow<Connection>): i32 {
  return connection.id;            // reads; does not release
}

function consume(connection: Own<Connection>): void {
  // released when this function returns
}

export function main(): i32 {
  let first = open(1);
  let id = describe(first);        // lends `first`
  consume(first);                  // moves it; `first` cannot be used again
  let second = open(2);
  return id + describe(second);    // `second` is released at the end of main
}
```

A resource class can own others in its fields (`socket: Own<Socket>`):
reading such a field borrows it, and the fields are released with their
owner. A borrow that must stay alive across an `await` or inside a
generator is typed `Scoped<Future<T>>` or `Scoped<Iterator<T>>`.
`Unmanaged<T>`, with `disown` and `adopt` from `zena:core`, opts a handle
out of the checks.

This part of the language is still changing. Read
`https://zena-lang.dev/reference/ownership/` before designing around it.

## Concrete collection types

`Array<T>`, `MutableArray<T>`, `Map<K, V>` and `Set<T>` are interfaces. A
value typed as an interface is carried as an object plus a method table, and
each call through it is indirect. Annotate fields, parameters and locals
with the class unless the code accepts several implementations.

```zena
import {HashMap, HashSet} from 'zena:collections';

class Index {
  // `new Map<K, V>()` and `new Array<T>()` build a HashMap and a
  // GrowableArray, and an unannotated field takes that class type.
  #byName = new Map<String, i32>();
  #seen = new HashSet<String>();
  #order = new Array<String>();

  add(name: String): void {
    if (!this.#seen.has(name)) {
      this.#seen.add(name);
      this.#byName[name] = this.#order.length;
      this.#order.push(name);
    }
  }

  size: i32 {
    get {
      return this.#order.length;
    }
  }
}

// A parameter typed as the interface accepts any array, at the cost above.
function total(values: Array<i32>): i32 {
  return values.fold(0, (sum, v) => sum + v);
}

export function main(): i32 {
  let index = new Index();
  index.add('a');
  index.add('a');
  let counts: HashMap<String, i32> = {'a' => 1};
  return index.size + total([1, 2, 3]) + counts.size;
}
```
