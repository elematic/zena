# semver

Semantic versions (<https://semver.org>) and npm's version ranges
(<https://github.com/npm/node-semver#ranges>), for Zena.

```zena
import {Range, Version} from 'zena-lang:semver';

let range = Range.parse('^1.4.2 || ^2.0.0');
range.includes(Version.parse('1.7.0')); // true
range.includes(Version.parse('3.0.0')); // false
range.toString(); // '>=1.4.2 <2.0.0-0 || >=2.0.0 <3.0.0-0'
```

| Range            | Means              |
| ---------------- | ------------------ |
| `^1.4.2`         | `>=1.4.2 <2.0.0-0` |
| `^0.3.1`         | `>=0.3.1 <0.4.0-0` |
| `~1.4.2`         | `>=1.4.2 <1.5.0-0` |
| `1.4.2`          | exactly 1.4.2      |
| `1.x`, `1`       | `>=1.0.0 <2.0.0-0` |
| `1.2.3 - 2.3`    | `>=1.2.3 <2.4.0-0` |
| `>=1.4.2 <1.7.0` | both comparators   |
| `a \|\| b`       | either range       |

A pre-release is in a range only when the range names a pre-release of
the same `major.minor.patch`, as in npm: `^2.0.0` does not include
`2.1.0-rc.1`. Pass `includePrerelease` to `includes` to include them.

`highest` and `lowest` pick from a list of versions, and `intervals`
gives each comparator set as a pair of bounds.
