import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const EM_X86_64 = 0x3e;
const PT_INTERP = 3;
const STANDARD_INTERP = '/lib64/ld-linux-x86-64.so.2';
const LINUX_TARGET = 'x86_64-unknown-linux-gnu';

/**
 * Resolves the path to a Linux x86_64 `zena-run` binary, cross-compiling via
 * `cargo zigbuild` automatically when running on non-Linux-x86_64 hosts (such
 * as macOS).
 */
export const resolveLinuxRunner = ({
  repoRoot,
  envRunner = process.env.ZENA_LINUX_RUNNER,
  platform = process.platform,
  arch = process.arch,
  runCommand = (cmd, args, opts) => execFileSync(cmd, args, opts),
  fileExists = existsSync,
} = {}) => {
  if (envRunner) {
    if (!fileExists(envRunner)) {
      throw new Error(
        `ZENA_LINUX_RUNNER points to a missing file: ${envRunner}`,
      );
    }
    return envRunner;
  }

  if (platform === 'linux' && arch === 'x64') {
    const nativePath = resolve(repoRoot, 'target/release/zena-run');
    if (!fileExists(nativePath)) {
      runCommand('cargo', ['build', '--release', '-p', 'zena-run'], {
        cwd: repoRoot,
        stdio: 'inherit',
      });
    }
    return nativePath;
  }

  try {
    runCommand(
      'cargo',
      ['zigbuild', '--release', '--target', LINUX_TARGET, '-p', 'zena-run'],
      {
        cwd: repoRoot,
        stdio: 'inherit',
      },
    );
  } catch (err) {
    throw new Error(
      `Failed to cross-compile zena-run for Linux x86_64 on ${platform}/${arch}.\n` +
        `Make sure the Linux target and cargo-zigbuild are installed:\n` +
        `  rustup target add ${LINUX_TARGET}\n` +
        `  brew install cargo-zigbuild\n` +
        `(Or set ZENA_LINUX_RUNNER=/path/to/linux-x86_64-zena-run)`,
      {cause: err},
    );
  }

  return resolve(repoRoot, `target/${LINUX_TARGET}/release/zena-run`);
};

/**
 * Validates that `buf` is a 64-bit Linux x86_64 ELF binary, and if its
 * `PT_INTERP` header points into `/nix/store/.../ld-linux-x86-64.so.2` (as on
 * NixOS hosts), rewrites it in-place to `/lib64/ld-linux-x86-64.so.2` so it can
 * execute inside a standard Debian/Ubuntu container.
 */
export const prepareLinuxRunner = (
  buf,
  {
    sourcePath = 'target/release/zena-run',
    platform = process.platform,
    arch = process.arch,
  } = {},
) => {
  if (
    buf.byteLength < 64 ||
    !buf.subarray(0, 4).equals(ELF_MAGIC) ||
    buf[4] !== ELFCLASS64 ||
    buf[5] !== ELFDATA2LSB ||
    buf.readUInt16LE(18) !== EM_X86_64
  ) {
    throw new Error(
      `${sourcePath} is not a Linux x86_64 ELF binary (current host: ${platform}/${arch}).\n` +
        `The website container runs on Linux x86_64. Either build/deploy from a Linux x86_64 host,\n` +
        `or install cargo-zigbuild so stage:docker can cross-compile zena-run automatically:\n` +
        `  rustup target add ${LINUX_TARGET}\n` +
        `  brew install cargo-zigbuild`,
    );
  }

  const out = Buffer.from(buf);
  const phoff = Number(out.readBigUInt64LE(32));
  const phentsize = out.readUInt16LE(54);
  const phnum = out.readUInt16LE(56);

  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    if (ph + phentsize > out.byteLength) break;
    const pType = out.readUInt32LE(ph);
    if (pType !== PT_INTERP) continue;

    const pOffset = Number(out.readBigUInt64LE(ph + 8));
    const pFilesz = Number(out.readBigUInt64LE(ph + 32));
    if (pOffset + pFilesz > out.byteLength) break;

    const rawInterp = out
      .subarray(pOffset, pOffset + pFilesz)
      .toString('utf8')
      .replace(/\0+$/, '');

    if (
      rawInterp.startsWith('/nix/store/') &&
      rawInterp.endsWith('/ld-linux-x86-64.so.2')
    ) {
      const replacementLen = Buffer.byteLength(STANDARD_INTERP) + 1;
      if (replacementLen <= pFilesz) {
        out.fill(0, pOffset, pOffset + pFilesz);
        out.write(STANDARD_INTERP, pOffset, 'utf8');
        out.writeBigUInt64LE(BigInt(replacementLen), ph + 32);
        out.writeBigUInt64LE(BigInt(replacementLen), ph + 40);
      }
    }
    break;
  }

  return out;
};
