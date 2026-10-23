/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {
  fileExtension,
  isExactSemverVersion,
  parseNpmStyleSpecifier,
  pkgVersion,
  pkgVersionPath,
  trimLeadingSlash,
  type NpmFileLocation,
  type PackageJson,
} from './util.js';

export interface Content {
  content: string;
  contentType: string;
}

export interface LocalPackageConfig {
  packageJson: PackageJson & {name: string; version: string};
  /**
   * Maps a package-relative path (e.g. `'index.js'`) to either a URL to fetch
   * or an inline `{content, contentType}` object.
   */
  files: Record<string, string | Content>;
}

export interface ModuleRegistry {
  fetch(location: NpmFileLocation): Promise<Content>;
  canonicalize(location: NpmFileLocation): Promise<NpmFileLocation>;
  resolveVersion(params: {pkg: string; version: string}): Promise<string>;
  fetchPackageJson(params: {
    pkg: string;
    version: string;
  }): Promise<PackageJson>;
}

/**
 * Resolves and fetches npm packages from a CDN (such as jsDelivr or unpkg),
 * with an optional local package overlay for monorepo packages like
 * `@zena-lang/runtime` and `@zena-lang/wasm-web-ui`.
 */
export class CdnModuleRegistry implements ModuleRegistry {
  readonly #urlPrefix: string;
  readonly #fetch: typeof fetch;
  readonly #localPackages: Map<string, LocalPackageConfig>;

  readonly #fetchCache = new Map<
    string,
    Promise<{url: string; file: Content}>
  >();

  readonly #versionCache = new Map<string, string>();

  constructor(
    urlPrefix = 'https://cdn.jsdelivr.net/npm/',
    options?: {
      fetchFn?: typeof fetch;
      localPackages?: Record<string, LocalPackageConfig>;
    },
  ) {
    this.#urlPrefix = urlPrefix.endsWith('/') ? urlPrefix : urlPrefix + '/';
    this.#fetch = options?.fetchFn ?? fetch;
    this.#localPackages = new Map(Object.entries(options?.localPackages ?? {}));
  }

  async fetch(location: NpmFileLocation): Promise<Content> {
    const localPkg = this.#localPackages.get(location.pkg);
    if (localPkg !== undefined) {
      const cleanPath = trimLeadingSlash(location.path) || 'index.js';
      if (cleanPath === 'package.json') {
        return {
          content: JSON.stringify(localPkg.packageJson),
          contentType: 'application/json; charset=utf-8',
        };
      }
      const entry = localPkg.files[cleanPath];
      if (entry === undefined) {
        throw new Error(
          `Local package ${location.pkg} does not contain file "${cleanPath}"`,
        );
      }
      if (typeof entry === 'object') {
        return entry;
      }
      const cached = this.#fetchCache.get(`local:${location.pkg}/${cleanPath}`);
      if (cached !== undefined) {
        return (await cached).file;
      }
      let promise!: Promise<{url: string; file: Content}>;
      promise = (async () => {
        const fetchFn = this.#fetch;
        const res = await fetchFn(entry);
        const content = await res.text();
        if (!res.ok) {
          throw new Error(
            `Failed to load local vendor module ${entry} (${res.status})`,
          );
        }
        return {
          url: entry,
          file: {
            content,
            contentType:
              res.headers.get('content-type') ??
              'application/javascript; charset=utf-8',
          },
        };
      })();
      this.#fetchCache.set(`local:${location.pkg}/${cleanPath}`, promise);
      return (await promise).file;
    }

    const {file} = await this.#fetchContent(location);
    return file;
  }

  async canonicalize(location: NpmFileLocation): Promise<NpmFileLocation> {
    const localPkg = this.#localPackages.get(location.pkg);
    if (localPkg !== undefined) {
      let cleanPath = trimLeadingSlash(location.path) || 'index.js';
      if (!fileExtension(cleanPath) && localPkg.files[`${cleanPath}.js`]) {
        cleanPath = `${cleanPath}.js`;
      }
      return {
        pkg: location.pkg,
        version: localPkg.packageJson.version,
        path: cleanPath,
      };
    }

    let version = location.version;
    if (!isExactSemverVersion(version)) {
      version = await this.resolveVersion({pkg: location.pkg, version});
    }
    let path = location.path;
    if (fileExtension(path) === '') {
      // Try appending `.js` if extensionless
      try {
        await this.#fetchContent({
          pkg: location.pkg,
          version,
          path: `${path}.js`,
        });
        path = `${path}.js`;
      } catch {
        const {url} = await this.#fetchContent({
          pkg: location.pkg,
          version,
          path,
        });
        const parsed = this.#tryParseCdnUrl(url);
        if (parsed !== undefined && fileExtension(parsed.path) !== '') {
          path = parsed.path;
        }
      }
    }
    return {pkg: location.pkg, version, path};
  }

  async resolveVersion({
    pkg,
    version,
  }: {
    pkg: string;
    version: string;
  }): Promise<string> {
    const localPkg = this.#localPackages.get(pkg);
    if (localPkg !== undefined) {
      return localPkg.packageJson.version;
    }
    if (isExactSemverVersion(version)) {
      return version;
    }
    const pv = pkgVersion({pkg, version});
    const cached = this.#versionCache.get(pv);
    if (cached !== undefined) {
      return cached;
    }
    const pkgJson = await this.fetchPackageJson({pkg, version});
    const resolved = pkgJson.version || version || 'latest';
    this.#versionCache.set(pv, resolved);
    return resolved;
  }

  async fetchPackageJson({
    pkg,
    version,
  }: {
    pkg: string;
    version: string;
  }): Promise<PackageJson> {
    const localPkg = this.#localPackages.get(pkg);
    if (localPkg !== undefined) {
      return localPkg.packageJson;
    }
    const {
      url,
      file: {content},
    } = await this.#fetchContent({pkg, version, path: 'package.json'});
    let parsed: PackageJson;
    try {
      parsed = JSON.parse(content) as PackageJson;
    } catch (e) {
      throw new Error(`Error parsing CDN package.json from ${url}: ${e}`);
    }
    if (parsed.version) {
      this.#versionCache.set(pkgVersion({pkg, version}), parsed.version);
    }
    return parsed;
  }

  async #fetchContent(
    location: NpmFileLocation,
  ): Promise<{url: string; file: Content}> {
    let exact = isExactSemverVersion(location.version);
    if (!exact) {
      const pv = pkgVersion(location);
      const resolved = this.#versionCache.get(pv);
      if (resolved !== undefined) {
        location = {...location, version: resolved};
        exact = true;
      }
    }
    const pvp = pkgVersionPath(location);
    const cached = this.#fetchCache.get(pvp);
    if (cached !== undefined) {
      return cached;
    }
    let promise!: Promise<{url: string; file: Content}>;
    promise = (async () => {
      const url = this.#urlPrefix + pvp;
      const fetchFn = this.#fetch;
      const res = await fetchFn(url);
      const content = await res.text();
      if (res.status !== 200) {
        throw new Error(`CDN HTTP ${res.status} error (${url}): ${content}`);
      }
      if (!exact) {
        const canonical = this.#tryParseCdnUrl(res.url);
        if (canonical && isExactSemverVersion(canonical.version)) {
          this.#versionCache.set(pkgVersion(location), canonical.version);
          this.#fetchCache.set(pkgVersionPath(canonical), promise);
        }
      }
      return {
        url: res.url || url,
        file: {
          content,
          contentType:
            res.headers.get('content-type') ??
            'application/javascript; charset=utf-8',
        },
      };
    })();
    this.#fetchCache.set(pvp, promise);
    return promise;
  }

  #tryParseCdnUrl(url: string): NpmFileLocation | undefined {
    if (url.startsWith(this.#urlPrefix)) {
      return parseNpmStyleSpecifier(url.slice(this.#urlPrefix.length));
    }
    return undefined;
  }
}
