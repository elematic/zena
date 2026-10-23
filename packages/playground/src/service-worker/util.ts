/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

export interface NpmFileLocation {
  pkg: string;
  version: string;
  path: string;
}

export type PackageExports =
  PackageExportsTarget | PackageExportsPathOrConditionMap;

export type PackageExportsTarget =
  string | PackageExportsConditionMap | PackageExportsTarget[] | null;

export type PackageExportsPathOrConditionMap = {
  [pathOrCondition: string]: PackageExportsTarget;
};

export type PackageExportsConditionMap = {
  [condition: string]: PackageExportsTarget;
};

export interface PackageJson {
  name?: string;
  version?: string;
  type?: 'module' | 'commonjs';
  main?: string;
  module?: string;
  dependencies?: {[key: string]: string};
  exports?: PackageExports;
}

/**
 * Return the relative path from two URL pathnames.
 *
 * E.g. given "a/b/c.js" and "a/d.js" return "../d.js".
 */
export const relativeUrlPath = (from: string, to: string): string => {
  const fromParts = from.split('/');
  const toParts = to.split('/');
  let numCommon = 0;
  while (
    numCommon < fromParts.length &&
    numCommon < toParts.length &&
    fromParts[numCommon] === toParts[numCommon]
  ) {
    numCommon++;
  }
  const numUp = fromParts.length - numCommon - 1;
  return (
    (numUp === 0 ? './' : new Array(numUp + 1).join('../')) +
    toParts.slice(numCommon).join('/')
  );
};

/**
 * Return whether the given module import specifier is bare, a relative URL, or
 * a fully qualified URL.
 */
export const classifySpecifier = (
  specifier: string,
): 'bare' | 'relative' | 'url' => {
  try {
    void new URL(specifier).href;
    return 'url';
  } catch {}
  if (specifier.match(/^(\.){0,2}\//) !== null) {
    return 'relative';
  }
  return 'bare';
};

/**
 * Parse the given module import specifier using format
 * "<pkg>[@<version>][/<path>]".
 */
export const parseNpmStyleSpecifier = (
  specifier: string,
): NpmFileLocation | undefined => {
  const match = specifier.match(/^((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?\/?(.*)$/);
  if (match === null) {
    return undefined;
  }
  const [, pkg, version, path] = match as [
    unknown,
    string,
    string | undefined,
    string,
  ];
  return {pkg, version: version ?? '', path};
};

/**
 * Return the file extension of the given URL path. Does not include the leading
 * ".".
 */
export const fileExtension = (path: string): string => {
  const lastSlashIdx = path.lastIndexOf('/');
  const lastDotIdx = path.lastIndexOf('.');
  return lastDotIdx === -1 || lastDotIdx < lastSlashIdx
    ? ''
    : path.slice(lastDotIdx + 1);
};

/**
 * Return whether the given string is an exact semver version, as opposed to a
 * range or tag.
 */
export const isExactSemverVersion = (s: string) =>
  s.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
  ) !== null;

export const pkgVersion = ({pkg, version}: {pkg: string; version: string}) =>
  `${pkg}@${version || 'latest'}`;

export const pkgVersionPath = ({pkg, version, path}: NpmFileLocation) =>
  trimTrailingSlash(`${pkgVersion({pkg, version})}/${trimLeadingSlash(path)}`);

export const trimLeadingSlash = (s: string) =>
  s.startsWith('/') ? s.slice(1) : s;

export const trimTrailingSlash = (s: string) =>
  s.endsWith('/') ? s.slice(0, -1) : s;
