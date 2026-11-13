/**
 * Parsing and normalization for GitHub Releases API responses displayed on
 * `/releases/`.
 */

export interface GitHubReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
  readonly digest?: string | null;
}

export interface GitHubReleaseRaw {
  readonly tag_name: string;
  readonly name?: string | null;
  readonly html_url: string;
  readonly body?: string | null;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  readonly published_at?: string | null;
  readonly created_at?: string | null;
  readonly assets?: readonly GitHubReleaseAsset[];
}

export interface PlatformDownload {
  readonly target: string;
  readonly label: string;
  readonly archiveName: string;
  readonly archiveUrl: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly sha256FileUrl: string | null;
  readonly unversionedUrl: string | null;
}

export interface ParsedRelease {
  readonly tagName: string;
  readonly title: string;
  readonly htmlUrl: string;
  readonly publishedIso: string | null;
  readonly publishedLabel: string | null;
  readonly prerelease: boolean;
  readonly isLatestStable: boolean;
  readonly isNewest: boolean;
  readonly changelog: string;
  readonly sha256SumsUrl: string | null;
  readonly platforms: readonly PlatformDownload[];
}

export const PLATFORM_TARGETS = [
  {
    target: 'aarch64-apple-darwin',
    ext: 'tar.gz',
    label: 'macOS (Apple Silicon)',
  },
  {
    target: 'x86_64-unknown-linux-gnu',
    ext: 'tar.gz',
    label: 'Linux (x86_64)',
  },
  {
    target: 'aarch64-unknown-linux-gnu',
    ext: 'tar.gz',
    label: 'Linux (ARM64)',
  },
  {
    target: 'x86_64-pc-windows-msvc',
    ext: 'zip',
    label: 'Windows (x86_64)',
  },
] as const;

const DOWNLOADS_MARKER = '<!-- zena-release-downloads -->';
const SHA256_HEX = /^[0-9a-f]{64}$/i;

const normalizeSha256 = (digest: string | null | undefined): string | null => {
  if (!digest) return null;
  const stripped = digest.startsWith('sha256:') ? digest.slice(7) : digest;
  return SHA256_HEX.test(stripped) ? stripped.toLowerCase() : null;
};

/**
 * Extracts `archiveName -> sha256` pairs from Markdown table rows appended by
 * `.github/workflows/release.yml`.
 */
export const extractBodyChecksums = (body: string): Map<string, string> => {
  const checksums = new Map<string, string>();
  const rowPattern =
    /\|\s*\[`([^`]+)`\]\([^)]+\)\s*\|\s*`([0-9a-fA-F]{64})`\s*\|/g;
  for (const match of body.matchAll(rowPattern)) {
    checksums.set(match[1], match[2].toLowerCase());
  }
  return checksums;
};

/**
 * Strips the auto-appended install/download footer from a release's Markdown
 * body so `<zena-releases>` renders the human changelog once alongside its
 * structured downloads table.
 */
export const extractChangelogBody = (body: string): string => {
  const markerIndex = body.indexOf(DOWNLOADS_MARKER);
  const sliced = markerIndex >= 0 ? body.slice(0, markerIndex) : body;
  return sliced.trim();
};

const formatReleaseDate = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
};

export const formatByteSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const parseGitHubReleases = (
  rawReleases: readonly GitHubReleaseRaw[],
): ParsedRelease[] => {
  const published = rawReleases.filter((rel) => !rel.draft && rel.tag_name);
  let seenLatestStable = false;

  return published.map((rel, index) => {
    const tagName = rel.tag_name;
    const prerelease = Boolean(rel.prerelease);
    const isLatestStable = !prerelease && !seenLatestStable;
    if (isLatestStable) {
      seenLatestStable = true;
    }

    const rawBody = rel.body ?? '';
    const bodyChecksums = extractBodyChecksums(rawBody);
    const changelog = extractChangelogBody(rawBody);
    const assets = rel.assets ?? [];
    const byName = new Map<string, GitHubReleaseAsset>();
    for (const asset of assets) {
      byName.set(asset.name, asset);
    }

    const platforms: PlatformDownload[] = [];
    for (const spec of PLATFORM_TARGETS) {
      const archiveName = `zena-${tagName}-${spec.target}.${spec.ext}`;
      const unversionedName = `zena-${spec.target}.${spec.ext}`;
      const archiveAsset = byName.get(archiveName);
      if (!archiveAsset) continue;

      const sha256Asset = byName.get(`${archiveName}.sha256`);
      const unversionedAsset = byName.get(unversionedName);
      const sha256 =
        normalizeSha256(archiveAsset.digest) ??
        bodyChecksums.get(archiveName) ??
        null;

      platforms.push({
        target: spec.target,
        label: spec.label,
        archiveName,
        archiveUrl: archiveAsset.browser_download_url,
        sizeBytes: archiveAsset.size,
        sha256,
        sha256FileUrl: sha256Asset?.browser_download_url ?? null,
        unversionedUrl: unversionedAsset?.browser_download_url ?? null,
      });
    }

    const sha256SumsUrl =
      byName.get('SHA256SUMS')?.browser_download_url ?? null;
    const publishedIso = rel.published_at ?? rel.created_at ?? null;

    return {
      tagName,
      title: rel.name?.trim() || `Zena ${tagName}`,
      htmlUrl: rel.html_url,
      publishedIso,
      publishedLabel: formatReleaseDate(publishedIso),
      prerelease,
      isLatestStable,
      isNewest: index === 0,
      changelog,
      sha256SumsUrl,
      platforms,
    };
  });
};
