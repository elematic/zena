import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {suite, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {
  extractBodyChecksums,
  extractChangelogBody,
  formatByteSize,
  parseGitHubReleases,
} from '../../website-client/src/release-data.ts';
import {sidebarFor} from '../lib/sidebar.js';
import nav from '../src/_data/nav.js';
import sidebar from '../src/_data/sidebar.js';

const execFileAsync = promisify(execFile);
const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const INSTALL_SH = join(SRC_DIR, 'public', 'install.sh');
const INSTALL_PS1 = join(SRC_DIR, 'public', 'install.ps1');

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

suite('releases page and release metadata parser', () => {
  test('exposes /releases/ in top navigation without a doc sidebar', async () => {
    const entry = nav.find((item) => item.link === '/releases/');
    assert.ok(entry, 'Expected /releases/ in nav.js');
    assert.equal(entry.text, 'Releases');
    assert.equal(entry.match, '/releases/');
    assert.equal(sidebarFor(sidebar, '/releases/'), null);

    const mdSource = await readFile(
      join(SRC_DIR, 'releases', 'index.md'),
      'utf8',
    );
    assert.match(mdSource, /^layout:\s*page\.njk$/m);
    assert.match(mdSource, /https:\/\/zena-lang\.dev\/install\.sh/);
    assert.match(mdSource, /https:\/\/zena-lang\.dev\/install\.ps1/);
    assert.match(mdSource, /SHA256SUMS/);
    assert.match(
      mdSource,
      /<zena-releases repo="elematic\/zena"><\/zena-releases>/,
    );

    const ps1Source = await readFile(INSTALL_PS1, 'utf8');
    assert.match(ps1Source, /SHA256SUMS/);
    assert.match(ps1Source, /x86_64-pc-windows-msvc/);
  });

  test('parses GitHub Releases assets, inline body checksums, and badges', () => {
    const macHash =
      '43159d46c6c1d25bcc48ba051203c3a55a63b6811f924fd2d1a278e727799c25';
    const linuxHash =
      'b9fa08c731b1f135895152838e913e4eef2d24859f058c7f47c33ad0427add76';
    const body = [
      '### Added',
      '',
      '- Standalone prebuilt CLI archive.',
      '',
      '<!-- zena-release-downloads -->',
      '',
      '---',
      '',
      '### Downloads',
      '',
      '| Platform | Archive | SHA-256 |',
      '| --- | --- | --- |',
      `| macOS (Apple Silicon) | [\`zena-v0.0.2-preview.1-aarch64-apple-darwin.tar.gz\`](https://example.test/mac.tar.gz) | \`${macHash}\` |`,
    ].join('\n');

    assert.equal(
      extractChangelogBody(body),
      '### Added\n\n- Standalone prebuilt CLI archive.',
    );
    assert.equal(
      extractBodyChecksums(body).get(
        'zena-v0.0.2-preview.1-aarch64-apple-darwin.tar.gz',
      ),
      macHash,
    );
    assert.equal(formatByteSize(18_874_368), '18.0 MB');

    const parsed = parseGitHubReleases([
      {
        tag_name: 'v0.0.3-draft',
        html_url: 'https://github.com/elematic/zena/releases/tag/v0.0.3-draft',
        draft: true,
      },
      {
        tag_name: 'v0.0.2-preview.1',
        name: 'Zena v0.0.2-preview.1',
        html_url:
          'https://github.com/elematic/zena/releases/tag/v0.0.2-preview.1',
        prerelease: true,
        published_at: '2026-11-13T12:00:00Z',
        body,
        assets: [
          {
            name: 'zena-v0.0.2-preview.1-aarch64-apple-darwin.tar.gz',
            browser_download_url: 'https://example.test/mac.tar.gz',
            size: 15_728_640,
            digest: null,
          },
          {
            name: 'zena-v0.0.2-preview.1-x86_64-unknown-linux-gnu.tar.gz',
            browser_download_url: 'https://example.test/linux.tar.gz',
            size: 16_777_216,
            digest: `sha256:${linuxHash.toUpperCase()}`,
          },
          {
            name: 'SHA256SUMS',
            browser_download_url: 'https://example.test/SHA256SUMS',
            size: 640,
          },
        ],
      },
      {
        tag_name: 'v0.0.1',
        name: 'Zena v0.0.1',
        html_url: 'https://github.com/elematic/zena/releases/tag/v0.0.1',
        prerelease: false,
        published_at: '2026-11-10T12:00:00Z',
        body: 'Initial stable release.',
        assets: [],
      },
    ]);

    assert.equal(parsed.length, 2);

    const preview = parsed[0];
    assert.equal(preview.tagName, 'v0.0.2-preview.1');
    assert.equal(preview.prerelease, true);
    assert.equal(preview.isNewest, true);
    assert.equal(preview.isLatestStable, false);
    assert.equal(preview.publishedLabel, 'November 13, 2026');
    assert.equal(preview.sha256SumsUrl, 'https://example.test/SHA256SUMS');
    assert.equal(preview.platforms.length, 2);
    assert.equal(preview.platforms[0].sha256, macHash);
    assert.equal(preview.platforms[1].sha256, linuxHash);

    const stable = parsed[1];
    assert.equal(stable.tagName, 'v0.0.1');
    assert.equal(stable.isLatestStable, true);
    assert.equal(stable.isNewest, false);
  });
});

suite('install.sh standalone installer', () => {
  test('falls back to preview releases, verifies SHA256SUMS, and rejects tampered archives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zena-install-test-'));
    let server;

    try {
      const stageDir = join(dir, 'stage');
      await mkdir(stageDir, {recursive: true});
      const fakeBin = join(stageDir, 'zena');
      await writeFile(fakeBin, '#!/bin/sh\necho "zena 0.0.1-preview.1"\n');
      await chmod(fakeBin, 0o755);

      const tag = 'v0.0.1-preview.1';
      const target = 'x86_64-unknown-linux-gnu';
      const archiveName = `zena-${tag}-${target}.tar.gz`;
      const archivePath = join(dir, archiveName);
      await execFileAsync('tar', ['-C', stageDir, '-czf', archivePath, 'zena']);
      const archiveBytes = await readFile(archivePath);
      const validHash = sha256Hex(archiveBytes);

      let tamperChecksum = false;

      server = createServer((req, res) => {
        if (req.url === '/api/releases/latest') {
          // Simulate GitHub returning 404 when only pre-releases exist.
          res.writeHead(404, {'content-type': 'application/json'});
          res.end(JSON.stringify({message: 'Not Found'}));
          return;
        }
        if (req.url === '/api/releases?per_page=1') {
          res.writeHead(200, {'content-type': 'application/json'});
          res.end(JSON.stringify([{id: 1, tag_name: tag, prerelease: true}]));
          return;
        }
        if (req.url === `/download/${tag}/${archiveName}`) {
          res.writeHead(200, {'content-type': 'application/gzip'});
          res.end(archiveBytes);
          return;
        }
        if (req.url === `/download/${tag}/SHA256SUMS`) {
          const hash = tamperChecksum ? '0'.repeat(64) : validHash;
          res.writeHead(200, {'content-type': 'text/plain'});
          res.end(`${hash}  ${archiveName}\n`);
          return;
        }
        res.writeHead(404);
        res.end('not found');
      });

      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const {port} = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      const homeDir = join(dir, 'home');
      const installDir = join(homeDir, '.zena');
      await mkdir(homeDir, {recursive: true});

      const baseEnv = {
        ...process.env,
        HOME: homeDir,
        SHELL: '/bin/zsh',
        ZENA_OS: 'Linux',
        ZENA_ARCH: 'x86_64',
        ZENA_INSTALL: installDir,
        ZENA_GITHUB_API_URL: `${baseUrl}/api`,
        ZENA_RELEASE_BASE_URL: `${baseUrl}/download`,
      };

      await execFileAsync('sh', [INSTALL_SH], {env: baseEnv});

      const installedBin = join(installDir, 'bin', 'zena');
      const binStat = await stat(installedBin);
      assert.ok(
        (binStat.mode & 0o111) !== 0,
        'Expected installed zena binary to be executable',
      );

      const {stdout} = await execFileAsync(installedBin, ['--version']);
      assert.equal(stdout.trim(), 'zena 0.0.1-preview.1');

      const zshrc = await readFile(join(homeDir, '.zshrc'), 'utf8');
      assert.match(zshrc, /export PATH="\$HOME\/\.zena\/bin:\$PATH"/);

      // Tamper with SHA256SUMS and confirm installation fails without writing binary.
      tamperChecksum = true;
      const badInstallDir = join(dir, 'bad-install');
      await assert.rejects(
        execFileAsync('sh', [INSTALL_SH, '--no-modify-path'], {
          env: {...baseEnv, ZENA_INSTALL: badInstallDir},
        }),
        /SHA-256 checksum mismatch/,
      );
      await assert.rejects(stat(join(badInstallDir, 'bin', 'zena')));
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await rm(dir, {recursive: true, force: true});
    }
  });
});
