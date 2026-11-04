#!/usr/bin/env python3
"""Generates tests/math/libm-reference.zena: inputs for each function in
zena:math's libm port with their correctly rounded results.

The results come from MPFR, through gmpy2, in an IEEE binary64 context
(or binary32 for the f32 tables), so each is the true value rounded to
nearest with subnormals and overflow as a double has them. The inputs
are drawn from a seeded generator plus the edges of each function's
domain, so running the script again writes the same file.

Run it with a Python that has gmpy2, for example:

    nix shell --impure --expr \\
      'with import (builtins.getFlake "nixpkgs") {}; python3.withPackages (ps: [ps.gmpy2])' \\
      -c python3 packages/stdlib/scripts/generate-libm-reference.py
"""

import math
import os
import random
import struct
import sys

import gmpy2
from gmpy2 import mpfr

OUT = os.path.join(os.path.dirname(__file__), '..', 'tests', 'math', 'libm-reference.zena')

rng = random.Random(879)

INF = float('inf')
MAX = sys.float_info.max
MIN_NORMAL = sys.float_info.min
MIN_SUBNORMAL = 5e-324
F32_MAX = 3.4028234663852886e38
F32_MIN_NORMAL = 1.1754943508222875e-38
F32_MIN_SUBNORMAL = 1.401298464324817e-45


def to_f32(x):
    """x rounded to the nearest f32, as a float."""
    if abs(x) >= 2.0 ** 128 - 2.0 ** 103:
        return math.copysign(INF, x)  # at or past the halfway point to 2^128
    return struct.unpack('<f', struct.pack('<f', x))[0]


def text(x):
    if x != x:
        return 'NaN'
    if x == INF:
        return 'Infinity'
    if x == -INF:
        return '-Infinity'
    return repr(x)


def text32(x):
    """The shortest decimal that parses to the f32 x (as a float)."""
    if x != x or x in (INF, -INF) or x == 0:
        return text(x)
    for digits in range(1, 18):
        s = f'{x:.{digits}g}'
        if to_f32(float(s)) == x:
            return s
    return repr(x)


# --- input generators -----------------------------------------------------

def log_uniform(lo, hi, sign=False):
    """A double with a uniformly random binary exponent in [lo, hi] and a
    random significand; negative half the time when sign is set."""
    e = rng.uniform(lo, hi)
    x = 2.0 ** e
    if sign and rng.random() < 0.5:
        x = -x
    return x


def uniform(lo, hi):
    return rng.uniform(lo, hi)


def neighbors(x, k):
    """x and its k nearest doubles on each side."""
    out = [x]
    up = down = x
    for _ in range(k):
        up = math.nextafter(up, INF)
        down = math.nextafter(down, -INF)
        out += [up, down]
    return out


def near(x):
    return neighbors(x, 2)


def pm(xs):
    return [x for v in xs for x in (v, -v)]


# --- the tables -----------------------------------------------------------

def unary(fn, inputs):
    rows = []
    for x in inputs:
        y = float(fn(mpfr(x)))
        rows.append((x, y))
    return rows


def binary(fn, inputs):
    rows = []
    for x, y in inputs:
        z = float(fn(mpfr(x), mpfr(y)))
        rows.append((x, y, z))
    return rows


def ternary(fn, inputs):
    rows = []
    for x, y, z in inputs:
        w = float(fn(mpfr(x), mpfr(y), mpfr(z)))
        rows.append((x, y, z, w))
    return rows


LN2 = 0.6931471805599453

exp_inputs = (
    [uniform(-745, 710) for _ in range(60)]
    + [log_uniform(-60, 0, sign=True) for _ in range(40)]
    + near(0.5 * LN2) + near(-0.5 * LN2) + near(1.5 * LN2) + near(-1.5 * LN2)
    + near(709.782712893384) + near(-708.3964185322641) + near(-745.1332191019411)
    + [uniform(-745, -708) for _ in range(16)]
    + [1.0, -1.0, 2.0, 10.0, -10.0, 1e-300, -1e-300, MIN_SUBNORMAL, MIN_NORMAL]
)

expm1_inputs = (
    [uniform(-40, 710) for _ in range(50)]
    + [log_uniform(-60, 2, sign=True) for _ in range(50)]
    + near(0.5 * LN2) + near(-0.5 * LN2) + near(1.5 * LN2) + near(-1.5 * LN2)
    + near(-0.25) + near(56 * LN2) + near(709.782712893384)
    + [1.0, -1.0, 2.0, 10.0, -10.0, 1e-300, -1e-300, MIN_SUBNORMAL, 1e-17, -1e-17, 20.0, 56.0]
)

exp2_inputs = (
    [uniform(-1075, 1024) for _ in range(60)]
    + [log_uniform(-60, 3, sign=True) for _ in range(40)]
    + [float(k) for k in range(-10, 11)] + [k + 0.5 for k in range(-10, 11)]
    + near(1024.0) + near(-1075.0) + near(-1074.0) + near(-1022.0) + near(0.5) + near(-0.5)
    + [1023.5, 1023.999, -1074.5, -1074.9, 1e-300, -1e-300, MIN_SUBNORMAL]
)

log_inputs = (
    [log_uniform(-1074, 1024) for _ in range(80)]
    + [1 + 2.0 ** -k for k in range(1, 53, 2)] + [1 - 2.0 ** -k for k in range(1, 53, 2)]
    + near(math.sqrt(2)) + near(math.sqrt(2) / 2) + near(1.0)
    + [2.0 ** k for k in (-1074, -1022, -100, -1, 1, 10, 100, 1023)]
    + [10.0 ** k for k in (-300, -10, -1, 1, 2, 3, 10, 22, 300)]
    + [MIN_SUBNORMAL, MIN_NORMAL, MAX, 2.0, 3.0, 0.1, 0.5]
)

log1p_inputs = (
    [log_uniform(-60, 1000, sign=True) for _ in range(60)]
    + [-1 + 2.0 ** -k for k in range(1, 53, 2)]
    + [uniform(-0.3, 0.42) for _ in range(30)]
    + near(-0.2928932188134524) + near(0.41421356237309503) + near(0.0)
    + [1e-300, -1e-300, MIN_SUBNORMAL, 1e-17, -1e-17, 1.0, -0.5, 1e10, 2.0 ** 53, MAX]
)

trig_inputs = (
    [uniform(-10, 10) for _ in range(50)]
    + [log_uniform(-30, 60, sign=True) for _ in range(30)]
    + [log_uniform(60, 1024, sign=True) for _ in range(20)]
    + [x for k in range(1, 21) for x in near(k * math.pi / 2)]
    + near(1000001 * math.pi / 2)
    + [log_uniform(-60, -20, sign=True) for _ in range(8)]
    + [1e22, -1e22, 2.0 ** 1000, MAX, 0.5, 1.0, 0.6744, 0.7, 3.0, 1e6, 1e15, 1e16, 2.0 ** 52 + 1]
)

asin_inputs = (
    [uniform(-1, 1) for _ in range(60)]
    + pm([1 - 2.0 ** -k for k in range(1, 53, 3)])
    + near(0.5) + near(-0.5) + near(0.975) + near(-0.975) + near(1.0) + near(-1.0)
    + [log_uniform(-60, -1, sign=True) for _ in range(10)]
    + [MIN_SUBNORMAL, MIN_NORMAL, 1e-30, 0.1, 0.3, 0.7, 0.9, 0.99, 0.999]
)

atan_inputs = (
    [log_uniform(-30, 70, sign=True) for _ in range(90)]
    + near(0.4375) + near(0.6875) + near(1.1875) + near(2.4375) + near(1.0)
    + [log_uniform(-60, -27, sign=True) for _ in range(6)]
    + [2.0 ** 66, -2.0 ** 66, 1e300, MAX, MIN_SUBNORMAL, 0.5, 1.5, 2.0, 100.0]
)

atan2_inputs = (
    [(log_uniform(-30, 30, sign=True), log_uniform(-30, 30, sign=True)) for _ in range(90)]
    + [(uniform(-10, 10), uniform(-10, 10)) for _ in range(30)]
    + [(1.0, 2.0 ** 65), (1.0, -2.0 ** 65), (-1.0, -2.0 ** 65), (2.0 ** 65, 1.0), (2.0 ** 65, -1.0),
       (1e-300, 1.0), (1e-300, -1.0), (MAX, MAX), (MAX, -MAX), (MIN_SUBNORMAL, MIN_SUBNORMAL),
       (3.0, 4.0), (-3.0, 4.0), (3.0, -4.0), (-3.0, -4.0), (1.0, 1.0), (1.0, -1.0)]
)

sinh_inputs = (
    [uniform(-710, 710) for _ in range(50)]
    + [log_uniform(-30, 0, sign=True) for _ in range(40)]
    + near(709.782712893384) + near(-709.782712893384) + near(710.4758600739439) + near(1.0) + near(22.0)
    + [log_uniform(-60, -26, sign=True) for _ in range(6)]
    + [1e-300, MIN_SUBNORMAL, 0.5, 2.0, 10.0, 20.0, 100.0, 709.0, 710.0, -710.0, 710.4]
)

tanh_inputs = (
    [uniform(-25, 25) for _ in range(40)]
    + [log_uniform(-30, 2, sign=True) for _ in range(50)]
    + near(0.2554128118829953) + near(0.5493061443340549) + near(20.0) + near(-20.0) + near(0.1) + near(1.0)
    + [1e-300, MIN_SUBNORMAL, MIN_NORMAL, 30.0, -30.0, 1e300, 0.15, 0.2, 0.25]
)

asinh_inputs = (
    [log_uniform(-30, 1000, sign=True) for _ in range(90)]
    + [uniform(0.125, 0.5) for _ in range(20)]
    + near(2.0) + near(-2.0) + near(2.0 ** 26) + near(2.0 ** -26)
    + [1e-300, MIN_SUBNORMAL, MAX, 1.0, -1.0, 0.5, 10.0, 1e10]
)

acosh_inputs = (
    [1 + 2.0 ** k for k in range(-50, 11)]
    + [uniform(1, 1.125) for _ in range(20)]
    + [log_uniform(1, 1000) for _ in range(30)]
    + near(1.0) + near(2.0) + near(1.125) + near(2.0 ** 26)
    + [1.5, 3.0, 10.0, 1e10, 1e300, MAX]
)

atanh_inputs = (
    [uniform(-1, 1) for _ in range(50)]
    + pm([1 - 2.0 ** -k for k in range(1, 53, 3)])
    + near(0.5) + near(-0.5) + near(2.0 ** -32)
    + [log_uniform(-60, -2, sign=True) for _ in range(10)]
    + [1e-300, MIN_SUBNORMAL, 0.1, 0.3, 0.7, 0.9, 0.99, 0.999, -0.999]
)

cbrt_inputs = (
    [log_uniform(-1074, 1024, sign=True) for _ in range(100)]
    + [float(k ** 3) for k in (1, 2, 3, 5, 10, 100, 1000, 12345)]
    + [-27.0, 0.001, 2.0, 1e-300, MIN_SUBNORMAL, MIN_NORMAL, MAX, 2.0 ** 1023, 2.0 ** -1022]
)

hypot_inputs = (
    [(log_uniform(-30, 30, sign=True), log_uniform(-30, 30, sign=True)) for _ in range(80)]
    + [(x, x * 2.0 ** -k) for x in (1.0, 3.5, 1e100) for k in (1, 10, 26, 27, 40, 64, 65)]
    + [(MAX, MAX), (MAX, 1.0), (MAX / 2, MAX / 2), (1e300, 1e300), (1e-300, 1e-300),
       (MIN_SUBNORMAL, MIN_SUBNORMAL), (MIN_NORMAL, MIN_NORMAL), (3e-320, 4e-320),
       (3.0, 4.0), (5.0, 12.0), (8.0, 15.0), (1.0, 1.0), (0.3, 0.4), (1e-200, 1e200)]
)

pow_inputs = (
    [(log_uniform(-20, 20), uniform(-30, 30)) for _ in range(60)]
    + [(1 + log_uniform(-52, -20, sign=True), log_uniform(20, 60, sign=True)) for _ in range(20)]
    + [(-log_uniform(-10, 10), float(rng.randrange(-40, 41))) for _ in range(20)]
    + [(log_uniform(-1074, 1024), uniform(-3, 3)) for _ in range(20)]
    + [(x, y) for x in (2.0, 10.0, 0.5, 3.0) for y in (0.5, -0.5, 1.0, -1.0, 2.0, 3.0, 22.0, -22.0, 0.3, 1.5)]
    + [(2.0, y) for y in neighbors(1024.0, 2) + neighbors(-1075.0, 2) + neighbors(-1074.0, 2) + [1023.999, -1074.5, -1022.5, -1023.5]]
    + [(10.0, y) for y in (308.0, 308.25, -323.0, -323.6, -324.0, 309.0)]
    + [(x, 2.0 ** 60) for x in (1.0000000000000002, 0.9999999999999999, 1.0000001, 0.9999999)]
    + [(-2.0, 2.0 ** 53), (-2.0, 2.0 ** 53 + 2), (-2.0, 3.0), (-2.0, -3.0), (-2.0, 4.0), (-0.5, 1001.0),
       (MIN_SUBNORMAL, 0.5), (MIN_SUBNORMAL, 0.1), (MAX, 0.5), (MAX, -0.5), (1e-300, -1.0), (1e300, 1.01),
       (0.9, 1e4), (1.1, 1e4), (1.1, -1e4), (0.9, -1e4), (1.5, 2000.0), (0.75, 2500.0)]
)

fma_inputs = []
for _ in range(40):
    x = log_uniform(-20, 20, sign=True)
    y = log_uniform(-20, 20, sign=True)
    z = -(x * y) * (1 + rng.choice([0, 2.0 ** -52, -2.0 ** -52, 2.0 ** -40]))
    fma_inputs.append((x, y, z))
fma_inputs += [(log_uniform(-100, 100, sign=True), log_uniform(-100, 100, sign=True), log_uniform(-100, 100, sign=True)) for _ in range(30)]
fma_inputs += [
    (0.1, 10.0, -1.0), (1.0000000000000002, 1.0000000000000002, -1.0), (2.0, 3.0, 1.0),
    (1e308, 10.0, -1e308), (1e308, 10.0, -INF), (MIN_SUBNORMAL, 0.5, 0.0), (MIN_SUBNORMAL, 0.5, MIN_SUBNORMAL),
    (MIN_SUBNORMAL, 0.75, 0.0), (MIN_NORMAL, 0.5, MIN_NORMAL / 2), (MIN_NORMAL, 0.5, 0.0),
    (2.0 ** -537, 2.0 ** -537, 0.0), (2.0 ** -537, 2.0 ** -537, 2.0 ** -1074), (2.0 ** -1000, 2.0 ** -100, 1.0),
    (MAX, 2.0, -MAX), (MAX, 0.5, MAX / 2), (1.0, 1.0, 2.0 ** -53),
    (1.0 + 2.0 ** -52, 1.0 + 2.0 ** -52, -(1.0 + 2.0 ** -51)), (3.0, 1.0 / 3.0, -1.0),
    (-0.0, 1.0, -0.0), (0.0, 1.0, -0.0), (-0.0, 1.0, 0.0), (1.5, 2.0, -3.0), (-1.5, 2.0, 3.0),
    (2.0 ** 500, 2.0 ** 500, -2.0 ** 1000), (1e-310, 1e-310, 1e-320), (2.0 ** -1022, 2.0 ** -1022, 2.0 ** -1074),
]

# --- f32 tables: f32 inputs, f32 results --------------------------------

def f32_inputs(lo, hi, n, sign=True, extra=()):
    xs = [to_f32(log_uniform(lo, hi, sign=sign)) for _ in range(n)]
    return xs + [to_f32(x) for x in extra]


f32_unary = {
    'exp': f32_inputs(-30, 7, 30, extra=[88.72283, 88.72284, -87.33655, -103.97, -104.0, 1.0, -1.0, 10.0, 0.5 * LN2, 1e-10]),
    'exp2': f32_inputs(-30, 7, 30, extra=[127.99999, 128.0, -149.0, -149.5, -150.0, 0.5, -0.5, 10.5, 1e-10]),
    'expm1': f32_inputs(-30, 6, 30, extra=[88.72283, -20.0, 1e-10, -1e-10, 0.5, -0.5]),
    'log': f32_inputs(-149, 128, 30, sign=False, extra=[1.0000001, 0.9999999, 2.0, 0.5, F32_MIN_SUBNORMAL, F32_MIN_NORMAL, F32_MAX, 10.0]),
    'log2': f32_inputs(-149, 128, 30, sign=False, extra=[1.0000001, 0.9999999, 2.0, 1024.0, F32_MIN_SUBNORMAL, F32_MAX, 10.0]),
    'log10': f32_inputs(-149, 128, 30, sign=False, extra=[1.0000001, 0.9999999, 10.0, 1000.0, 0.001, F32_MIN_SUBNORMAL, F32_MAX]),
    'log1p': f32_inputs(-30, 100, 30, extra=[-0.9999999, -0.5, 1e-10, -1e-10, 1.0, F32_MAX]),
    'sin': f32_inputs(-20, 40, 30, extra=[1e22, 3.1415927, 1.5707964, 100.0, 1e6, 0.5]),
    'cos': f32_inputs(-20, 40, 30, extra=[1e22, 3.1415927, 1.5707964, 100.0, 1e6, 0.5]),
    'tan': f32_inputs(-20, 40, 30, extra=[1e22, 3.1415927, 1.5707964, 100.0, 1e6, 0.5, 0.7]),
    'asin': [to_f32(uniform(-1, 1)) for _ in range(30)] + [to_f32(x) for x in (0.9999999, -0.9999999, 0.5, 1e-10, 0.975)],
    'acos': [to_f32(uniform(-1, 1)) for _ in range(30)] + [to_f32(x) for x in (0.9999999, -0.9999999, 0.5, 1e-10, -0.5)],
    'atan': f32_inputs(-30, 70, 30, extra=[0.4375, 0.6875, 1.1875, 2.4375, 1.0, F32_MAX, 1e-10]),
    'sinh': f32_inputs(-30, 6, 30, extra=[89.0, 89.5, -89.5, 1e-10, 1.0, 20.0]),
    'cosh': f32_inputs(-30, 6, 30, extra=[89.0, 89.5, -89.5, 1e-10, 1.0, 20.0]),
    'tanh': f32_inputs(-30, 4, 30, extra=[0.15, 0.3, 10.0, -10.0, 1e-10]),
    'asinh': f32_inputs(-30, 128, 30, extra=[0.25, 1.0, 1e-10, F32_MAX]),
    'acosh': [to_f32(1 + log_uniform(-23, 7)) for _ in range(30)] + [to_f32(x) for x in (1.0, 1.0000001, 1.125, 2.0, 1e10, F32_MAX)],
    'atanh': [to_f32(uniform(-1, 1)) for _ in range(30)] + [to_f32(x) for x in (0.9999999, -0.9999999, 0.5, 1e-10, 0.25)],
    'cbrt': f32_inputs(-149, 128, 30, extra=[8.0, -27.0, 1000.0, F32_MIN_SUBNORMAL, F32_MAX, 1e-40]),
}

f32_binary = {
    'pow': [(to_f32(log_uniform(-10, 10)), to_f32(uniform(-20, 20))) for _ in range(30)]
           + [(to_f32(x), to_f32(y)) for x, y in ((2.0, 0.5), (2.0, 127.5), (2.0, -149.0), (2.0, -149.5), (2.0, -150.0),
                                                   (-2.0, 3.0), (10.0, 38.0), (10.0, 39.0), (1.0000001, 1e8), (0.9999999, 1e8), (3.0, 0.3))],
    'atan2': [(to_f32(log_uniform(-20, 20, sign=True)), to_f32(log_uniform(-20, 20, sign=True))) for _ in range(30)]
             + [(to_f32(y), to_f32(x)) for y, x in ((1.0, 1.0), (1.0, -1.0), (-1.0, -1.0), (3.0, 4.0), (1e-30, 1.0), (1e30, -1.0))],
    'hypot': [(to_f32(log_uniform(-20, 20, sign=True)), to_f32(log_uniform(-20, 20, sign=True))) for _ in range(30)]
             + [(to_f32(x), to_f32(y)) for x, y in ((3.0, 4.0), (F32_MAX, F32_MAX), (F32_MAX, 1.0), (1e-40, 1e-40), (1e20, 1e-20), (1e30, 1e30))],
}

f32_fma = []
for _ in range(30):
    x = to_f32(log_uniform(-10, 10, sign=True))
    y = to_f32(log_uniform(-10, 10, sign=True))
    z = to_f32(-(x * y) * (1 + rng.choice([0, 2.0 ** -23, -2.0 ** -23, 2.0 ** -12])))
    f32_fma.append((x, y, z))
f32_fma += [(to_f32(x), to_f32(y), to_f32(z)) for x, y, z in (
    (0.1, 10.0, -1.0), (1.0000001, 1.0000001, -1.0), (16777215.0, 16777215.0, 1.0),
    (1.5e38, 10.0, -1.5e38), (1e-45, 0.5, 0.0), (1e-45, 0.5, 1e-45), (1e-45, 0.75, 0.0),
    (1.5, 2.0, -3.0), (-0.0, 1.0, -0.0), (3.0, 1.0 / 3.0, -1.0), (1.0, 1.0, 2.0 ** -24),
    (1.0 + 2.0 ** -23, 1.0 + 2.0 ** -23, -(1.0 + 2.0 ** -22)), (2.0 ** -75, 2.0 ** -75, 2.0 ** -149),
    (F32_MAX, 2.0, -F32_MAX), (2.0 ** 60, 2.0 ** 60, -2.0 ** 120), (1e-20, 1e-20, 1e-45),
)]


# --- MPFR evaluation ----------------------------------------------------

def mpfr_pow(x, y):
    return x ** y


UNARY = {
    'exp': (gmpy2.exp, exp_inputs), 'exp2': (gmpy2.exp2, exp2_inputs), 'expm1': (gmpy2.expm1, expm1_inputs),
    'log': (gmpy2.log, log_inputs), 'log2': (gmpy2.log2, log_inputs), 'log10': (gmpy2.log10, log_inputs),
    'log1p': (gmpy2.log1p, log1p_inputs),
    'sin': (gmpy2.sin, trig_inputs), 'cos': (gmpy2.cos, trig_inputs), 'tan': (gmpy2.tan, trig_inputs),
    'asin': (gmpy2.asin, asin_inputs), 'acos': (gmpy2.acos, asin_inputs), 'atan': (gmpy2.atan, atan_inputs),
    'sinh': (gmpy2.sinh, sinh_inputs), 'cosh': (gmpy2.cosh, sinh_inputs), 'tanh': (gmpy2.tanh, tanh_inputs),
    'asinh': (gmpy2.asinh, asinh_inputs), 'acosh': (gmpy2.acosh, acosh_inputs), 'atanh': (gmpy2.atanh, atanh_inputs),
    'cbrt': (gmpy2.cbrt, cbrt_inputs),
}
BINARY = {
    'pow': (mpfr_pow, pow_inputs), 'atan2': (gmpy2.atan2, atan2_inputs), 'hypot': (gmpy2.hypot, hypot_inputs),
}


def with_context(bits, fn):
    saved = gmpy2.get_context()
    ctx = gmpy2.ieee(bits)
    ctx.trap_overflow = False
    ctx.trap_underflow = False
    ctx.trap_inexact = False
    ctx.trap_invalid = False
    ctx.trap_divzero = False
    gmpy2.set_context(ctx)
    try:
        return fn()
    finally:
        gmpy2.set_context(saved)


def table(name, rows, fmt):
    lines = [' '.join(fmt(v) for v in row) for row in rows]
    body = '\n'.join(lines)
    return f'export let {name} = `{body}`;\n'


def main():
    out = [
        '// Generated by packages/stdlib/scripts/generate-libm-reference.py from',
        '// MPFR (through gmpy2). Do not edit: run the script.',
        '',
        '/**',
        " * Correctly rounded results of zena:math's libm functions, for",
        ' * tests/math/libm_test.zena. Each table is a string with one case per',
        ' * line: the arguments, then the result, as decimals that parse back to',
        ' * the exact binary values (`Infinity`, `-Infinity` and `NaN` spelled',
        ' * as such). The `_F32` tables hold f32 arguments and f32 results.',
        ' */',
        '',
    ]
    for name, (fn, inputs) in UNARY.items():
        rows = with_context(64, lambda: unary(fn, inputs))
        out.append(table(name.upper(), rows, text))
    for name, (fn, inputs) in BINARY.items():
        rows = with_context(64, lambda: binary(fn, inputs))
        out.append(table(name.upper(), rows, text))
    rows = with_context(64, lambda: ternary(gmpy2.fma, fma_inputs))
    out.append(table('FMA', rows, text))

    for name, inputs in f32_unary.items():
        fn = UNARY[name][0]
        rows = with_context(32, lambda: unary(fn, inputs))
        out.append(table(name.upper() + '_F32', rows, text32))
    for name, inputs in f32_binary.items():
        fn = BINARY[name][0]
        rows = with_context(32, lambda: binary(fn, inputs))
        out.append(table(name.upper() + '_F32', rows, text32))
    rows = with_context(32, lambda: ternary(gmpy2.fma, f32_fma))
    out.append(table('FMA_F32', rows, text32))

    with open(OUT, 'w') as f:
        f.write('\n'.join(out))
    total = sum(len(v[1]) for v in UNARY.values()) + sum(len(v[1]) for v in BINARY.values()) + len(fma_inputs)
    print(f'wrote {OUT}: {total} f64 cases')


if __name__ == '__main__':
    main()
