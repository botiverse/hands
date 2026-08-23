import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  crashLogFileName,
  crashLogsBeyondRetention,
  ensureCrashDirectory,
  HANDS_OHOS_SDK_VERSION,
  runIsolatedCrashCapture,
  uploadCrashThenDelete,
} from '../../hands/src/main/ets/HandsCrashStoragePolicy.ts';

test('pre-existing crash directory is accepted without another mkdir', () => {
  let createCalls = 0;
  ensureCrashDirectory(
    () => true,
    () => {
      createCalls += 1;
    },
    () => false,
  );
  assert.equal(createCalls, 0);
});

test('EEXIST race is accepted only when the resulting path is a directory', () => {
  const existsError = { code: 13900015 };
  let directoryChecks = 0;
  ensureCrashDirectory(
    () => {
      directoryChecks += 1;
      return directoryChecks > 1;
    },
    () => {
      throw existsError;
    },
    (error) => (error as { code?: number }).code === 13900015,
  );
  assert.equal(directoryChecks, 2);

  assert.throws(
    () => ensureCrashDirectory(
      () => false,
      () => {
        throw existsError;
      },
      (error) => (error as { code?: number }).code === 13900015,
    ),
    (error) => error === existsError,
  );
});

test('non-EEXIST directory failures remain fail-closed', () => {
  const permissionError = { code: 13900012 };
  assert.throws(
    () => ensureCrashDirectory(
      () => false,
      () => {
        throw permissionError;
      },
      (error) => (error as { code?: number }).code === 13900015,
    ),
    (error) => error === permissionError,
  );
});

test('same-millisecond crashes receive different stable filenames', () => {
  const at = Date.parse('2026-07-30T00:19:23.123Z');
  const first = crashLogFileName(at, 'id-one', 'fault');
  const second = crashLogFileName(at, 'id-two', 'fault');
  assert.notEqual(first, second);
  assert.match(first, /^crash-2026-07-30T00-19-23-123Z-id-one-fault\.txt$/);
  assert.match(second, /^crash-2026-07-30T00-19-23-123Z-id-two-fault\.txt$/);
});

test('one failed fault event does not abort later events in the batch', () => {
  const attempted: number[] = [];
  const failures: number[] = [];
  const results = [1, 2, 3].map((value) => runIsolatedCrashCapture(
    () => {
      attempted.push(value);
      if (value === 2) {
        throw new Error('bad fault event');
      }
    },
    () => failures.push(value),
  ));

  assert.deepEqual(attempted, [1, 2, 3]);
  assert.deepEqual(failures, [2]);
  assert.deepEqual(results, [true, false, true]);
});

test('retention keeps the newest five logs instead of only four', () => {
  const logs = [
    'crash-2026-07-30T00-00-00-000Z-a.txt',
    'crash-2026-07-30T00-00-01-000Z-b.txt',
    'crash-2026-07-30T00-00-02-000Z-c.txt',
    'crash-2026-07-30T00-00-03-000Z-d.txt',
    'crash-2026-07-30T00-00-04-000Z-e.txt',
    'crash-2026-07-30T00-00-05-000Z-f.txt',
  ];
  assert.deepEqual(crashLogsBeyondRetention(logs, 5), [logs[0]]);
  assert.deepEqual(crashLogsBeyondRetention(logs.slice(1), 5), []);
});

test('pending crash is deleted only after ticket creation succeeds', async () => {
  const successOrder: string[] = [];
  const ticketId = await uploadCrashThenDelete(
    async () => {
      successOrder.push('upload');
      return 'ticket-123';
    },
    () => successOrder.push('delete'),
  );
  assert.equal(ticketId, 'ticket-123');
  assert.deepEqual(successOrder, ['upload', 'delete']);

  let deletedAfterFailure = false;
  await assert.rejects(
    uploadCrashThenDelete(
      async () => {
        throw new Error('offline');
      },
      () => {
        deletedAfterFailure = true;
      },
    ),
    /offline/,
  );
  assert.equal(deletedAfterFailure, false);
});

test('runtime Hands metadata version matches the OHPM package version', async () => {
  const packageText = await readFile(new URL('../../hands/oh-package.json5', import.meta.url), 'utf8');
  const packageJson = JSON.parse(packageText) as { version: string };
  assert.equal(HANDS_OHOS_SDK_VERSION, packageJson.version);
});
