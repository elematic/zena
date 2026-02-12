export const prelude = `
import { String } from 'zena:string';
import { Error, IndexOutOfBoundsError } from 'zena:error';
import { Option, Some, None, some, none } from 'zena:option';
import { Sequence, MutableSequence } from 'zena:sequence';
import { BoundedRange, FromRange, ToRange, FullRange } from 'zena:range';
import { ImmutableArray } from 'zena:immutable-array';
import { FixedArray } from 'zena:fixed-array';
import { Array } from 'zena:growable-array';
import { console } from 'zena:console';
import { Map } from 'zena:map';
import { Box } from 'zena:box';
`;
