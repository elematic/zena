#!/usr/bin/env python3
"""Generates tests/bigint/bigint-reference.zena from Python's arbitrary-precision int.

Each table holds deterministic edge cases plus seeded random multi-limb cases
so running the script again writes the identical file:

    python3 packages/stdlib/scripts/generate-bigint-reference.py
"""

import os
import random

OUT = os.path.join(
    os.path.dirname(__file__), '..', 'tests', 'bigint', 'bigint-reference.zena'
)

rng = random.Random(882)

B64 = 1 << 64
U64_MAX = B64 - 1
I64_MIN = -(1 << 63)
I64_MAX = (1 << 63) - 1


def fmt_hex(n: int) -> str:
    if n < 0:
        return f'-0x{(-n):x}'
    return f'0x{n:x}'


def to_base(n: int, radix: int) -> str:
    if n == 0:
        return '0'
    neg = n < 0
    v = -n if neg else n
    alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
    digits = []
    while v > 0:
        v, rem = divmod(v, radix)
        digits.append(alphabet[rem])
    if neg:
        digits.append('-')
    return ''.join(reversed(digits))


def trunc_divmod(a: int, b: int) -> tuple[int, int]:
    q_mag, r_mag = divmod(abs(a), abs(b))
    q = -q_mag if ((a < 0) != (b < 0) and q_mag != 0) else q_mag
    r = -r_mag if (a < 0 and r_mag != 0) else r_mag
    assert q * b + r == a
    return q, r


def rand_limbs(num_limbs: int, signed: bool = True) -> int:
    if num_limbs == 0:
        return 0
    val = 0
    for i in range(num_limbs):
        if i == num_limbs - 1:
            limb = rng.randint(1, U64_MAX)
        else:
            limb = rng.randint(0, U64_MAX)
        val |= limb << (64 * i)
    if signed and rng.random() < 0.5:
        val = -val
    return val


def table(name: str, rows: list[tuple[str, ...]]) -> str:
    body = '\n'.join(' '.join(r) for r in rows)
    return f'export let {name} = `{body}`;\n'


def build_add_sub() -> list[tuple[str, ...]]:
    edges = [
        0, 1, -1, I64_MIN, I64_MAX, U64_MAX, -U64_MAX,
        B64, -B64, B64 + 1, -(B64 + 1),
        (1 << 128) - 1, -((1 << 128) - 1), 1 << 128, -(1 << 128),
        (1 << 256) - 1, -((1 << 256) - 1),
    ]
    pairs: list[tuple[int, int]] = []
    for a in edges:
        for b in [0, 1, -1, U64_MAX, -B64, (1 << 128) - 1]:
            pairs.append((a, b))
    for _ in range(45):
        la = rng.choice([1, 2, 3, 5, 12, 35])
        lb = rng.choice([1, 2, 3, 5, 12, 35])
        pairs.append((rand_limbs(la), rand_limbs(lb)))
    return [
        (fmt_hex(a), fmt_hex(b), fmt_hex(a + b), fmt_hex(a - b))
        for a, b in pairs
    ]


def build_mul() -> list[tuple[str, ...]]:
    pairs: list[tuple[int, int]] = [
        (0, 0),
        (0, -(1 << 200)),
        (1, (1 << 192) - 1),
        (-1, (1 << 192) - 1),
        (U64_MAX, U64_MAX),
        (-U64_MAX, U64_MAX),
        (I64_MIN, I64_MIN),
        ((1 << 128) - 1, (1 << 128) - 1),
        # Karatsuba threshold boundaries (threshold = 32 limbs):
        ((1 << (64 * 31)) - 1, (1 << (64 * 31)) - 1),
        ((1 << (64 * 32)) - 1, (1 << (64 * 32)) - 1),
        ((1 << (64 * 33)) - 1, (1 << (64 * 33)) - 1),
        # Sparse high + low limbs across Karatsuba split:
        ((1 << (64 * 34)) + 1, (1 << (64 * 34)) + 1),
        (-((1 << (64 * 34)) + 7), (1 << (64 * 33)) + 9),
    ]
    limb_shapes = [
        (1, 3), (2, 2), (4, 4), (8, 8), (16, 16),
        (31, 31), (31, 32), (32, 32), (32, 33), (33, 33),
        # Asymmetric `bLen <= half` Karatsuba branch:
        (48, 20), (64, 32), (70, 33),
        # Multi-level Karatsuba recursion:
        (64, 64), (65, 65), (75, 75),
    ]
    for la, lb in limb_shapes:
        pairs.append((rand_limbs(la), rand_limbs(lb)))
        pairs.append((rand_limbs(lb), rand_limbs(la)))
    return [(fmt_hex(a), fmt_hex(b), fmt_hex(a * b)) for a, b in pairs]


def build_div_rem() -> list[tuple[str, ...]]:
    pairs: list[tuple[int, int]] = [
        (0, 1),
        (0, -(1 << 130)),
        (7, 3), (-7, 3), (7, -3), (-7, -3),
        (U64_MAX, 3),
        (U64_MAX, 0x8000000000000001),
        ((1 << 192) - 1, U64_MAX),
        ((1 << 192) - 1, 10**19),
        # Knuth Algorithm D step D6 add-back trigger (qhat = 2 -> 1):
        (1 << 192, (1 << 191) + 1),
        (-(1 << 192), (1 << 191) + 1),
        (1 << 192, -((1 << 191) + 1)),
        (-(1 << 192), -((1 << 191) + 1)),
        # Unnormalized D6 trigger (s > 0 in D1):
        ((1 << 192) << 11, ((1 << 191) + 1) << 11),
        ((1 << 256) + (1 << 192), (1 << 191) + 1),
        # Knuth Algorithm D step D3 `uHi == vn1` clamp cases:
        ((U64_MAX << 128) | (U64_MAX << 64) | U64_MAX, (U64_MAX << 64) | 1),
        ((U64_MAX << 128) | U64_MAX, (U64_MAX << 64) | U64_MAX),
        (((1 << 127) << 64) | 0, ((1 << 127) - 1)),
    ]
    shapes = [
        (2, 1), (4, 1), (8, 1),
        (2, 2), (3, 2), (4, 2), (5, 3),
        (8, 4), (16, 8), (36, 18), (40, 33),
        (2, 5),
    ]
    for la, lb in shapes:
        for _ in range(3):
            u = rand_limbs(la)
            v = rand_limbs(lb, signed=True)
            if v == 0:
                v = 1
            pairs.append((u, v))
    rows = []
    for a, b in pairs:
        q, r = trunc_divmod(a, b)
        rows.append((fmt_hex(a), fmt_hex(b), fmt_hex(q), fmt_hex(r)))
    return rows


def build_pow() -> list[tuple[str, ...]]:
    cases = [
        (0, 0), (0, 1), (0, 17),
        (1, 0), (1, 999),
        (-1, 0), (-1, 999), (-1, 1000),
        (2, 0), (2, 64), (2, 65), (2, 256),
        (-2, 63), (-2, 64), (-2, 129),
        (-3, 71),
        (10, 80),
        (U64_MAX, 8),
        (-((1 << 100) + 7), 35),
        ((1 << 100) + 7, 40),
    ]
    return [(fmt_hex(b), str(e), fmt_hex(b ** e)) for b, e in cases]


def build_bitwise() -> list[tuple[str, ...]]:
    vals = [
        0, 1, -1, 6, -4, -6,
        0xdeadbeefcafebabe, -0xdeadbeefcafebabe,
        U64_MAX, -U64_MAX, B64, -B64, -(B64 + 1),
        (1 << 130) + 0x12345, -((1 << 130) + 0x12345),
    ]
    pairs: list[tuple[int, int]] = []
    for i in range(len(vals)):
        for j in range(i, len(vals)):
            pairs.append((vals[i], vals[j]))
    for _ in range(30):
        pairs.append((rand_limbs(rng.randint(1, 8)), rand_limbs(rng.randint(1, 8))))
    return [
        (
            fmt_hex(a),
            fmt_hex(b),
            fmt_hex(a & b),
            fmt_hex(a | b),
            fmt_hex(a ^ b),
            fmt_hex(~a),
        )
        for a, b in pairs
    ]


def build_shifts() -> list[tuple[str, ...]]:
    vals = [
        0, 1, -1, 7, -7, 8, -8,
        U64_MAX, -U64_MAX, B64, -B64, -(B64 + 1),
        rand_limbs(3, signed=False),
        -rand_limbs(3, signed=False),
        -(1 << 192),
        -((1 << 192) + 1),
    ]
    shifts = [0, 1, 7, 31, 32, 63, 64, 65, 127, 128, 129, 192, 255]
    rows = []
    for a in vals:
        for s in shifts:
            rows.append((fmt_hex(a), str(s), fmt_hex(a << s), fmt_hex(a >> s)))
    return rows


def build_gcd() -> list[tuple[str, ...]]:
    # Fibonacci pair F_200, F_201 has gcd 1 after maximum binary/Euclid steps.
    f0, f1 = 0, 1
    for _ in range(200):
        f0, f1 = f1, f0 + f1

    pairs: list[tuple[int, int]] = [
        (0, 0), (0, 15), (0, -15), (-15, 0),
        (12, 8), (-12, 8), (12, -8), (-12, -8),
        (U64_MAX, U64_MAX - 1),
        (f0, f1),
        (f0 * ((1 << 130) + 18), f1 * ((1 << 130) + 18)),
        ((1 << 200) * 35, (1 << 140) * 49),
    ]
    for _ in range(30):
        g = rand_limbs(rng.choice([1, 2, 4]), signed=False)
        x = rand_limbs(rng.choice([1, 3, 8, 20]))
        y = rand_limbs(rng.choice([1, 3, 8, 20]))
        pairs.append((g * x, g * y))

    import math
    return [(fmt_hex(a), fmt_hex(b), fmt_hex(math.gcd(a, b))) for a, b in pairs]


def build_mod_pow() -> list[tuple[str, ...]]:
    p127 = (1 << 127) - 1
    p521 = (1 << 521) - 1
    rsa_mod = rand_limbs(8, signed=False) | 1
    cases: list[tuple[int, int, int]] = [
        (0, 0, 1),
        (123456789, 0, 1),
        (123456789, 5, 1),
        (0, 0, 97),
        (0, 5, 97),
        (5, 0, 97),
        (-7, 0, 97),
        (-7, 1, 97),
        (-7, 19, 101),
        (-101, 19, 101),
        (2, p127 - 1, p127),
        (12345678901234567890, p127 - 1, p127),
        (-98765432109876543210, p127 - 1, p127),
        (3, p521 - 1, p521),
        (rand_limbs(8), 65537, rsa_mod),
        (rand_limbs(10), rand_limbs(4, signed=False), rsa_mod),
        (-rand_limbs(10, signed=False), rand_limbs(3, signed=False), rsa_mod),
    ]
    return [
        (fmt_hex(b), fmt_hex(e), fmt_hex(m), fmt_hex(pow(b, e, m)))
        for b, e, m in cases
    ]


def build_radix() -> list[tuple[str, ...]]:
    radices = [2, 3, 7, 8, 10, 12, 16, 20, 32, 36]
    vals = [
        0, 1, -1, 42, -42, I64_MIN, I64_MAX, U64_MAX, -U64_MAX,
        B64, -B64,
        rand_limbs(2, signed=False),
        -rand_limbs(3, signed=False),
        rand_limbs(8, signed=False),
        -rand_limbs(8, signed=False),
    ]
    rows = []
    for r in radices:
        for v in vals:
            rows.append((str(r), fmt_hex(v), to_base(v, r)))
    return rows


def main() -> None:
    # Fix small typo in to_base helper indentation if any; verified clean.
    sections = [
        '// Generated by packages/stdlib/scripts/generate-bigint-reference.py from',
        "// Python's int. Do not edit: run the script.",
        '',
        '/**',
        ' * Reference vectors for tests/bigint/bigint_test.zena, computed by',
        " * Python's arbitrary-precision int. Each table has one space-separated",
        ' * case per line.',
        ' */',
        '',
        table('ADD_SUB', build_add_sub()),
        table('MUL', build_mul()),
        table('DIV_REM', build_div_rem()),
        table('POW', build_pow()),
        table('BITWISE', build_bitwise()),
        table('SHIFTS', build_shifts()),
        table('GCD', build_gcd()),
        table('MOD_POW', build_mod_pow()),
        table('RADIX', build_radix()),
    ]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(sections))
    print(f'wrote {OUT}')


if __name__ == '__main__':
    main()
