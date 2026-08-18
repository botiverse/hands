import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  EXPECTED_OHPM_AUTHOR,
  resolveReleaseMetadata,
  resolveReleaseVersion,
  validatePackageManifest,
} from './release-metadata.mjs';

const packageManifestPath = fileURLToPath(
  new URL('../hands/oh-package.json5', import.meta.url),
);

test('published HAR manifest carries the authorized OHPM author identity', () => {
  const metadata = resolveReleaseMetadata({
    manifestPath: packageManifestPath,
    eventName: 'pull_request',
    refType: 'branch',
    refName: 'codex/task215-ohpm-author-retry',
  });
  assert.equal(metadata.version, '0.3.4');
  assert.deepEqual(metadata.author, EXPECTED_OHPM_AUTHOR);
});

test('missing and malformed author fixtures fail before HAR publication', () => {
  const invalidAuthors = [
    undefined,
    '',
    'jiacheng',
    'jiacheng <not-an-email>',
    'other <jiacheng@botiverse.dev>',
    'jiacheng <other@botiverse.dev>',
  ];

  for (const author of invalidAuthors) {
    assert.throws(
      () => validatePackageManifest({ version: '0.3.4', author }),
      /OHPM author/,
      `fixture should be rejected: ${String(author)}`,
    );
  }
});

test('canonical and numbered recovery tags resolve to the same package version', () => {
  const context = {
    packageVersion: '0.3.4',
    eventName: 'push',
    refType: 'tag',
  };
  assert.equal(
    resolveReleaseVersion({ ...context, refName: 'ohos-sdk-v0.3.4' }),
    '0.3.4',
  );
  assert.equal(
    resolveReleaseVersion({ ...context, refName: 'ohos-sdk-v0.3.4-retry.1' }),
    '0.3.4',
  );
});

test('stale or malformed recovery tags fail closed', () => {
  const context = {
    packageVersion: '0.3.4',
    eventName: 'push',
    refType: 'tag',
  };
  for (const refName of [
    'ohos-sdk-v0.3.2',
    'ohos-sdk-v0.3.4-retry.0',
    'ohos-sdk-v0.3.4-retry.latest',
  ]) {
    assert.throws(
      () => resolveReleaseVersion({ ...context, refName }),
      /does not identify OHPM package version/,
    );
  }
});

test('manual release input must still match the package version', () => {
  assert.throws(
    () => resolveReleaseVersion({
      packageVersion: '0.3.4',
      eventName: 'workflow_dispatch',
      refType: 'branch',
      refName: 'main',
      inputVersion: '0.3.2',
    }),
    /does not match OHPM package version/,
  );
});
