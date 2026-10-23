/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import {packageExportsResolve} from './node-resolve.js';
import type {NpmFileLocation, PackageJson} from './util.js';

/**
 * Resolves a path according to the Node package exports algorithm.
 */
export class NodeModuleResolver {
  readonly #conditions: Set<string>;

  constructor({conditions}: {conditions: string[]}) {
    this.#conditions = new Set(conditions);
  }

  resolve(
    location: NpmFileLocation,
    packageJson: PackageJson,
    base: string,
  ): string {
    const packageSubpath = addRelativePrefix(location.path);

    if (packageJson.exports === undefined) {
      if (packageSubpath === '.') {
        if (packageJson.module !== undefined) {
          return removeRelativePrefix(packageJson.module);
        }
        if (packageJson.main !== undefined) {
          return removeRelativePrefix(packageJson.main);
        }
        return 'index.js';
      }
      return location.path;
    }

    const packageBase = `/node_modules/${location.pkg}@${location.version}/`;
    const packageJsonUrl = new URL(packageBase, 'file://');

    const resolved = packageExportsResolve(
      packageJsonUrl,
      packageSubpath,
      packageJson,
      base,
      this.#conditions,
    );
    if (!resolved.pathname.startsWith(packageBase)) {
      throw new Error(
        `Unexpected error: ${resolved.pathname} expected to start with ${packageBase}`,
      );
    }
    return resolved.pathname.slice(packageBase.length);
  }
}

const addRelativePrefix = (path: string): string => {
  if (path === '') {
    return '.';
  }
  if (!path.startsWith('.') && !path.startsWith('/')) {
    return './' + path;
  }
  return path;
};

const removeRelativePrefix = (path: string): string => {
  if (path === '.') {
    return '';
  }
  if (path.startsWith('./')) {
    return path.slice(2);
  }
  return path;
};
