/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as esModuleLexer from 'es-module-lexer';
import type {ModuleRegistry} from './cdn-module-registry.js';
import {NodeModuleResolver} from './node-module-resolver.js';
import {
  classifySpecifier,
  fileExtension,
  parseNpmStyleSpecifier,
  relativeUrlPath,
  type PackageJson,
} from './util.js';

export interface TransformableFile {
  name: string;
  content: string;
  contentType?: string;
}

/**
 * Transforms bare module specifiers in `.js` files to canonical local paths
 * under `node_modules/<pkg>@<version>/<path>`.
 */
export class BareModuleTransformer {
  readonly #registry: ModuleRegistry;
  readonly #nodeResolver = new NodeModuleResolver({
    conditions: ['module', 'import', 'development', 'browser'],
  });

  constructor(registry: ModuleRegistry) {
    this.#registry = registry;
  }

  async transformModule(
    file: TransformableFile,
    packageJson: PackageJson = {},
  ): Promise<TransformableFile> {
    let js = file.content;
    let specifiers: ReadonlyArray<esModuleLexer.ImportSpecifier>;
    await esModuleLexer.init;
    try {
      [specifiers] = esModuleLexer.parse(js);
    } catch {
      return file;
    }

    const transforms: Array<{
      info: esModuleLexer.ImportSpecifier;
      newSpecifierPromise: Promise<string>;
    }> = [];

    // Iterate backwards so character offsets remain valid after each replacement.
    for (let i = specifiers.length - 1; i >= 0; i--) {
      const {n: oldSpecifier} = specifiers[i];
      if (oldSpecifier === undefined) {
        continue;
      }
      transforms.push({
        info: specifiers[i],
        newSpecifierPromise: this.#transformSpecifier(
          oldSpecifier,
          file.name,
          packageJson,
        ),
      });
    }

    for (const {
      info: {s: start, e: end, n: oldSpecifier, d: dynamicStart},
      newSpecifierPromise,
    } of transforms) {
      let newSpecifier: string;
      try {
        newSpecifier = await newSpecifierPromise;
      } catch (e) {
        console.error(e);
        continue;
      }
      if (newSpecifier === oldSpecifier) {
        continue;
      }
      const isDynamic = dynamicStart !== -1;
      const replacement = isDynamic ? `'${newSpecifier}'` : newSpecifier;
      js = js.substring(0, start) + replacement + js.substring(end);
    }

    return {
      name: file.name,
      content: js,
      contentType: file.contentType ?? 'application/javascript; charset=utf-8',
    };
  }

  async #transformSpecifier(
    specifier: string,
    referrer: string,
    packageJson: PackageJson,
  ): Promise<string> {
    const kind = classifySpecifier(specifier);
    if (kind === 'url') {
      return specifier;
    }
    if (kind === 'bare') {
      return this.#transformBareSpecifier(specifier, referrer, packageJson);
    }
    return specifier;
  }

  async #transformBareSpecifier(
    specifier: string,
    referrer: string,
    rootPackageJson: PackageJson,
  ): Promise<string> {
    let location = parseNpmStyleSpecifier(specifier);
    if (location === undefined) {
      throw new Error(`Invalid specifier "${specifier}"`);
    }
    if (!location.version) {
      location.version =
        rootPackageJson?.dependencies?.[location.pkg] ?? 'latest';
    }
    location.version = await this.#registry.resolveVersion(location);
    const packageJson = await this.#registry.fetchPackageJson(location);
    location.path = this.#nodeResolver.resolve(location, packageJson, referrer);
    if (!fileExtension(location.path)) {
      location = await this.#registry.canonicalize(location);
    }
    const absolute = `node_modules/${location.pkg}@${location.version}/${location.path}`;
    return relativeUrlPath(referrer, absolute);
  }
}
