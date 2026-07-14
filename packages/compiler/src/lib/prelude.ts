export const prelude = `
import { Iterable, Iterator } from 'zena:iterator';
import { Sequence, MutableSequence } from 'zena:sequence';
import { IterableUtils } from 'zena:iterable-utils';
import { ArrayIterator } from 'zena:array-iterator';
import { BoundedRange, FromRange, ToRange, FullRange } from 'zena:range';
import { ImmutableArray } from 'zena:immutable-array';
import { FixedArray } from 'zena:fixed-array';
import { String } from 'zena:string';
import { Error, IndexOutOfBoundsError, unreachable } from 'zena:error';
import { Array } from 'zena:growable-array';
import { Option, Some, None, some, none } from 'zena:option';
import { console } from 'zena:console';
import { Map, HashMap } from 'zena:map';
import { Box } from 'zena:box';
import { i32ToString, u32ToString, i64ToString, u64ToString, boolToString, f32ToString, f64ToString } from 'zena:string-convert';
`;
