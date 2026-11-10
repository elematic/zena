---
title: 'Maps and Sets'
description: 'Map, HashMap, OrderedHashMap, Set, HashSet, OrderedHashSet, map literals, and the Hashable contract in Zena.'
---

Zena provides collections for key-value mappings and unique value sets,
featuring amortized O(1) lookups, insertions, and deletions.

## Maps

A map is a collection of key-value pairs where each key maps to at most one
value. Zena provides both unordered and insertion-ordered map implementations:

| Type                   | Kind      | Module / Import              | Description                                                     |
| :--------------------- | :-------- | :--------------------------- | :-------------------------------------------------------------- |
| `Map<K, V>`            | Interface | Prelude / `zena:collections` | Common key-value mapping interface                              |
| `HashMap<K, V>`        | Class     | Prelude / `zena:collections` | Unordered hash map using separate chaining                      |
| `OrderedHashMap<K, V>` | Class     | `zena:collections`           | Hash map preserving entry insertion order                       |
| `MapEntry<K, V>`       | Class     | Prelude / `zena:collections` | Bucket entry with immutable `key: K` and mutable `var value: V` |

`Map` and `HashMap` are included in the standard prelude and can be used in any
file without an import statement. `OrderedHashMap` is imported from
`'zena:collections'`.

```zena
import { OrderedHashMap } from 'zena:collections';

// Map and HashMap are available directly from the prelude:
let scores = new Map<String, i32>();
let ordered = new Map<String, i32>.ordered();
```

The `Map` interface has constructors of its own, so code that does not
care which implementation it gets can say `new Map()`. `new Map()` builds a
`HashMap` and `new Map.ordered()` an `OrderedHashMap`; both take an optional
initial capacity. The type arguments can be written at the call or come
from the context:

```zena
let scores = new Map<String, i32>();
let ordered: Map<String, i32> = new Map.ordered();
```

Keys of a map built this way must implement `Hashable` (see below), as
`HashMap`'s keys must.

### Map literals

Map literals construct a `HashMap<K, V>` using braces with the `=>` separator:

```zena
let counts = {'apples' => 5, 'oranges' => 12, 'bananas' => 8};
let lookup = {1 => 'first', 2 => 'second'};
```

The `=>` arrow distinguishes map literals from record literals (which use `:`).

#### Keys are expressions

In a map literal, the key position is an arbitrary expression evaluated at
runtime. This makes a map literal fundamentally different from a record literal:

- In a record literal `{foo: 2}`, `foo` is an identifier that statically names a
  record field (`rec.foo`).
- In a map literal `{foo => 1}`, `foo` is an **expression** that evaluates the
  variable or expression `foo` in scope to determine the key at runtime.

```zena
let foo = 'greeting';

// Record literal: 'foo' is a static field name
let record = {foo: 2};
let recordVal = record.foo; // 2

// Map literal: 'foo' is evaluated to produce the key ('greeting')
let map = {foo => 1};
let mapVal = map['greeting']; // 1

// To use the string literal 'foo' as a map key, it must be quoted:
let literalKeyMap = {'foo' => 1};

// Unquoted undefined identifiers will report an error:
let m = {unboundName => 42}; // @error("unboundName"): Variable 'unboundName' not found.
```

#### Inferred types

The compiler infers the key type `K` and value type `V` by unifying the types of
all entries in the literal:

```zena
// Inferred as HashMap<String, i32>:
let inventory = {
  'pencils' => 100,
  'erasers' => 25,
  'notebooks' => 40,
};
```

Key and value expressions are evaluated at runtime, allowing dynamic
computations:

```zena
let baseKey = 'user_';
let multiplier = 10;

let config = {
  baseKey + 'alpha' => multiplier * 1,
  baseKey + 'beta' => multiplier * 2,
};
```

#### Empty map construction

An empty pair of braces `{}` is reserved for record types and empty blocks. To
create an empty map, use the explicit constructor:

```zena
let emptyMap = new Map<String, i32>();
```

### Reading values

Zena provides multiple methods for reading values, tailored to whether a key is
guaranteed to exist, optional, or handled with a default.

```zena
let capitals = {
  'France' => 'Paris',
  'Japan' => 'Tokyo',
  'Kenya' => 'Nairobi',
};
```

#### 1. Index operator `m[key]`

The index operator `m[key]` returns the associated value directly. If the key is
not present in the map, it throws a `KeyNotFoundError`. Use `m[key]` when key
presence is an established invariant:

```zena
let city = capitals['France']; // 'Paris'

// Throws KeyNotFoundError:
let missing = capitals['Canada'];
```

#### 2. Allocation-free query `m.get(key)`

The `m.get(key)` method tests for presence and retrieves the value in a single
step, returning an inline tuple:

```zena
get(key: K): inline (true, V) | inline (false, _)
```

Because inline tuples compile directly to WebAssembly multi-value returns on the
stack, `get()` performs no heap allocation. It pairs directly with conditional
pattern binding or the nullish coalescing operator `??`:

```zena
// Pattern matching with if-let:
if (let (true, capital) = capitals.get('Japan')) {
  println('Capital: ' + capital);
}

// Fallback unwrapping with ??:
let countryCapital = capitals.get('Germany') ?? 'Unknown';
```

#### 3. Default fallback `m.getOr(key, defaultValue)`

The `getOr` method returns the value if the key exists, or the specified
fallback value if it is absent:

```zena
let capital = capitals.getOr('Brazil', 'Brasília');
```

#### 4. Optional object `m.getOption(key)`

The `getOption` method returns `Some(value)` when present and `None` when
absent:

```zena
let opt = capitals.getOption('France'); // Option<String>
```

`getOption` allocates an `Option` instance on the heap. Use `getOption` when the
result needs to be stored in a collection, returned from a function, or passed
as a first-class value. Use `get()` when inspecting the value locally.

### Inspecting and mutating maps

#### Checking presence and size

Use `has(key)` to determine whether a key exists without retrieving its value:

```zena
if (capitals.has('Kenya')) {
  println('Found Kenya');
}
```

The `size` property returns the current number of key-value pairs stored in the
map:

```zena
let total = capitals.size; // 3
```

#### Inserting and updating entries

The index assignment operator `m[key] = value` associates `value` with `key`. If
the key already exists, its associated value is updated; otherwise, a new entry
is added:

```zena
let cache = new Map<String, i32>();

cache['hits'] = 1;      // Inserts 'hits' => 1
cache['hits'] = 2;      // Updates 'hits' => 2
cache['misses'] = 0;    // Inserts 'misses' => 0
```

#### Removing entries

The `delete(key)` method removes the entry associated with `key` and returns
`true` if the key was present, or `false` if it was not found:

```zena
let removed = cache.delete('misses'); // true
let removedAgain = cache.delete('misses'); // false
```

The `clear()` method removes all entries from the map, resetting `size` to `0`:

```zena
cache.clear();
// cache.size is now 0
```

### Iterating over maps

`Map<K, V>` implements `Iterable<MapEntry<K, V>>`. Iterating over a map yields
`MapEntry<K, V>` instances.

#### Destructuring entries in `for-in`

Because `MapEntry<K, V>` defines fields `key: K` and `value: V`, entries can be
destructured directly in `for-in` loops:

```zena
let users = {'u101' => 'Alice', 'u102' => 'Bob'};

for (let {key, value} in users) {
  println(`${key}: ${value}`);
}
```

#### Modifying values during iteration

The `value` field of `MapEntry<K, V>` is mutable (`var value: V`). Modifying
`entry.value` updates the value stored in the map in place:

```zena
let counters = {'read' => 10, 'write' => 4};

for (let entry in counters) {
  entry.value += 1;
}

// counters['read'] is now 11
// counters['write'] is now 5
```

The `key` field of `MapEntry` is immutable (`let key: K`) and cannot be
reassigned.

#### Iterating keys

The `keys()` method returns an `Iterator<K>` over the map's keys:

```zena
let keyIterator = users.keys();
```

#### The `forEach` method

The `forEach` method executes a callback for each key-value pair in the map:

```zena
users.forEach((key: String, value: String): void => {
  println(`${key} -> ${value}`);
});
```

### Insertion ordering in `OrderedHashMap`

`OrderedHashMap<K, V>` is an insertion-ordered hash map imported from
`'zena:collections'`. It implements `Map<K, V>` and preserves the exact order in
which keys were inserted:

```zena
import { OrderedHashMap } from 'zena:collections';

let ordered = new Map<String, i32>.ordered();
ordered['banana'] = 1;
ordered['apple'] = 2;
ordered['cherry'] = 3;

// Iteration visits: 'banana', 'apple', 'cherry'
for (let {key, value} in ordered) {
  println(key);
}
```

#### Order preservation rules

`OrderedHashMap` maintains entry order through an internal doubly-linked list:

1. **Updating an existing key**: Reassigning `ordered[key] = newValue` updates
   the value in place but preserves the key's original position in the iteration
   sequence.
2. **Delete and re-insert**: Deleting a key with `delete(key)` and subsequently
   inserting it again appends it to the end of the iteration sequence.

```zena
let steps = new Map<String, i32>.ordered();
steps['setup'] = 1;
steps['build'] = 2;
steps['test'] = 3;

// Updating 'setup' keeps it first:
steps['setup'] = 10;

// Deleting and re-adding 'build' moves it to the end:
steps.delete('build');
steps['build'] = 20;

// Iteration order: 'setup', 'test', 'build'
```

#### Live iteration semantics

`OrderedHashMap` supports modifications during iteration:

- Entries added during iteration are visited by the active iterator.
- Entries deleted before the iterator reaches them are skipped.
- Deleting the entry the iterator is currently visiting does not invalidate the
  iterator; it advances to the next live successor.

## Sets

A set is a collection of unique values. Zena provides both unordered and
insertion-ordered set implementations in `'zena:collections'`:

| Type                | Kind      | Module / Import    | Description                                       |
| :------------------ | :-------- | :----------------- | :------------------------------------------------ |
| `Set<T>`            | Interface | `zena:collections` | Common unique-value collection interface          |
| `HashSet<T>`        | Class     | `zena:collections` | Unordered hash set backed by a `HashMap<T, null>` |
| `OrderedHashSet<T>` | Class     | `zena:collections` | Hash set preserving value insertion order         |

```zena
import { HashSet, OrderedHashSet } from 'zena:collections';

let ids = new Set<i32>();
let sequence = new Set<String>.ordered();
```

As with maps, the `Set` interface's own constructors build the standard
implementations: `new Set()` is a `HashSet` and `new Set.ordered()` an
`OrderedHashSet`.

```zena
import { Set } from 'zena:collections';

let ids = new Set<i32>();
let sequence: Set<String> = new Set.ordered();
```

### Set operations

#### Adding elements

The `add(value)` method inserts a value into the set. It returns `true` if the
value was newly added, and `false` if the value was already present:

```zena
let visited = new Set<String>();

let isNew1 = visited.add('alpha'); // true
let isNew2 = visited.add('beta');  // true
let isNew3 = visited.add('alpha'); // false (duplicate)

// visited.size is 2
```

#### Membership testing with `has()` and `[]`

A set supports membership testing via both the `has(value)` method and the
indexer operator `s[value]`. Both return a `boolean`:

```zena
let activeRoles = new Set<String>();
activeRoles.add('admin');
activeRoles.add('editor');

// Using has():
if (activeRoles.has('admin')) {
  println('User is an admin');
}

// Using indexer operator:
if (activeRoles['editor']) {
  println('User is an editor');
}
```

#### Removing elements

The `delete(value)` method removes a value from the set, returning `true` if the
value was present and removed, or `false` if it was not in the set:

```zena
let removed = activeRoles.delete('editor'); // true
let removedAgain = activeRoles.delete('editor'); // false
```

The `clear()` method removes all elements from the set, resetting `size` to `0`:

```zena
activeRoles.clear();
// activeRoles.size is 0
```

### Iterating over sets

`Set<T>` extends `Iterable<T>`. Iterating over a set yields each element
directly:

```zena
let fruits = new Set<String>.ordered();
fruits.add('mango');
fruits.add('peach');
fruits.add('kiwi');

// Iteration visits in insertion order: 'mango', 'peach', 'kiwi'
for (let fruit in fruits) {
  println(fruit);
}
```

- **`HashSet<T>`**: Iteration order is unspecified and can change when the set
  resizes.
- **`OrderedHashSet<T>`**: Iteration order strictly matches insertion order.
  Re-adding a value that already exists preserves its position in the iteration
  sequence. Deleting a value and adding it again moves it to the end.

## Keys, hashing, and equality

The concrete hash-based collections (`HashMap<K, V>`, `OrderedHashMap<K, V>`,
`HashSet<T>`, and `OrderedHashSet<T>`) constrain their key and element types to
the `Hashable` interface (`K extends Hashable`, `T extends Hashable`). The
general `Map<K, V>` and `Set<T>` interfaces remain unconstrained, allowing
non-hash implementations.

### The `Hashable` contract

The `Hashable` interface defines a single method:

```zena
export interface Hashable {
  hashCode(): i32;
}
```

The contract between equality and hashing requires:

> If `a == b`, then `hash(a) == hash(b)`.

Two values that compare equal with `==` must produce identical 32-bit hash
codes. The inverse is not required: two distinct values may produce identical
hash codes (a hash collision), though minimizing collisions ensures optimal O(1)
performance.

### Key immutability

Keys must remain immutable while stored in a map or set.

A map places an entry into a bucket based on the key's hash code at insertion
time and locates it on lookup using the key's equality and hash. If a key's
fields mutate while stored, its hash code changes. The entry becomes stranded in
its original bucket, making it impossible to find, delete, or update, even
though it remains counted in `size`.

Use immutable values as keys: primitives, `String`, enums, records, and case
classes.

### Built-in key types

Zena provides built-in hashing and equality for standard types:

#### 1. Primitives

- `i32`, `u32`, and `boolean` hash directly to their numeric values.
- `i64` and `u64` fold their 64-bit bits into a 32-bit hash by XORing high and
  low halves: `(val ^ (val >> 32)) as i32`.
- `f32` and `f64` hash their IEEE-754 bit patterns with `-0.0` normalized to
  `+0.0`, ensuring that `-0.0 == 0.0` produces an identical hash code.

#### 2. Strings

The `String` class implements `Hashable` using the 32-bit FNV-1a hash algorithm.
The computed hash code is cached on the string instance after the first
calculation, making repeated lookups efficient.

#### 3. Enums

Enums are represented as numeric values and hash to their underlying ordinal
value.

#### 4. Case classes

Case classes automatically implement `Hashable` and `operator ==`. The compiler
synthesizes a structural `hashCode()` and value-based equality comparison across
all constructor parameters:

```zena
class Point(x: i32, y: i32)

let grid = new Map<Point, String>();
grid[new Point(0, 0)] = 'origin';
grid[new Point(1, 2)] = 'target';

// Lookups match by value:
let name = grid[new Point(0, 0)]; // 'origin'
```

Standard library value classes such as [`BigInt`](/api/bigint/) (`zena:bigint`) and
[`Decimal`](/api/decimal/) (`zena:decimal`) also implement `Hashable` and
`operator ==`.

### Implementing `Hashable` on custom classes

To use a custom class as a key in a map or set, implement `Hashable` and
override `operator ==`:

```zena
import { Hashable } from 'zena:core';

class UserId implements Hashable {
  id: i32;

  new(this.id);

  operator ==(other: UserId): boolean {
    return this.id == other.id;
  }

  hashCode(): i32 {
    return this.id;
  }
}
```

Classes that do not define an `operator ==` use reference equality (`===`),
comparing the identity of the instance. Such classes inherit an identity hash
code that remains stable throughout the lifetime of the object.

## Performance and representation

Zena's maps and sets are engineered for predictable memory footprints and high
throughput on WebAssembly GC.

### Table structure and resizing

`HashMap<K, V>` uses a separate-chaining hash table backed by a power-of-two
bucket array:

```wat
;; Buckets are a WebAssembly GC array of nullable entry references:
(type $BucketArray (array (mut (ref null $MapEntry))))
```

- **Power-of-two sizing**: Table capacities are always powers of two (default
  initial capacity is 16). Bucket indexing uses bitwise AND masking:
  `bucketIndex = hash & (buckets.length - 1)`.
- **Load factor**: The table resizes when `size * 4 >= buckets.length * 3` (a
  75% load factor). Resizing allocates a new bucket array of twice the capacity
  and rehashes all live entries.

### `OrderedHashMap` memory layout

`OrderedHashMap<K, V>` subclasses `HashMap<K, V>`. Instead of standard
`MapEntry<K, V>` instances, it allocates `OrderedEntry<K, V>` nodes:

```zena
final class OrderedEntry<K, V> extends MapEntry<K, V> {
  var next: OrderedEntry<K, V> | null = null;
  var previous: OrderedEntry<K, V> | null = null;
  var removed: boolean = false;
}
```

These entries form a doubly-linked list threaded through the hash table:

- **Lookups**: Bucket lookups follow standard hash collision chains and incur no
  ordering overhead.
- **Iteration**: Iterators traverse the doubly-linked list directly from `#head`
  to `#tail`, visiting only live entries without scanning empty buckets.
- **Rehashing**: When the table doubles, entries are relinked into new buckets.
  The doubly-linked order list is unchanged, requiring no new node allocations
  during a rehash.

### `Set` implementation via `MapBackedSet`

`HashSet<T>` and `OrderedHashSet<T>` are implemented as wrappers around
`HashMap<T, null>` and `OrderedHashMap<T, null>`, respectively. A singleton
`null` reference is stored as the value for each entry.

Because `HashSet` and `OrderedHashSet` delegate directly to their backing maps,
set operations share identical asymptotic performance and memory guarantees with
maps.

### Zero-allocation queries

Methods that return inline tuples, such as `get(key): inline (true, V) | inline
(false, _)`,
compile to WebAssembly functions returning two values on the evaluation stack:

```wat
(func $HashMap_get (param (ref $HashMap) (ref $Key)) (result i32 (ref null $Val))
  ;; Returns tag (1 or 0) and the value or null in registers
)
```

This ensures that querying a map requires zero GC heap allocations and leaves no
garbage for the WebAssembly GC to collect.
