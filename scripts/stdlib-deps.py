#!/usr/bin/env python3
"""Print the standard library's inter-module dependency graph and its layering.

Each published module is read as its entry file plus the private siblings it
reaches by relative import. Imports of other `zena:` modules become edges.
Layer N holds the modules whose dependencies all sit in layers below N, so a
module can only be grouped with another without creating a cycle if the
grouping respects this order. Modules left over after the peel are part of a
cycle and are reported separately.

Run from the repository root:  python3 scripts/stdlib-deps.py
"""

import json
import os
import re
import sys
from collections import defaultdict

ROOT = "packages/stdlib/zena"
MANIFEST = "packages/stdlib/stdlib-manifest.json"

FROM_IMPORT = re.compile(r"(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*'([^']+)'")
SIDE_IMPORT = re.compile(r"(?:^|\n)\s*import\s*'([^']+)'")


def imports(path):
    """Module specifiers imported by one file, with comments stripped."""
    with open(os.path.join(ROOT, path)) as f:
        src = f.read()
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"//[^\n]*", "", src)
    return set(FROM_IMPORT.findall(src)) | set(SIDE_IMPORT.findall(src))


def entry_files(name, cfg):
    if "path" in cfg:
        return [cfg["path"]]
    if "virtual" in cfg:
        return list(set(cfg["virtual"].values()))
    return [name + ".zena"]


def main():
    with open(MANIFEST) as f:
        modules = json.load(f)["modules"]

    present = set()
    for dirpath, _, filenames in os.walk(ROOT):
        for filename in filenames:
            if filename.endswith(".zena"):
                present.add(os.path.relpath(os.path.join(dirpath, filename), ROOT))

    deps = defaultdict(set)
    missing = []
    for name, cfg in modules.items():
        seen, stack = set(), entry_files(name, cfg)
        while stack:
            path = stack.pop()
            if path in seen:
                continue
            seen.add(path)
            if path not in present:
                missing.append((name, path))
                continue
            for spec in imports(path):
                if spec.startswith("zena:"):
                    deps[name].add(spec[len("zena:"):])
                else:
                    stack.append(
                        os.path.normpath(os.path.join(os.path.dirname(path), spec))
                    )
        deps[name].discard(name)

    layer, remaining, placed = 0, set(modules), {}
    while remaining:
        ready = [
            m for m in remaining
            if all(d in placed or d not in modules for d in deps[m])
        ]
        if not ready:
            break
        for m in ready:
            placed[m] = layer
        remaining -= set(ready)
        layer += 1

    for n in range(layer):
        print(f"L{n}: " + ", ".join(sorted(m for m in placed if placed[m] == n)))

    if missing:
        print("\nManifest entries with no file:")
        for name, path in sorted(missing):
            print(f"  {name} -> {path}")

    if remaining:
        print("\nCyclic:")
        for m in sorted(remaining):
            print(f"  {m} -> {sorted(d for d in deps[m] if d in remaining)}")

    print("\nDependencies:")
    for m in sorted(modules):
        print(f"  {m}: {', '.join(sorted(deps[m])) or '-'}")

    return 1 if remaining else 0


if __name__ == "__main__":
    sys.exit(main())
