import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// When compiled, this runs from lib/module-loader.js, so we need to go up one level to package root
const pkgRoot = path.resolve(__dirname, '..');
const stdlibDir = path.resolve(pkgRoot, 'zena');
const manifestPath = path.resolve(pkgRoot, 'stdlib-manifest.json');

export type Target = 'host' | 'wasi';

interface VirtualMapping {
  host: string;
  wasi: string;
}

interface ModuleEntry {
  virtual?: VirtualMapping;
}

interface StdlibManifest {
  modules: Record<string, ModuleEntry>;
  internal: string[];
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
 * Check if a module name is internal (not directly importable)
 */
export const isInternalModule = (name: string): boolean => {
  const manifest = getManifest();
  return manifest.internal.includes(name);
};

/**
 * Resolve a module specifier to its actual module name.
 * Handles virtual modules like 'console' → 'console-host' or 'console-wasi'.
 * Returns null if the module is not found or not importable.
 */
export const resolveStdlibModule = (
  name: string,
  target: Target = 'host',
): string | null => {
  const manifest = getManifest();

  // Check if it's an internal module (not directly importable)
  if (manifest.internal.includes(name)) {
    return null;
  }

  // Check if it's a known public module
  const entry = manifest.modules[name];
  if (!entry) {
    return null;
  }

  // Handle virtual modules
  if (entry.virtual) {
    return entry.virtual[target];
  }

  return name;
};

/**
 * Load a stdlib module's source code.
 * The name should be the resolved module name (after virtual resolution).
 */
export const loadStdlibModule = (name: string): string => {
  // Check cache first
  if (moduleCache.has(name)) {
    return moduleCache.get(name)!;
  }

  const filePath = path.join(stdlibDir, `${name}.zena`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Stdlib module file not found: ${name}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  moduleCache.set(name, content);
  return content;
};

/**
 * Resolve and load a stdlib module in one step.
 * Returns null if the module is not importable.
 */
export const getStdlibModule = (
  name: string,
  target: Target = 'host',
): string | null => {
  const resolved = resolveStdlibModule(name, target);
  if (!resolved) {
    return null;
  }
  return loadStdlibModule(resolved);
};

/**
 * Get all public module names
 */
export const getPublicModules = (): string[] => {
  const manifest = getManifest();
  return Object.keys(manifest.modules);
};

/**
 * Get all internal module names
 */
export const getInternalModules = (): string[] => {
  const manifest = getManifest();
  return [...manifest.internal];
};
