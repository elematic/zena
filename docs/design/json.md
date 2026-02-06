# JSON Parser Design

## Overview

A JSON parser for Zena that uses a hybrid union/class design for ergonomic access.

## Data Model

```zena
// Primitive values use standard types (JS-like)
type JsonPrimitive = string | Box<f64> | Box<boolean> | null;

// Container classes for objects and arrays
class JsonObject {
  operator [](key: string): JsonValue | null;
  operator []=(key: string, value: JsonValue): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  size: i32 { get; }
}

class JsonArray {
  operator [](index: i32): JsonValue;
  operator []=(index: i32, value: JsonValue): void;
  length: i32 { get; }
  push(value: JsonValue): void;
}

// The union type
type JsonValue = JsonObject | JsonArray | string | Box<f64> | Box<boolean> | null;
```

## Type Checking

Use `is` operator:

```zena
if (value is JsonObject) { ... }
if (value is JsonArray) { ... }
if (value is string) { ... }
if (value is Box<f64>) { let n = value as f64; ... }
if (value is Box<boolean>) { let b = value as boolean; ... }
if (value == null) { ... }
```

## Parsing

```zena
// Basic parsing
let value = parseJson('{"name": "Alice"}');

// With options
let value = parseJson(input, new JsonOptions {
  allowComments: true,    // JSONC mode (// and /* */)
  trackLocations: true    // Enable source location tracking
});
```

## Source Location (Optional)

When `trackLocations: true`, containers store location info:

```zena
let obj = value as JsonObject;
let loc = obj.locationOf("name");  // SourceLocation | null
// loc.line, loc.column, loc.endLine, loc.endColumn
```

Only available on JsonObject and JsonArray since primitives are unwrapped.

## jq-Style Queries

Standalone functions for path-based access:

```zena
// Simple path access
let name = jsonGet(value, ".user.name");        // JsonValue | null
let first = jsonGet(value, ".items[0]");        // JsonValue | null
let nested = jsonGet(value, ".a.b.c[2].d");     // JsonValue | null

// With default
let port = jsonGetOr(config, ".server.port", new Box(8080));
```

## Key Order

**Phase 1**: Uses standard `Map<string, JsonValue>` (no order guarantee).

**TODO Phase 2**: Implement `OrderedMap` that preserves insertion order for JSON round-tripping.

## Error Handling

```zena
class JsonParseError extends Error {
  line: i32;
  column: i32;

  #new(message: string, line: i32, column: i32) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

// Parsing throws on invalid JSON
try {
  let value = parseJson(malformed);
} catch (e: JsonParseError) {
  console.log(`Parse error at ${e.line}:${e.column}: ${e.message}`);
}
```

## API Summary

```zena
// Types
type JsonValue = JsonObject | JsonArray | string | Box<f64> | Box<boolean> | null;
class JsonObject { ... }
class JsonArray { ... }
class JsonOptions { allowComments: boolean; trackLocations: boolean; }
class JsonParseError extends Error { line: i32; column: i32; }
class SourceLocation { line: i32; column: i32; endLine: i32; endColumn: i32; }

// Functions
parseJson(input: string, options?: JsonOptions): JsonValue;
jsonGet(value: JsonValue, path: string): JsonValue | null;
jsonGetOr<T>(value: JsonValue, path: string, defaultValue: T): T;
```
