'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { artifactNameFromReference } = require('./verify-updater-artifact-names');

// electron-builder's getArtifactArchName writes AppImage names with the Linux
// toolchain arch token, not the internal Arch enum: x64 becomes x86_64 while
// arm64 stays arm64. Map the logical arch to the marker that actually appears
// in the artifact name so the assertions match the real files.
const APP_IMAGE_ARCH_MARKERS = {
  x64: 'x86_64',
  arm64: 'arm64'
};

// The Linux AppImage feed is built on two separate runners (one x64, one
// arm64), so each produces a single-arch latest-linux.yml. This mirrors
// merge-mac-updater-metadata.js: parse both feeds, prove each references only
// its own architecture, and splice the two file entries into one
// architecture-aware feed that electron-updater's findFile() selects from by
// matching process.arch against the artifact name.

function stripYamlQuotes(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseLinuxUpdaterMetadata(contents, label = 'metadata') {
  const lines = String(contents || '').replace(/\r\n/g, '\n').split('\n');
  const versionLine = lines.find((line) => /^version:\s*\S/.test(line));
  if (!versionLine) throw new Error(`${label} has no top-level version`);

  const filesIndex = lines.findIndex((line) => /^files:\s*$/.test(line));
  if (filesIndex < 0) throw new Error(`${label} has no top-level files list`);

  let filesEnd = filesIndex + 1;
  while (filesEnd < lines.length && (lines[filesEnd] === '' || /^\s/.test(lines[filesEnd]))) {
    filesEnd += 1;
  }
  const fileLines = lines.slice(filesIndex + 1, filesEnd);
  while (fileLines.length > 0 && fileLines[0] === '') fileLines.shift();
  while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();

  const fileNames = fileLines
    .filter((line) => /^\s*-\s*url:\s*\S/.test(line))
    .map((line) => artifactNameFromReference(line.replace(/^\s*-\s*url:\s*/, '')));
  if (fileNames.length === 0) throw new Error(`${label} has no updater file entries`);
  if (new Set(fileNames).size !== fileNames.length) {
    throw new Error(`${label} contains duplicate updater file entries`);
  }

  const pathLines = lines.filter((line) => /^path:\s*\S/.test(line));
  if (pathLines.length !== 1) {
    throw new Error(`${label} must have exactly one top-level path`);
  }
  const pathName = artifactNameFromReference(pathLines[0].replace(/^path:\s*/, ''));

  return {
    label,
    lines,
    version: stripYamlQuotes(versionLine.replace(/^version:\s*/, '')),
    filesIndex,
    filesEnd,
    fileLines,
    fileNames,
    pathName
  };
}

function assertLinuxArchitecture(metadata, arch) {
  // Each runner ships exactly one AppImage, and its name carries the arch.
  const archMarker = APP_IMAGE_ARCH_MARKERS[arch];
  if (archMarker === undefined) {
    throw new Error(`${metadata.label} uses unsupported architecture ${arch}`);
  }
  if (metadata.fileNames.length !== 1) {
    throw new Error(`${metadata.label} must reference exactly one AppImage, got ${metadata.fileNames.length}`);
  }
  const expected = `-${archMarker}.`;
  const [fileName] = metadata.fileNames;
  if (!fileName.endsWith('.AppImage')) {
    throw new Error(`${metadata.label} references ${fileName}, expected an AppImage`);
  }
  if (!fileName.includes(expected)) {
    throw new Error(`${metadata.label} references ${fileName}, expected only ${arch} artifacts`);
  }
  if (!metadata.pathName.endsWith('.AppImage')) {
    throw new Error(`${metadata.label} path ${metadata.pathName} is not an AppImage`);
  }
  if (!metadata.pathName.includes(expected)) {
    throw new Error(`${metadata.label} path ${metadata.pathName} does not reference an ${arch} artifact`);
  }
  if (!metadata.fileNames.includes(metadata.pathName)) {
    throw new Error(`${metadata.label} path ${metadata.pathName} is not present in its files list`);
  }
}

function mergeLinuxUpdaterMetadata(x64Contents, arm64Contents) {
  const x64 = parseLinuxUpdaterMetadata(x64Contents, 'x64 metadata');
  const arm64 = parseLinuxUpdaterMetadata(arm64Contents, 'arm64 metadata');
  assertLinuxArchitecture(x64, 'x64');
  assertLinuxArchitecture(arm64, 'arm64');
  if (x64.version !== arm64.version) {
    throw new Error(`linux updater versions differ: x64=${x64.version}, arm64=${arm64.version}`);
  }

  const allNames = [...x64.fileNames, ...arm64.fileNames];
  if (new Set(allNames).size !== allNames.length) {
    throw new Error('linux updater metadata contains duplicate artifact names across architectures');
  }

  // Keep x64 as the base: every Linux install before this change is x64, so
  // the top-level path/sha512 (the legacy fallback fields) stay valid for
  // existing users. New arm64 installs resolve through the files list.
  const mergedLines = [
    ...x64.lines.slice(0, x64.filesIndex + 1),
    ...x64.fileLines,
    ...arm64.fileLines,
    ...x64.lines.slice(x64.filesEnd)
  ];
  return mergedLines.join('\n').replace(/\n*$/, '\n');
}

function mergeLinuxUpdaterMetadataFiles(outputPath, x64Path, arm64Path) {
  const merged = mergeLinuxUpdaterMetadata(
    fs.readFileSync(x64Path, 'utf8'),
    fs.readFileSync(arm64Path, 'utf8')
  );
  fs.writeFileSync(outputPath, merged);
  return outputPath;
}

if (require.main === module) {
  const [outputArg, x64Arg, arm64Arg] = process.argv.slice(2);
  if (!outputArg || !x64Arg || !arm64Arg) {
    console.error('Usage: node scripts/merge-linux-updater-metadata.js <output> <x64-yml> <arm64-yml>');
    process.exitCode = 1;
  } else {
    try {
      const outputPath = path.resolve(outputArg);
      mergeLinuxUpdaterMetadataFiles(outputPath, path.resolve(x64Arg), path.resolve(arm64Arg));
      console.log(`Merged linux updater metadata into ${outputPath}`);
    } catch (error) {
      console.error(error.message || String(error));
      process.exitCode = 1;
    }
  }
}

module.exports = {
  mergeLinuxUpdaterMetadata,
  mergeLinuxUpdaterMetadataFiles,
  parseLinuxUpdaterMetadata
};
