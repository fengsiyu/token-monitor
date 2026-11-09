'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  referencedArtifactNames,
  verifyUpdaterArtifactNames
} = require('../../scripts/verify-updater-artifact-names');
const {
  mergeLinuxUpdaterMetadata,
  mergeLinuxUpdaterMetadataFiles,
  parseLinuxUpdaterMetadata
} = require('../../scripts/merge-linux-updater-metadata');

function linuxUpdaterMetadata(version, arch) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: Token-Monitor-${version}-${arch}.AppImage`,
    `    sha512: ${arch}-hash==`,
    `    size: ${arch === 'arm64' ? '200' : '100'}`,
    `    blockMapSize: ${arch === 'arm64' ? '20' : '10'}`,
    `path: Token-Monitor-${version}-${arch}.AppImage`,
    `sha512: ${arch}-hash==`,
    "releaseDate: '2026-11-09T00:00:00.000Z'",
    ''
  ].join('\n');
}

// Mirrors electron-updater Provider.findFile(): prefer the artifact whose
// name contains the running arch, falling back to the first entry.
function selectForArch(names, arch) {
  return names.find((name) => name.includes(arch)) ?? names[0];
}

test('merges x64 and arm64 linux feeds into one architecture-aware feed', () => {
  const version = '0.88.0';
  const merged = mergeLinuxUpdaterMetadata(
    linuxUpdaterMetadata(version, 'x64'),
    linuxUpdaterMetadata(version, 'arm64')
  );

  assert.deepEqual(referencedArtifactNames(merged), [
    `Token-Monitor-${version}-x64.AppImage`,
    `Token-Monitor-${version}-arm64.AppImage`
  ]);

  // x64 is the base, so the legacy top-level path/sha512 stay on the x64 file.
  assert.match(merged, new RegExp(`^path: Token-Monitor-${version}-x64\\.AppImage$`, 'm'));
  assert.match(merged, /^sha512: x64-hash==$/m);
  assert.equal((merged.match(/^path:/gm) || []).length, 1);

  // Both file blocks keep their full per-entry metadata.
  assert.match(merged, /Token-Monitor-0\.88\.0-x64\.AppImage[\s\S]*?size: 100[\s\S]*?blockMapSize: 10/);
  assert.match(merged, /Token-Monitor-0\.88\.0-arm64\.AppImage[\s\S]*?size: 200[\s\S]*?blockMapSize: 20/);
});

test('merged feed resolves the correct AppImage for each architecture', () => {
  const version = '0.88.0';
  const merged = mergeLinuxUpdaterMetadata(
    linuxUpdaterMetadata(version, 'x64'),
    linuxUpdaterMetadata(version, 'arm64')
  );
  const names = referencedArtifactNames(merged);

  assert.equal(selectForArch(names, 'x64'), `Token-Monitor-${version}-x64.AppImage`);
  assert.equal(selectForArch(names, 'arm64'), `Token-Monitor-${version}-arm64.AppImage`);
});

test('parse exposes the single-arch file entry and version', () => {
  const parsed = parseLinuxUpdaterMetadata(linuxUpdaterMetadata('0.88.0', 'arm64'), 'arm64');
  assert.equal(parsed.version, '0.88.0');
  assert.deepEqual(parsed.fileNames, ['Token-Monitor-0.88.0-arm64.AppImage']);
  assert.equal(parsed.pathName, 'Token-Monitor-0.88.0-arm64.AppImage');
});

test('rejects mismatched or mislabelled linux metadata', () => {
  assert.throws(
    () => mergeLinuxUpdaterMetadata(
      linuxUpdaterMetadata('0.88.0', 'x64'),
      linuxUpdaterMetadata('0.88.1', 'arm64')
    ),
    /versions differ/
  );
  // An x64-labelled feed that actually points at an arm64 artifact fails closed.
  assert.throws(
    () => mergeLinuxUpdaterMetadata(
      linuxUpdaterMetadata('0.88.0', 'arm64'),
      linuxUpdaterMetadata('0.88.0', 'arm64')
    ),
    /x64 metadata references Token-Monitor-0\.88\.0-arm64\.AppImage, expected only x64/
  );
});

test('rejects malformed file lists and stale top-level paths', () => {
  const version = '0.88.0';

  // Two AppImage entries in one single-arch feed.
  const twoEntries = [
    `version: ${version}`,
    'files:',
    `  - url: Token-Monitor-${version}-x64.AppImage`,
    '    sha512: a==',
    `  - url: Token-Monitor-${version}-other.AppImage`,
    '    sha512: b==',
    `path: Token-Monitor-${version}-x64.AppImage`,
    'sha512: a=='
  ].join('\n');
  assert.throws(
    () => mergeLinuxUpdaterMetadata(twoEntries, linuxUpdaterMetadata(version, 'arm64')),
    /x64 metadata must reference exactly one AppImage/
  );

  // path not present in the files list.
  const badPath = linuxUpdaterMetadata(version, 'x64').replace(
    `path: Token-Monitor-${version}-x64.AppImage`,
    `path: Other-Monitor-${version}-x64.AppImage`
  );
  assert.throws(
    () => mergeLinuxUpdaterMetadata(badPath, linuxUpdaterMetadata(version, 'arm64')),
    /is not present in its files list/
  );

  // Non-AppImage artifact.
  const deb = linuxUpdaterMetadata(version, 'x64').replaceAll('.AppImage', '.deb');
  assert.throws(
    () => mergeLinuxUpdaterMetadata(deb, linuxUpdaterMetadata(version, 'arm64')),
    /expected an AppImage/
  );
});

test('merged feed passes the updater artifact-name gate', (t) => {
  const version = '0.88.0';
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-linux-release-'));
  t.after(() => fs.rmSync(distDir, { recursive: true, force: true }));

  const merged = mergeLinuxUpdaterMetadata(
    linuxUpdaterMetadata(version, 'x64'),
    linuxUpdaterMetadata(version, 'arm64')
  );
  fs.writeFileSync(path.join(distDir, 'latest-linux.yml'), merged);
  for (const fileName of referencedArtifactNames(merged)) {
    fs.writeFileSync(path.join(distDir, fileName), 'artifact');
  }
  assert.deepEqual(verifyUpdaterArtifactNames(distDir), {
    metadataFiles: ['latest-linux.yml']
  });
});

test('mergeLinuxUpdaterMetadataFiles writes the merged feed to disk', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-linux-merge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const x64Path = path.join(dir, 'x64.yml');
  const arm64Path = path.join(dir, 'arm64.yml');
  const outputPath = path.join(dir, 'latest-linux.yml');
  fs.writeFileSync(x64Path, linuxUpdaterMetadata('0.88.0', 'x64'));
  fs.writeFileSync(arm64Path, linuxUpdaterMetadata('0.88.0', 'arm64'));

  assert.equal(mergeLinuxUpdaterMetadataFiles(outputPath, x64Path, arm64Path), outputPath);
  assert.ok(fs.existsSync(outputPath));
  assert.deepEqual(referencedArtifactNames(fs.readFileSync(outputPath, 'utf8')), [
    'Token-Monitor-0.88.0-x64.AppImage',
    'Token-Monitor-0.88.0-arm64.AppImage'
  ]);
});
