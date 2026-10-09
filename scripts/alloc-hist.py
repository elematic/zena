#!/usr/bin/env python3
"""Join a ZENA_ALLOC_HIST run's stderr with the module's type names.

    alloc-hist.py <run.log> <module.wat> [--module N] [--top K]

The log holds `[type-map]` blocks (one per core module instantiated;
the biggest is the compiler) and `[alloc-hist]` rows keyed by engine
shared type index. The .wat is `wasm-tools print` of the component;
`--module` picks the core module whose type indices the map refers to
(default: the one with the most types).
"""
import re, sys, collections, argparse

ap = argparse.ArgumentParser()
ap.add_argument('log'); ap.add_argument('wat')
ap.add_argument('--top', type=int, default=60)
ap.add_argument('--group', action='store_true', help='fold _s<n> suffixes and vtables')
args = ap.parse_args()

# type-map blocks: choose the largest
blocks, cur = [], None
hist, total = {}, None
for line in open(args.log):
    if line.startswith('[type-map] module types='):
        cur = {}; blocks.append(cur)
    elif line.startswith('[type-map] '):
        w, s = line.split()[1:3]; cur[int(s)] = int(w)  # shared -> wasm (last wins)
        cur.setdefault('_multi', collections.defaultdict(set))[int(s)].add(int(w))
    elif line.startswith('[alloc-hist] total'):
        m = re.search(r'objects=(\d+) bytes=(\d+) walks=(\d+)', line); total = tuple(map(int, m.groups()))
    elif line.startswith('[alloc-hist] ty='):
        m = re.search(r'ty=(\d+) count=(\d+) bytes=(\d+)', line)
        hist[int(m.group(1))] = (int(m.group(2)), int(m.group(3)))
tmap = max(blocks, key=len)
multi = tmap.pop('_multi')

# names from the wat: the core module with the most types
mods = re.split(r'^  \(core module', open(args.wat).read(), flags=re.M)
names = {}
for mod in mods[1:]:
    n = {}
    for m in re.finditer(r'^\s*\(type (?:\$(\S+) )?\(;(\d+);\) (.*)$', mod, flags=re.M):
        n[int(m.group(2))] = m.group(1) or m.group(3)[:50]
    if len(n) > len(names): names = n

def name(shared):
    ws = multi.get(shared)
    if not ws: return f'shared#{shared}'
    return '|'.join(sorted(names.get(w, f'type#{w}') for w in ws))[:90]

rows = []
for ty, (n, b) in hist.items():
    rows.append((b, n, name(ty)))
if args.group:
    g = collections.defaultdict(lambda: [0, 0])
    for b, n, nm in rows:
        key = re.sub(r'_s\d+', '', nm.split('|')[0])
        g[key][0] += b; g[key][1] += n
    rows = [(b, n, k) for k, (b, n) in g.items()]
rows.sort(reverse=True)
tb = total[1] if total else sum(r[0] for r in rows)
print(f'total objects={total[0]:,} bytes={total[1]:,} ({total[1]/2**30:.2f} GiB) walks={total[2]}')
print(f'{"bytes":>14} {"%":>5} {"cum%":>5} {"count":>12} {"avg":>5}  type')
cum = 0
for b, n, nm in rows[:args.top]:
    cum += b
    print(f'{b:14,} {100*b/tb:5.1f} {100*cum/tb:5.1f} {n:12,} {b//max(n,1):5}  {nm}')
