import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EXPECTED_OHPM_AUTHOR = Object.freeze({
  name: 'jiacheng',
  email: 'jiacheng@botiverse.dev',
});

const EMAIL_PATTERN = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function validateOhpmAuthor(author) {
  if (typeof author !== 'string') {
    throw new Error('OHPM author must be a string in "name <email>" form.');
  }

  const match = author.match(/^\s*([^<>]+?)\s*<\s*([^<>\s]+)\s*>\s*$/);
  if (!match) {
    throw new Error('OHPM author must include both name and email in "name <email>" form.');
  }

  const name = match[1].trim();
  const email = match[2].trim();
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error(`OHPM author email is invalid: ${email}`);
  }
  if (name !== EXPECTED_OHPM_AUTHOR.name || email !== EXPECTED_OHPM_AUTHOR.email) {
    throw new Error(
      `OHPM author must be ${EXPECTED_OHPM_AUTHOR.name} <${EXPECTED_OHPM_AUTHOR.email}>.`,
    );
  }

  return { name, email };
}

export function validatePackageManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('OHPM package manifest must be an object.');
  }

  const version = manifest.version;
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`OHPM package version is missing or invalid: ${String(version)}`);
  }

  const author = validateOhpmAuthor(manifest.author);
  return { version, author };
}

export function resolveReleaseVersion({
  packageVersion,
  eventName,
  refType,
  refName,
  inputVersion = '',
}) {
  let requestedVersion = packageVersion;
  if (refType === 'tag') {
    const canonicalTag = `ohos-sdk-v${packageVersion}`;
    const escapedCanonicalTag = canonicalTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const retryTag = new RegExp(`^${escapedCanonicalTag}-retry\\.[1-9]\\d*$`);
    if (refName !== canonicalTag && !retryTag.test(refName)) {
      throw new Error(
        `Tag ${refName} does not identify OHPM package version ${packageVersion}.`,
      );
    }
  } else if (eventName === 'workflow_dispatch') {
    requestedVersion = inputVersion;
  }

  if (requestedVersion !== packageVersion) {
    throw new Error(
      `Requested version ${requestedVersion} does not match OHPM package version ${packageVersion}.`,
    );
  }
  return packageVersion;
}

export function resolveReleaseMetadata({ manifestPath, ...releaseContext }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { version, author } = validatePackageManifest(manifest);
  return {
    version: resolveReleaseVersion({ packageVersion: version, ...releaseContext }),
    author,
  };
}

function main(argv) {
  const [manifestPath, eventName, refType, refName, inputVersion = ''] = argv;
  if (!manifestPath || !eventName || !refType || !refName) {
    throw new Error(
      'Usage: release-metadata.mjs <manifest> <event> <ref-type> <ref-name> [input-version]',
    );
  }
  const metadata = resolveReleaseMetadata({
    manifestPath,
    eventName,
    refType,
    refName,
    inputVersion,
  });
  process.stdout.write(metadata.version);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
