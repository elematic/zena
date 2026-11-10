#!/usr/bin/env python3
"""Generates tests/decimal/decimal-reference.zena from Python's IEEE 754 decimal module.

Each table holds deterministic IEEE 754-2008 decimal128 / decimal64 edge cases
plus seeded random cases across all 9 RoundingModes so running the script again
writes the identical file:

    python3 packages/stdlib/scripts/generate-decimal-reference.py
"""

from decimal import (
    Context,
    Decimal,
    ROUND_CEILING,
    ROUND_DOWN,
    ROUND_FLOOR,
    ROUND_HALF_DOWN,
    ROUND_HALF_EVEN,
    ROUND_HALF_UP,
    ROUND_UP,
)
import math
import os
import random

OUT = os.path.join(
    os.path.dirname(__file__), '..', 'tests', 'decimal', 'decimal-reference.zena'
)

rng = random.Random(889)

# Mode indices matching zena:decimal RoundingMode enum order:
# 0: HalfEven, 1: HalfExpand, 2: HalfTrunc, 3: HalfCeil, 4: HalfFloor,
# 5: Ceil, 6: Floor, 7: Trunc, 8: Expand
DIRECT_PY_MODES = {
    0: ROUND_HALF_EVEN,
    1: ROUND_HALF_UP,
    2: ROUND_HALF_DOWN,
    5: ROUND_CEILING,
    6: ROUND_FLOOR,
    7: ROUND_DOWN,
    8: ROUND_UP,
}


def make_ctx(prec: int, emin: int, emax: int, py_rounding: str) -> Context:
    return Context(
        prec=prec,
        Emin=emin,
        Emax=emax,
        rounding=py_rounding,
        capitals=0,
        clamp=1,
        traps=[],
    )


CTX128 = make_ctx(34, -6143, 6144, ROUND_HALF_EVEN)
# Exact parse context wide enough to hold arbitrary input strings without rounding.
PARSE_CTX = Context(prec=200, Emin=-999999, Emax=999999, capitals=0, clamp=0, traps=[])


def D(s: str) -> Decimal:
    return PARSE_CTX.create_decimal(s)


def fmt128(val: Decimal) -> str:
    if val.is_nan():
        return 'NaN'
    return CTX128.to_sci_string(val)


def eval_with_mode(
    mode_idx: int,
    prec: int,
    emin: int,
    emax: int,
    fn,
) -> str:
    """Evaluates `fn(ctx) -> Decimal` under any of the 9 Zena RoundingModes."""
    if mode_idx in DIRECT_PY_MODES:
        ctx = make_ctx(prec, emin, emax, DIRECT_PY_MODES[mode_idx])
        res = fn(ctx)
        return 'NaN' if res.is_nan() else ctx.to_sci_string(res)

    # HalfCeil (3) and HalfFloor (4) agree with ROUND_HALF_UP / ROUND_HALF_DOWN
    # depending on result sign when an inexact tie occurs.
    ctx_up = make_ctx(prec, emin, emax, ROUND_HALF_UP)
    ctx_down = make_ctx(prec, emin, emax, ROUND_HALF_DOWN)
    r_up = fn(ctx_up)
    r_down = fn(ctx_down)
    if r_up.is_nan():
        return 'NaN'
    s_up = ctx_up.to_sci_string(r_up)
    s_down = ctx_down.to_sci_string(r_down)
    if s_up == s_down:
        return s_up
    is_neg = r_up.is_signed()
    if mode_idx == 3:  # HalfCeil: ties toward +Infinity
        return s_down if is_neg else s_up
    # mode_idx == 4: HalfFloor: ties toward -Infinity
    return s_up if is_neg else s_down


def rand_dec_str(max_digits: int = 34, exp_range: tuple[int, int] = (-80, 80)) -> str:
    nd = rng.randint(1, max_digits)
    first = str(rng.randint(1, 9))
    rest = ''.join(str(rng.randint(0, 9)) for _ in range(nd - 1))
    digits = first + rest
    exp = rng.randint(exp_range[0], exp_range[1])
    sign = '-' if rng.random() < 0.45 else ''
    return f'{sign}{digits}e{exp:+d}'


def table(name: str, rows: list[tuple[str, ...]]) -> str:
    body = '\n'.join(' '.join(r) for r in rows)
    return f'export let {name} = `{body}`;\n'


def build_add_sub() -> list[tuple[str, ...]]:
    max_v = '9999999999999999999999999999999999e+6111'
    pairs = [
        ('0', '0'),
        ('-0', '-0'),
        ('-0', '0'),
        ('0', '-0'),
        ('0.0', '0.00'),
        ('-0.0', '-0.000'),
        ('0.000', '1.5'),
        ('1.5', '0.000'),
        ('0.1', '0.2'),
        ('1.5', '1.50'),
        ('19.99', '0.0825'),
        ('-19.99', '19.99'),
        ('1000', '0.0001'),
        ('1', '1e-33'),
        ('1', '5e-34'),
        ('1', '5.00001e-34'),
        ('1', '4.99999e-34'),
        ('1', '1e-34'),
        ('1', '5e-35'),
        # Intermediate 38..70 digit exponent gaps (BigInt bridge):
        ('1234567890123456789012345678901234', '5e-10'),
        ('1e+25', '12345678901234567890e-30'),
        ('1e+40', '9999999999999999999999999999999999e-20'),
        # Huge exponent gaps (sticky window):
        ('1', '1e-100'),
        ('1', '1e-5000'),
        ('1.000000000000000000000000000000000', '1e-5000'),
        ('1e+5000', '1e-5000'),
        # Overflow & subnormal boundaries:
        (max_v, '1e+6111'),
        (max_v, '5e+6110'),
        (max_v, '4.9e+6110'),
        ('1e-6143', '-1e-6176'),
        ('1e-6176', '1e-6176'),
        ('5e-6176', '-5e-6176'),
        # Special values:
        ('Infinity', '1'),
        ('Infinity', 'Infinity'),
        ('Infinity', '-Infinity'),
        ('-Infinity', '-Infinity'),
        ('NaN', '1'),
        ('1', 'NaN'),
    ]
    for _ in range(55):
        a = rand_dec_str(rng.choice([3, 18, 19, 20, 34]), rng.choice([(-6, 6), (-50, 50), (-6176, -6135), (6090, 6111)]))
        b = rand_dec_str(rng.choice([3, 18, 19, 20, 34]), rng.choice([(-6, 6), (-50, 50), (-6176, -6135), (6090, 6111)]))
        pairs.append((a, b))

    rows = []
    for a_s, b_s in pairs:
        da = CTX128.create_decimal(a_s)
        db = CTX128.create_decimal(b_s)
        s_add = fmt128(CTX128.add(da, db))
        s_sub = fmt128(CTX128.subtract(da, db))
        rows.append((fmt128(da), fmt128(db), s_add, s_sub))
    return rows


def build_mul() -> list[tuple[str, ...]]:
    max_c = '9999999999999999999999999999999999'
    pairs = [
        ('0', '0'),
        ('-0', '5'),
        ('-0', '-5'),
        ('0.00', '2.50'),
        ('0.1', '0.2'),
        ('19.99', '3'),
        ('19.99', '0.0825'),
        # u64 / 10^38 boundary:
        ('10000000000000000000', '10000000000000000000'),
        ('18446744073709551615', '18446744073709551615'),
        (max_c, max_c),
        (f'-{max_c}', max_c),
        # Overflow & gradual underflow:
        ('1e+4000', '1e+3000'),
        ('-1e+4000', '1e+3000'),
        ('1e-3080', '1e-3080'),
        ('1e-3088', '5e-3089'),
        ('1e-3088', '5.0001e-3089'),
        ('1e-3088', '15e-3089'),
        ('1e-4000', '1e-4000'),
        ('-1e-4000', '1e-4000'),
        # Special values:
        ('Infinity', '2'),
        ('Infinity', '-2'),
        ('Infinity', '0'),
        ('0', '-Infinity'),
        ('Infinity', 'Infinity'),
        ('NaN', '0'),
    ]
    for _ in range(50):
        a = rand_dec_str(rng.choice([5, 19, 20, 34]), rng.choice([(-10, 10), (-3100, 3100)]))
        b = rand_dec_str(rng.choice([5, 19, 20, 34]), rng.choice([(-10, 10), (-3100, 3100)]))
        pairs.append((a, b))

    rows = []
    for a_s, b_s in pairs:
        da = CTX128.create_decimal(a_s)
        db = CTX128.create_decimal(b_s)
        rows.append((fmt128(da), fmt128(db), fmt128(CTX128.multiply(da, db))))
    return rows


def build_div_rem() -> list[tuple[str, ...]]:
    pairs = [
        ('1', '8'),
        ('2.40', '2'),
        ('20', '2'),
        ('2e+2', '2e+1'),
        ('100', '25'),
        ('1', '3'),
        ('2', '3'),
        ('-7', '3'),
        ('7', '-3'),
        ('-7', '-3'),
        ('7.5', '2.2'),
        ('-7.5', '2.2'),
        ('1.5', '2.00'),
        ('0', '5'),
        ('-0', '5'),
        ('0.00', '2'),
        ('0', '0.1'),
        ('5', '0'),
        ('-5', '0'),
        ('0', '0'),
        ('5', 'Infinity'),
        ('-5', 'Infinity'),
        ('0', 'Infinity'),
        ('Infinity', '5'),
        ('Infinity', '0'),
        ('Infinity', 'Infinity'),
        ('1e+50', '3'),
        ('1e-6150', '3'),
        ('1e-6170', '1e+6'),
        ('5e-6170', '1e+7'),
        ('15e-6170', '1e+7'),
        ('1e+6140', '1e-10'),
    ]
    for _ in range(50):
        a = rand_dec_str(rng.choice([4, 15, 34]), rng.choice([(-12, 12), (-100, 100)]))
        b = rand_dec_str(rng.choice([2, 12, 34]), rng.choice([(-12, 12), (-100, 100)]))
        pairs.append((a, b))

    rows = []
    for a_s, b_s in pairs:
        da = CTX128.create_decimal(a_s)
        db = CTX128.create_decimal(b_s)
        rows.append((
            fmt128(da),
            fmt128(db),
            fmt128(CTX128.divide(da, db)),
            fmt128(CTX128.remainder(da, db)),
        ))
    return rows


def build_fma() -> list[tuple[str, ...]]:
    triples = [
        # Exact cancellation requiring >34-digit product before + c:
        ('100000000000000001', '99999999999999999', '-1e+34'),
        ('9999999999999999999999999999999999', '9999999999999999999999999999999999', '1'),
        ('1e+20', '1e-20', '-1'),
        ('0.1', '0.2', '-0.02'),
        ('0', 'Infinity', '1'),
        ('Infinity', '2', '-Infinity'),
        ('Infinity', '2', 'Infinity'),
        ('0.00', '0.0', '1.5'),
        ('1.5', '2.0', '0.000'),
        ('1e+5000', '1', '1e-5000'),
        ('1e-5000', '1', '1e+5000'),
    ]
    for _ in range(40):
        a = rand_dec_str(rng.choice([6, 20, 34]), (-30, 30))
        b = rand_dec_str(rng.choice([6, 20, 34]), (-30, 30))
        c = rand_dec_str(rng.choice([6, 20, 34]), (-40, 40))
        triples.append((a, b, c))

    rows = []
    for a_s, b_s, c_s in triples:
        da = CTX128.create_decimal(a_s)
        db = CTX128.create_decimal(b_s)
        dc = CTX128.create_decimal(c_s)
        rows.append((
            fmt128(da),
            fmt128(db),
            fmt128(dc),
            fmt128(CTX128.fma(da, db, dc)),
        ))
    return rows


def build_sqrt() -> list[tuple[str, ...]]:
    vals = [
        '0', '-0', '0.0', '0.00', '-0.0', '-0.000',
        '1', '4', '9', '1.44', '1.4400', '400', '4e+2', '0.04',
        '2', '3', '0.5', '10',
        '9999999999999999999999999999999999e+6111',
        '1e-6143', '1e-6176', '2e-6176', '9e-6176',
        '-1', '-0.0001', 'Infinity', '-Infinity', 'NaN',
    ]
    for _ in range(40):
        vals.append(rand_dec_str(rng.choice([4, 17, 34]), (-500, 500)).lstrip('-'))

    rows = []
    for s in vals:
        d = CTX128.create_decimal(s)
        rows.append((fmt128(d), fmt128(CTX128.sqrt(d))))
    return rows


def build_rounding_modes() -> list[tuple[str, ...]]:
    """Tests all 9 RoundingModes across prec=4, prec=16 (DECIMAL64), and prec=34 (DECIMAL128)."""
    configs = [
        # (prec, emin, emax) matching DecimalContext.sigFigs(4), DECIMAL64, DECIMAL128:
        # Note: sigFigs(4) in Zena has etiny=-6176, etop=6111 => emin=-6173, emax=6114.
        (4, -6173, 6114),
        (16, -383, 384),
        (34, -6143, 6144),
    ]
    rows = []

    # 1) Parse / round ties, near-ties, overflows, and underflows across all 9 modes at prec=4 & prec=16:
    parse_inputs = [
        '12345', '-12345',
        '12355', '-12355',
        '12344.9999', '-12344.9999',
        '12345.0001', '-12345.0001',
        '9999.5', '-9999.5',
        '9.9999e+400', '-9.9999e+400',
        '1e+7000', '-1e+7000',
        '5e-399', '-5e-399',
        '1e-7000', '-1e-7000',
    ]
    for prec, emin, emax in configs:
        for mode_idx in range(9):
            for inp in parse_inputs:
                res = eval_with_mode(mode_idx, prec, emin, emax, lambda c, s=inp: c.create_decimal(s))
                rows.append((str(mode_idx), str(prec), 'parse', inp, '0', res))

    # 2) Binary ops (add, sub, mul, div) & sqrt across all 9 modes:
    op_cases = [
        ('add', '1000', '0.5'),
        ('add', '1001', '0.5'),
        ('add', '-1000', '-0.5'),
        ('add', '-1001', '-0.5'),
        ('add', '1.25', '-1.25'),
        ('sub', '1.25', '1.25'),
        ('mul', '1.25', '1.0004'),
        ('mul', '-1.25', '1.0004'),
        ('mul', '9.999e+200', '1e+200'),
        ('mul', '-9.999e+200', '1e+200'),
        ('div', '1', '3'),
        ('div', '-1', '3'),
        ('div', '2', '3'),
        ('div', '-2', '3'),
        ('div', '51', '5'),
        ('div', '-51', '5'),
        ('sqrt', '2', '0'),
        ('sqrt', '3', '0'),
        ('sqrt', '1.00100025', '0'),
        ('sqrt', '2e-796', '0'),
    ]

    def ieee754_sqrt_rep(val: Decimal, target_prec: int) -> Decimal:
        # IEEE 754-2008 §5.4.1 squareRoot honors all rounding modes (unlike Python's
        # Cowlishaw GDA Context.sqrt, which hardcodes ROUND_HALF_EVEN).
        sign, digits, exp = val.as_tuple()
        c = int(''.join(map(str, digits)))
        if c == 0:
            return Decimal((sign, (0,), exp >> 1))
        dx = len(digits)
        k = max(2 * target_prec + 1 - dx, 0)
        if ((exp - k) & 1) != 0:
            k += 1
        work_exp = (exp - k) >> 1
        ideal_exp = exp >> 1
        rad = c * (10 ** k)
        s = math.isqrt(rad)
        rem = rad - s * s
        if rem == 0:
            while work_exp < ideal_exp and s % 10 == 0:
                s //= 10
                work_exp += 1
            return PARSE_CTX.create_decimal(f'{s}e{work_exp}')
        return PARSE_CTX.create_decimal(f'{10 * s + 1}e{work_exp - 1}')

    for prec, emin, emax in configs:
        for mode_idx in range(9):
            for op, a_s, b_s in op_cases:
                da = D(a_s)
                db = D(b_s)
                if op == 'add':
                    res = eval_with_mode(mode_idx, prec, emin, emax, lambda c, x=da, y=db: c.add(x, y))
                elif op == 'sub':
                    res = eval_with_mode(mode_idx, prec, emin, emax, lambda c, x=da, y=db: c.subtract(x, y))
                elif op == 'mul':
                    res = eval_with_mode(mode_idx, prec, emin, emax, lambda c, x=da, y=db: c.multiply(x, y))
                elif op == 'div':
                    res = eval_with_mode(mode_idx, prec, emin, emax, lambda c, x=da, y=db: c.divide(x, y))
                else:
                    s_rep = ieee754_sqrt_rep(da, prec)
                    res = eval_with_mode(mode_idx, prec, emin, emax, lambda c, sr=s_rep: c.plus(sr))
                rows.append((str(mode_idx), str(prec), op, a_s, b_s, res))

    return rows


def build_fixed_scale() -> list[tuple[str, ...]]:
    """Tests quantize and DecimalContext.fixedScale single-rounding operations across all 9 modes."""
    rows = []
    # Exact high-precision ctx for intermediate before single quantize:
    exact_ctx = Context(prec=120, Emin=-99999, Emax=99999, capitals=0, clamp=0, traps=[])

    def quantize_exact(val: Decimal, scale: int, mode_idx: int) -> str:
        q_target = Decimal(1).scaleb(-scale, exact_ctx)
        return eval_with_mode(
            mode_idx, 34, -6143, 6144,
            lambda c, v=val, qt=q_target: c.quantize(v, qt),
        )

    cases = [
        # Classic double-rounding trap:
        # 1.0049999999999999999999999999999999 * 1 -> < 1.005 (must NOT round up under HalfExpand!)
        (2, 'mul', '1.004999999999999999999999999999999', '0.9999999999999999999999999999999999'),
        (2, 'mul', '19.99', '0.0825'),
        (2, 'mul', '-19.99', '0.0825'),
        (2, 'add', '1.005', '0'),
        (2, 'add', '1.015', '0'),
        (2, 'add', '-1.005', '0'),
        (2, 'add', '-1.015', '0'),
        (2, 'add', '1', '0.5'),
        (2, 'div', '1', '8'),
        (2, 'div', '-1', '8'),
        (2, 'div', '1', '3'),
        (2, 'div', '2', '3'),
        (2, 'div', '-2', '3'),
        (0, 'quantize', '2.5', '0'),
        (0, 'quantize', '3.5', '0'),
        (0, 'quantize', '-2.5', '0'),
        (0, 'quantize', '-3.5', '0'),
        (-2, 'quantize', '1250', '0'),
        (-2, 'quantize', '1350', '0'),
        (-2, 'quantize', '-1250', '0'),
        (4, 'sqrt', '2', '0'),
        (4, 'sqrt', '2.25', '0'),
    ]

    for mode_idx in range(9):
        for scale, op, a_s, b_s in cases:
            da = CTX128.create_decimal(a_s)
            db = CTX128.create_decimal(b_s)
            if op == 'quantize':
                res = quantize_exact(da, scale, mode_idx)
            elif op == 'add':
                res = quantize_exact(exact_ctx.add(da, db), scale, mode_idx)
            elif op == 'mul':
                res = quantize_exact(exact_ctx.multiply(da, db), scale, mode_idx)
            elif op == 'div':
                # High-precision quotient with sticky remainder never ties unless exact in base 10
                div_ctx = Context(prec=120, Emin=-99999, Emax=99999, rounding=ROUND_DOWN, capitals=0, clamp=0, traps=[])
                q_hi = div_ctx.divide(da, db)
                # Adjust if inexact so exact ties at `scale` cannot occur spuriously:
                if exact_ctx.multiply(q_hi, db) != da:
                    # Nudge 115th digit by +1 magnitude to preserve sticky above zero
                    ulp = Decimal(1).scaleb(q_hi.adjusted() - 115, exact_ctx)
                    q_hi = q_hi - ulp if q_hi.is_signed() else q_hi + ulp
                res = quantize_exact(q_hi, scale, mode_idx)
            else:  # sqrt
                sq_ctx = Context(prec=120, Emin=-99999, Emax=99999, rounding=ROUND_DOWN, capitals=0, clamp=0, traps=[])
                s_hi = sq_ctx.sqrt(da)
                if exact_ctx.multiply(s_hi, s_hi) != da:
                    ulp = Decimal(1).scaleb(s_hi.adjusted() - 115, exact_ctx)
                    s_hi = s_hi + ulp
                res = quantize_exact(s_hi, scale, mode_idx)
            rows.append((str(mode_idx), str(scale), op, fmt128(da), fmt128(db), res))

    return rows


def main() -> None:
    sections = [
        '// Generated by packages/stdlib/scripts/generate-decimal-reference.py from',
        "// Python's decimal module (IEEE 754-2008). Do not edit: run the script.",
        '',
        '/**',
        ' * Reference vectors for tests/decimal/decimal_test.zena, computed by',
        " * Python's IEEE 754 decimal module. Each table has one space-separated",
        ' * case per line.',
        ' */',
        '',
        table('DEC128_ADD_SUB', build_add_sub()),
        table('DEC128_MUL', build_mul()),
        table('DEC128_DIV_REM', build_div_rem()),
        table('DEC128_FMA', build_fma()),
        table('DEC128_SQRT', build_sqrt()),
        table('ROUNDING_MODES_CTX', build_rounding_modes()),
        table('FIXED_SCALE_CTX', build_fixed_scale()),
    ]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(sections))
    print(f'wrote {OUT}')


if __name__ == '__main__':
    main()
