#!/usr/bin/env python3
"""Single-profile report: self samples by function, and for --callers
PATTERN the nearest non-matching wasm caller of every sample whose
stack holds a frame matching PATTERN (wasm or native). Resolution as in
scripts/samply-diff.py, but module-aware for a component's perf map."""
import argparse, bisect, collections, importlib.util, re, sys
spec = importlib.util.spec_from_file_location('sd', __import__('os').path.join(__import__('os').path.dirname(__file__), 'samply-diff.py'))
sd = importlib.util.module_from_spec(spec); spec.loader.exec_module(sd)

def module_func_names(wat):
    mods = re.split(r'^  \(core module', open(wat).read(), flags=re.M)
    out = {}
    for mi, mod in enumerate(mods[1:]):
        out[mi] = {int(m.group(2)): m.group(1) for m in re.finditer(r'\(func \$(\S+) \(;(\d+);\)', mod)}
    return out

class P(sd.Profile):
    def __init__(self, prof, pmap, cwasm, wat, syms):
        super().__init__(prof, pmap, cwasm, wat, syms)
        self.mnames = module_func_names(wat)
        # The map can hold several modules' function[0] (zena-run loads a
        # small extra module), and samply's cwasm frame addresses may be
        # file offsets or .text-relative: take the base that resolves
        # the most frames.
        toff = sd.text_offset(cwasm)
        addrs = [self.ft['address'][f] for f in range(self.ft['length']) if self.lib(f).endswith('.cwasm')]
        cands = set()
        for r in self.pm:
            if r[2].endswith('function[0]'):
                cands.add(r[0]); cands.add(r[0] - toff)
        def hits(base):
            n = 0
            for a in addrs:
                i = bisect.bisect_right(self.starts, a + base) - 1
                if i >= 0 and a + base < self.pm[i][0] + self.pm[i][1]:
                    n += 1
            return n
        self.base = max(cands, key=hits)
    def name(self, frame):
        lib = self.lib(frame)
        a = self.ft['address'][frame]
        if lib.endswith('.cwasm'):
            a += self.base
            i = bisect.bisect_right(self.starts, a) - 1
            if i >= 0 and a < self.pm[i][0] + self.pm[i][1]:
                m = re.search(r'wasm\[(\d+)\]::function\[(\d+)\]', self.pm[i][2])
                if m:
                    raw = self.mnames.get(int(m.group(1)), {}).get(int(m.group(2)), self.pm[i][2])
                    return 'wasm ' + re.sub(r'_s\d+', '', raw)
                return 'wasm ' + self.pm[i][2]
            return 'wasm ?'
        if lib.startswith('zena-run') or lib.startswith('zena-cli'):
            i = bisect.bisect_right(self.symaddrs, a) - 1
            return 'native ' + (self.syms[i][1] if i >= 0 else '?')
        return 'lib ' + lib
    def frames_of(self, s):
        out = []
        cur = s
        while cur is not None:
            out.append(self.st['frame'][cur]); cur = self.st['prefix'][cur]
        return out  # leaf first
    def callers_of(self, pattern, depth=1):
        pat = re.compile(pattern)
        c = collections.Counter(); hit = 0
        for s in self.th['samples']['stack']:
            if s is None: continue
            names = [self.name(f) for f in self.frames_of(s)]
            # A collection is charged to whatever allocation tripped it;
            # leave those samples out so callers rank by their own work.
            if self.no_gc and names and ('copying::' in names[0] or 'store::gc' in names[0] or 'gc_alloc' in names[0] or 'GcHeap' in names[0]):
                continue
            idx = next((i for i, n in enumerate(names) if pat.search(n)), None)
            if idx is None: continue
            hit += 1
            # skip up through matching frames, then take `depth` wasm callers
            j = idx
            while j < len(names) and pat.search(names[j]): j += 1
            chain = []
            while j < len(names) and len(chain) < depth:
                if names[j].startswith('wasm') and 'trampoline' not in names[j]:
                    chain.append(names[j])
                j += 1
            c[' <- '.join(chain) or '?'] += 1
        return hit, c

ap = argparse.ArgumentParser()
ap.add_argument('--syms', required=True)
ap.add_argument('--p', nargs=4, metavar=('PROF', 'MAP', 'CWASM', 'WAT'), required=True)
ap.add_argument('--callers', action='append', default=[])
ap.add_argument('--depth', type=int, default=1)
ap.add_argument('--top', type=int, default=30)
ap.add_argument('--with-gc', action='store_true', help='keep samples whose leaf is in the collector')
args = ap.parse_args()
p = P(*args.p, sd.load_syms(args.syms))
p.no_gc = not args.with_gc
total = sum(1 for s in p.th['samples']['stack'] if s is not None)
print(f'samples: {total}')
if not args.callers:
    for k, v in p.self_counts().most_common(args.top):
        print(f'{v:7d} {100*v/total:5.1f}%  {k[:110]}')
for pat in args.callers:
    hit, c = p.callers_of(pat, args.depth)
    print(f'\n-- frames matching {pat!r}: {hit} samples ({100*hit/total:.1f}%); callers:')
    for k, v in c.most_common(args.top):
        print(f'{v:7d} {100*v/total:5.1f}%  {k[:150]}')
