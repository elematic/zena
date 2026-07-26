import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// When compiled, this runs from lib/module-loader.js, so we need to go up one level to package root
const pkgRoot = path.resolve(__dirname, '..');
const stdlibDir = path.resolve(pkgRoot, 'zena');
const manifestPath = path.resolve(pkgRoot, 'stdlib-manifest.json');

export type Target = 'host' | 'wasi';

interface ModuleEntry {
  /** Entry file relative to zena/. Defaults to `<name>.zena`. */
  path?: string;
  /** Target-conditional entry files, relative to zena/. */
  virtual?: Record<string, string>;
}

interface StdlibManifest {
  modules: Record<string, ModuleEntry>;
}

let cachedManifest: StdlibManifest | null = null;
const moduleCache = new Map<string, string>();

/**
 * Load and cache the stdlib manifest
 */
const getManifest = (): StdlibManifest => {
  if (!cachedManifest) {
    cachedManifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8'),
    ) as StdlibManifest;
  }
  return cachedManifest;
};

/**
 * Check if a module name is a valid stdlib module
 */
export const isStdlibModule = (name: string): boolean => {
  const manifest = getManifest();
  return name in manifest.modules;
};

/**
 * Map a canonical stdlib module id to its file path relative to the zena/
 * source directory.
 *
 * Canonical ids come in two shapes:
 * - Name ids (`zena:string`): manifest module names. The file is the entry's
 *   `path`, defaulting to `<name>.zena`.
 * - Path ids (`zena:console/host.zena`): files without a manifest name (the
 *   result of virtual-module resolution or relative imports between stdlib
 *   files). The id contains the file path directly.
 *
 * Accepts the id with or without the `zena:` prefix.
 */
export const stdlibModuleFilePath = (id: string): string => {
  const sub = id.startsWith('zena:') ? id.substring(5) : id;
  if (sub.endsWith('.zena')) {
    return sub;
  }
  const entry = getManifest().modules[sub];
  return entry?.path ?? `${sub}.zena`;
};

/**
 * Map a file path relative to zena/ back to a canonical stdlib module id.
 *
 * Returns a name id only for a manifest module whose entry file is the
 * default `<name>.zena` — modules with an explicit `path` or `virtual`
 * mapping canonicalize to path ids everywhere (see resolveStdlibImport), so
 * each file has exactly one canonical id and module dedup works.
 */
const pathToStdlibId = (relPath: string): string => {
  if (!relPath.includes('/') && relPath.endsWith('.zena')) {
    const name = relPath.slice(0, -'.zena'.length);
    const entry = getManifest().modules[name];
    if (entry && !entry.virtual && !entry.path) {
      return `zena:${name}`;
    }
  }
  return `zena:${relPath}`;
};

/**
 * Resolve an import of `zena:<name>` to a canonical module id.
 * Handles virtual modules like 'console' → 'zena:console/host.zena'.
 * Returns null if the module is not found or not available for the target.
 */
export const resolveStdlibImport = (
  name: string,
  target: Target = 'host',
): string | null => {
  const entry = getManifest().modules[name];
  if (!entry) {
    return null;
  }
  if (entry.virtual) {
    const virtualPath = entry.virtual[target];
    return virtualPath ? `zena:${virtualPath}` : null;
  }
  if (entry.path) {
    return `zena:${entry.path}`;
  }
  return `zena:${name}`;
};

/**
 * Resolve a relative import specifier from a stdlib module.
 * Returns the canonical id of the target module, or null if the specifier
 * escapes the stdlib source directory.
 */
export const resolveStdlibRelative = (
  specifier: string,
  referrerId: string,
): string | null => {
  const referrerPath = stdlibModuleFilePath(referrerId);
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(referrerPath), specifier),
  );
  if (resolved.startsWith('..')) {
    return null;
  }
  return pathToStdlibId(resolved);
};

/**
 * Resolve a specifier in the context of the stdlib. Handles `zena:<name>`
 * imports (from anywhere) and relative imports whose referrer is a stdlib
 * module. Returns null when the specifier is not stdlib-related, so callers
 * can fall through to their own file/package resolution. Throws on unknown
 * stdlib modules and on relative imports escaping the stdlib.
 */
export const resolveStdlibSpecifier = (
  specifier: string,
  referrer: string,
  target: Target = 'host',
): string | null => {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!referrer.startsWith('zena:')) {
      return null;
    }
    const resolved = resolveStdlibRelative(specifier, referrer);
    if (!resolved) {
      throw new Error(
        `Cannot resolve '${specifier}' from ${referrer} (escapes the stdlib)`,
      );
    }
    return resolved;
  }
  if (specifier.startsWith('zena:')) {
    const resolved = resolveStdlibImport(specifier.substring(5), target);
    if (!resolved) {
      throw new Error(`Unknown stdlib module: ${specifier}`);
    }
    return resolved;
  }
  return null;
};

/**
 * Load a stdlib module's source code by canonical id (with or without the
 * `zena:` prefix).
 */
export const loadStdlibModule = (id: string): string => {
  const relPath = stdlibModuleFilePath(id);
  if (relPath.split('/').includes('..')) {
    throw new Error(`Invalid stdlib module path: ${id}`);
  }
  const cached = moduleCache.get(relPath);
  if (cached !== undefined) {
    return cached;
  }

  const filePath = path.join(stdlibDir, relPath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Stdlib module file not found: ${id}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  moduleCache.set(relPath, content);
  return content;
};

/**
 * Get all public module names
 */
export const getPublicModules = (): string[] => {
  const manifest = getManifest();
  return Object.keys(manifest.modules);
};
