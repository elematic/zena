#!/usr/bin/env python3
"""Compare two samply profiles of a compile, by function.

Records are made as docs/profiling.md's Linux section says, with
ZENA_PROFILE=1 so wasmtime writes /tmp/perf-<pid>.map, which this
script needs copied beside the profile; the compiler module should be
built with -g so the map's `wasm[0]::function[N]` resolves to a name.
Native frames resolve against `nm` of zena-run, wasm frames against the
perf map (samply records `.cwasm` frames as file offsets; the map holds
runtime addresses, and the `.text` section's file offset aligns them).

    nm -C --defined-only target/release/zena-run | awk '$2 ~ /[tTwW]/ {print $1, $3}' > syms.txt
    scripts/samply-diff.py --syms syms.txt \
        --a prof-a.json.gz perf-a.map a.cwasm a.wat \
        --b prof-b.json.gz perf-b.map b.cwasm b.wat [--callers is_subtype]

Prints self-sample counts per function for both profiles and the
difference, and with --callers, the wasm functions above every sample
whose native leaf matches the pattern (trampoline frames skipped).
"""

import argparse
import bisect
import collections
import gzip
import json
import re
import struct


def text_offset(cwasm):
    with open(cwasm, 'rb') as f:
        e = f.read(64)
        shoff = struct.unpack_from('<Q', e, 0x28)[0]
        shentsize, shnum, shstrndx = struct.unpack_from('<HHH', e, 0x3a)
        f.seek(shoff)
        sh = [f.read(shentsize) for _ in range(shnum)]

        def ent(b):
            name, _typ, _flags, _addr, off, size = struct.unpack_from('<IIQQQQ', b, 0)
            return name, off, size

        n, off, size = ent(sh[shstrndx])
        f.seek(off)
        names = f.read(size)
        for b in sh:
            n, off, _ = ent(b)
            if names[n:names.index(b'\0', n)] == b'.text':
                return off
    raise SystemExit(f'{cwasm}: no .text section')


def load_map(path):
    rows = []
    for line in open(path):
        p = line.split(None, 2)
        if len(p) == 3:
            rows.append((int(p[0], 16), int(p[1], 16), p[2].strip()))
    rows.sort()
    return rows


def func_names(wat):
    text = open(wat).read()
    return {int(m.group(2)): m.group(1) for m in re.finditer(r'\(func \$(\S+) \(;(\d+);\)', text)}


def load_syms(path):
    rows = []
    for line in open(path):
        p = line.split(None, 1)
        if len(p) == 2:
            try:
                rows.append((int(p[0], 16), p[1].strip()))
            except ValueError:
                pass
    rows.sort()
    return rows


class Profile:
    def __init__(self, prof, pmap, cwasm, wat, syms):
        p = json.load(gzip.open(prof))
        self.pm = load_map(pmap)
        self.starts = [r[0] for r in self.pm]
        f0 = next(r for r in self.pm if r[2].endswith('function[0]'))[0]
        self.base = f0 - text_offset(cwasm)
        self.names = func_names(wat)
        self.syms = syms
        self.symaddrs = [r[0] for r in syms]
        self.th = max(p['threads'], key=lambda t: t['samples']['length'])
        self.libs = p['libs']
        th = self.th
        self.ft, self.st, self.fnt = th['frameTable'], th['stackTable'], th['funcTable']
        self.rl = th['resourceTable']['lib']

    def lib(self, frame):
        r = self.fnt['resource'][self.ft['func'][frame]]
        if r is None or r < 0 or self.rl[r] is None:
            return '?'
        return self.libs[self.rl[r]]['name']

    def name(self, frame):
        lib = self.lib(frame)
        a = self.ft['address'][frame]
        if lib.endswith('.cwasm'):
            a += self.base
            i = bisect.bisect_right(self.starts, a) - 1
            if i >= 0 and a < self.pm[i][0] + self.pm[i][1]:
                m = re.search(r'function\[(\d+)\]', self.pm[i][2])
                raw = self.names.get(int(m.group(1)), self.pm[i][2]) if m else self.pm[i][2]
                return 'wasm ' + re.sub(r'_s\d+', '', raw)
            return 'wasm ?'
        if lib.startswith('zena-run') or lib.startswith('zena-cli'):
            i = bisect.bisect_right(self.symaddrs, a) - 1
            return 'native ' + (self.syms[i][1] if i >= 0 else '?')
        return 'lib ' + lib

    def self_counts(self):
        c = collections.Counter()
        for s in self.th['samples']['stack']:
            if s is not None:
                c[self.name(self.st['frame'][s])] += 1
        return c

    def callers(self, pattern):
        c = collections.Counter()
        for s in self.th['samples']['stack']:
            if s is None:
                continue
            leaf = self.name(self.st['frame'][s])
            if not (leaf.startswith('native') and pattern in leaf):
                continue
            cur = self.st['prefix'][s]
            while cur is not None:
                fr = self.st['frame'][cur]
                if self.lib(fr).endswith('.cwasm'):
                    nm = self.name(fr)
                    if 'trampoline' not in nm and 'signatures[' not in nm:
                        c[nm] += 1
                        break
                cur = self.st['prefix'][cur]
        return c


def report(title, a, b, top):
    keys = set(a) | set(b)
    print(f'\n-- {title}: biggest increase (b - a)')
    for k in sorted(keys, key=lambda k: -(b[k] - a[k]))[:top]:
        print(f'{b[k] - a[k]:+7d} {a[k]:7d} -> {b[k]:7d}  {k[:100]}')
    print(f'\n-- {title}: biggest decrease')
    for k in sorted(keys, key=lambda k: (b[k] - a[k]))[:top // 2]:
        print(f'{b[k] - a[k]:+7d} {a[k]:7d} -> {b[k]:7d}  {k[:100]}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--syms', required=True)
    ap.add_argument('--a', nargs=4, metavar=('PROF', 'MAP', 'CWASM', 'WAT'), required=True)
    ap.add_argument('--b', nargs=4, metavar=('PROF', 'MAP', 'CWASM', 'WAT'), required=True)
    ap.add_argument('--callers', help='native leaf pattern whose wasm callers to compare')
    ap.add_argument('--top', type=int, default=20)
    args = ap.parse_args()
    syms = load_syms(args.syms)
    a = Profile(*args.a, syms)
    b = Profile(*args.b, syms)
    ca, cb = a.self_counts(), b.self_counts()
    print(f'samples: a={sum(ca.values())} b={sum(cb.values())}')
    report('self samples', ca, cb, args.top)
    if args.callers:
        report(f'wasm callers of {args.callers}', a.callers(args.callers), b.callers(args.callers), args.top)


if __name__ == '__main__':
    main()
