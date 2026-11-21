#!/usr/bin/env python3
"""Reports on a `perf script` dump of a compile (docs/profiling.md, "Linux, with perf").

  perf script -i prof.data -F ip,sym,dso > prof.txt

  perf-report.py prof.txt groups
      samples by where the leaf is: the compiler's own code, the
      collector, subtype checks, funcref interning, the rest of the host
  perf-report.py prof.txt flat [--top N]
      self samples by function
  perf-report.py prof.txt incl [--top N] [--match REGEX]
      inclusive samples by function, each counted once per stack
  perf-report.py prof.txt under REGEX [--top N]
      self samples by function, over the stacks that hold a frame matching
  perf-report.py prof.txt children REGEX [--top N]
      inclusive samples by the direct callee of the outermost frame matching
  perf-report.py prof.txt callers REGEX [--depth D] [--top N] [--skip REGEX]
      the D frames above the outermost frame matching, as one line

Function names lose their `wasm[1]::function[N]::` prefix and the
`_s<N>` symbol ids, so two builds of the compiler can be compared.
"""
import collections
import re
import sys


def short(sym):
    sym = re.sub(r'^wasm\[\d+\]::function\[\d+\]::', '', sym)
    return re.sub(r'_s\d+', '', sym)


def load(path):
    """Stacks, leaf first, as lists of (function, file name of its object)."""
    stacks = []
    cur = []
    with open(path, errors='replace') as f:
        for line in f:
            line = line.rstrip('\n')
            if not line.strip():
                if cur:
                    stacks.append(cur)
                    cur = []
                continue
            parts = line.strip().split(None, 1)
            if len(parts) < 2:
                continue
            m = re.match(r'(.*) \(([^()]*)\)$', parts[1])
            sym, dso = (m.group(1), m.group(2)) if m else (parts[1], '')
            dso = dso.rsplit('/', 1)[-1]
            if sym == '[unknown]':
                sym = f'[unknown {dso}]'
            cur.append((short(sym), dso))
    if cur:
        stacks.append(cur)
    return stacks


def option(args, name, default):
    if name not in args:
        return default
    i = args.index(name)
    value = args[i + 1]
    del args[i:i + 2]
    return value


def is_wasm(frame):
    return frame[1].endswith('.cwasm') or frame[1].startswith('perf-')


COLLECTOR = re.compile(
    r'gc::enabled::copying|CopyingHeap|CopyingCollection|collect_increment|'
    r'scan_field|trace_roots|GcStore|do_gc|memmove|memset|memcpy')
SUBTYPE = re.compile(r'is_subtype|engine_type_index')
FUNCREF = re.compile(r'get_interned_func_ref|FuncRefTable|func_loc|hash_one')


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit(__doc__)
    path, mode = args[0], args[1]
    args = args[2:]
    top = int(option(args, '--top', '40'))
    stacks = load(path)
    total = len(stacks)
    counts = collections.Counter()
    if mode == 'groups':
        for s in stacks:
            leaf = s[0]
            if is_wasm(leaf):
                counts['the compiler'] += 1
            elif SUBTYPE.search(leaf[0]):
                counts['host: subtype checks'] += 1
            elif COLLECTOR.search(leaf[0]):
                counts['host: collector, memmove and memset'] += 1
            elif FUNCREF.search(leaf[0]):
                counts['host: funcref interning'] += 1
            else:
                counts[f'host: other ({leaf[1]})'] += 1
    elif mode == 'flat':
        for s in stacks:
            counts[s[0][0]] += 1
    elif mode == 'incl':
        match = option(args, '--match', None)
        rx = re.compile(match) if match else None
        for s in stacks:
            for name in {f[0] for f in s}:
                if rx is None or rx.search(name):
                    counts[name] += 1
    elif mode in ('under', 'children', 'callers'):
        skip = re.compile(option(args, '--skip', r'^$'))
        depth = int(option(args, '--depth', '1'))
        rx = re.compile(args[0])
        matched = 0
        for s in stacks:
            at = [i for i, f in enumerate(s) if rx.search(f[0])]
            if not at:
                continue
            matched += 1
            outermost = at[-1]
            if mode == 'under':
                counts[s[0][0]] += 1
            elif mode == 'children':
                counts['<self>' if outermost == 0 else s[outermost - 1][0]] += 1
            else:
                above = [f[0] for f in s[outermost + 1:] if not skip.search(f[0])]
                counts[' <- '.join(above[:depth])] += 1
        print(f'{matched} of {total} samples ({100 * matched / total:.2f}%) hold a matching frame')
    else:
        sys.exit(__doc__)
    for name, n in counts.most_common(top):
        print(f'{100 * n / total:6.2f}% {n:7d}  {name[:200]}')


if __name__ == '__main__':
    main()
