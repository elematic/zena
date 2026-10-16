import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {prepareLinuxRunner, resolveLinuxRunner} from '../lib/stage-docker.js';

/** Builds a minimal valid 64-bit little-endian x86_64 ELF buffer with a PT_INTERP header. */
const makeMockElf64 = (interp) => {
  const interpBytes = Buffer.from(interp + '\0', 'utf8');
  const phoff = 64;
  const phentsize = 56;
  const phnum = 1;
  const interpOffset = phoff + phentsize;
  const buf = Buffer.alloc(interpOffset + interpBytes.length);

  // e_ident: \x7fELF, ELFCLASS64 (2), ELFDATA2LSB (1), EV_CURRENT (1)
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 2;
  buf[5] = 1;
  buf[6] = 1;
  // e_type = ET_DYN (3), e_machine = EM_X86_64 (0x3e)
  buf.writeUInt16LE(3, 16);
  buf.writeUInt16LE(0x3e, 18);
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(BigInt(phoff), 32);
  buf.writeUInt16LE(64, 52);
  buf.writeUInt16LE(phentsize, 54);
  buf.writeUInt16LE(phnum, 56);

  // Program header 0: PT_INTERP (3)
  buf.writeUInt32LE(3, phoff);
  buf.writeUInt32LE(4, phoff + 4);
  buf.writeBigUInt64LE(BigInt(interpOffset), phoff + 8);
  buf.writeBigUInt64LE(BigInt(interpBytes.length), phoff + 32);
  buf.writeBigUInt64LE(BigInt(interpBytes.length), phoff + 40);

  interpBytes.copy(buf, interpOffset);
  return {buf, phoff, interpOffset};
};

describe('resolveLinuxRunner', () => {
  it('uses target/release/zena-run directly on linux/x64 when present', () => {
    const calls = [];
    const path = resolveLinuxRunner({
      repoRoot: '/repo',
      envRunner: undefined,
      platform: 'linux',
      arch: 'x64',
      fileExists: () => true,
      runCommand: (cmd, args) => calls.push([cmd, args]),
    });
    assert.equal(path, '/repo/target/release/zena-run');
    assert.equal(calls.length, 0);
  });

  it('automatically runs cargo zigbuild on macOS and returns the cross-compiled path', () => {
    const calls = [];
    const path = resolveLinuxRunner({
      repoRoot: '/repo',
      envRunner: undefined,
      platform: 'darwin',
      arch: 'arm64',
      fileExists: () => true,
      runCommand: (cmd, args, opts) => calls.push({cmd, args, cwd: opts.cwd}),
    });
    assert.equal(
      path,
      '/repo/target/x86_64-unknown-linux-gnu/release/zena-run',
    );
    assert.deepEqual(calls, [
      {
        cmd: 'cargo',
        args: [
          'zigbuild',
          '--release',
          '--target',
          'x86_64-unknown-linux-gnu',
          '-p',
          'zena-run',
        ],
        cwd: '/repo',
      },
    ]);
  });

  it('throws an actionable error if cargo zigbuild fails on macOS', () => {
    assert.throws(
      () =>
        resolveLinuxRunner({
          repoRoot: '/repo',
          envRunner: undefined,
          platform: 'darwin',
          arch: 'arm64',
          runCommand: () => {
            throw new Error('no such subcommand: zigbuild');
          },
        }),
      /nix develop/,
    );
  });
});

describe('prepareLinuxRunner', () => {
  it('rejects macOS Mach-O binaries with an actionable error', () => {
    const machO = Buffer.alloc(64);
    machO.writeUInt32LE(0xfeedfacf, 0);
    assert.throws(
      () =>
        prepareLinuxRunner(machO, {
          sourcePath: 'target/release/zena-run',
          platform: 'darwin',
          arch: 'arm64',
        }),
      /not a Linux x86_64 ELF binary \(current host: darwin\/arm64\)/,
    );
  });

  it('rewrites NixOS /nix/store/.../ld-linux-x86-64.so.2 interpreter to /lib64/ld-linux-x86-64.so.2', () => {
    const nixInterp =
      '/nix/store/57iz36553175g3178pvxjij8z5rcsd4n-glibc-2.42-61/lib/ld-linux-x86-64.so.2';
    const {buf, phoff, interpOffset} = makeMockElf64(nixInterp);

    const out = prepareLinuxRunner(buf);
    const newFilesz = Number(out.readBigUInt64LE(phoff + 32));
    const newInterp = out
      .subarray(interpOffset, interpOffset + newFilesz)
      .toString('utf8');
    assert.equal(newInterp, '/lib64/ld-linux-x86-64.so.2\0');
  });

  it('leaves standard /lib64/ld-linux-x86-64.so.2 interpreter untouched', () => {
    const stdInterp = '/lib64/ld-linux-x86-64.so.2';
    const {buf, phoff, interpOffset} = makeMockElf64(stdInterp);

    const out = prepareLinuxRunner(buf);
    const newFilesz = Number(out.readBigUInt64LE(phoff + 32));
    const newInterp = out
      .subarray(interpOffset, interpOffset + newFilesz)
      .toString('utf8');
    assert.equal(newInterp, '/lib64/ld-linux-x86-64.so.2\0');
  });
});
