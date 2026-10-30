#!/usr/bin/env python3
"""Lets a CI run reuse the workspace crates a cached build compiled.

Cargo decides whether a workspace crate is fresh from its source files'
modification times. A fresh checkout gives every file the time of the
checkout, so cargo recompiled every workspace crate in every run, even when
the cached artifacts were compiled from exactly these sources: zena-runtime,
the three binaries and their links, about two minutes on a 4-CPU runner.

  record   After the build: write the SHA-256 and the modification time of
           each Rust input to target/zena-rust-sources.tsv, beside the
           artifacts, so the cache saves the two together.
  restore  After restoring that cache: give each Rust input whose content
           matches the recorded hash the modification time it had when the
           cached build compiled it. Cargo then sees what it saw then and
           reuses what it compiled. An input that changed keeps the
           checkout's time, newer than any recorded one, and is recompiled,
           as is everything that depends on it.

The recorded time is restored to the nanosecond, not to some older time: a
build script that declares no `rerun-if-changed`, such as workspace-hack's,
makes cargo store the newest mtime in its package and treat any other value
as a change. Every crate depends on workspace-hack, so one input off by a
nanosecond recompiles all of them. That is why this is Python: `os.utime`
takes integer nanoseconds, while the runner's `touch -d @<seconds>` rounds
the fraction (it moved 1793210666.612279336 to .612279400).

The inputs are the git-tracked files under PATHS. A file cargo reads that
is not among them keeps the checkout's time, which costs a recompile and
never a stale artifact.
"""

import hashlib
import os
import subprocess
import sys

MANIFEST = 'target/zena-rust-sources.tsv'
PATHS = [
    'Cargo.toml',
    'Cargo.lock',
    'packages/workspace-hack',
    'packages/zena-runtime',
    'packages/zena-run',
    'packages/zena-cli/Cargo.toml',
    'packages/zena-cli/build.rs',
    'packages/zena-cli/src',
    'packages/zenafx/Cargo.toml',
    'packages/zenafx/src',
    'packages/zenafx/tests',
    'packages/zenafx/wit',
    'packages/stdlib/zena/host-wit',
]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def tracked():
    out = subprocess.run(['git', 'ls-files', '-z', '--', *PATHS],
                         capture_output=True, check=True).stdout
    return [p.decode() for p in out.split(b'\0') if p]


def parse_mtime_ns(text):
    """Integer nanoseconds, or `<seconds>.<fraction>` from a manifest the
    shell version of this script wrote, read without a float."""
    if '.' not in text:
        return int(text)
    seconds, fraction = text.split('.', 1)
    return int(seconds) * 1_000_000_000 + int(fraction[:9].ljust(9, '0'))


def record():
    os.makedirs('target', exist_ok=True)
    with open(MANIFEST, 'w') as out:
        for path in tracked():
            out.write(f'{sha256(path)}\t{os.stat(path).st_mtime_ns}\t{path}\n')
    with open(MANIFEST) as f:
        count = sum(1 for _ in f)
    print(f'Recorded {count} Rust inputs in {MANIFEST}')


def restore():
    if not os.path.exists(MANIFEST):
        print(f'No {MANIFEST}: the workspace crates compile from scratch.')
        return
    matched = total = 0
    with open(MANIFEST) as f:
        for line in f:
            digest, mtime, path = line.rstrip('\n').split('\t', 2)
            total += 1
            if os.path.isfile(path) and sha256(path) == digest:
                ns = parse_mtime_ns(mtime)
                os.utime(path, ns=(ns, ns))
                matched += 1
    print(f'{matched} of {total} Rust inputs match the cached build; the rest recompile.')


def main():
    os.chdir(subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                            capture_output=True, check=True, text=True).stdout.strip())
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    if command == 'record':
        record()
    elif command == 'restore':
        restore()
    else:
        print(f'usage: {sys.argv[0]} record|restore', file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
