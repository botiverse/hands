import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HANDS_OHOS_PRESIGN_MAX_BYTES,
  HANDS_OHOS_MULTIPART_MAX_ATTEMPTS,
  HANDS_OHOS_MULTIPART_PART_BYTES,
  handsOhosMultipartPartCount,
  handsOhosMultipartPartLength,
} from '../../hands/src/main/ets/HandsOhosStreamingUploadPolicy.ts';

test('OHOS bounded multipart ceiling matches Android and iOS at 200 MB', () => {
  assert.equal(HANDS_OHOS_PRESIGN_MAX_BYTES, 200 * 1024 * 1024);
  assert.equal(HANDS_OHOS_MULTIPART_PART_BYTES, 5 * 1024 * 1024);
  assert.equal(HANDS_OHOS_MULTIPART_MAX_ATTEMPTS, 2);
});

test('part count covers the exact byte range without a whole-file buffer', () => {
  assert.equal(handsOhosMultipartPartCount(1), 1);
  assert.equal(handsOhosMultipartPartCount(5 * 1024 * 1024), 1);
  assert.equal(handsOhosMultipartPartCount(5 * 1024 * 1024 + 1), 2);
  assert.equal(handsOhosMultipartPartCount(200 * 1024 * 1024), 40);
  assert.equal(handsOhosMultipartPartCount(0), 0);
  assert.equal(handsOhosMultipartPartCount(200 * 1024 * 1024 + 1), 0);
});

test('only the final part may be shorter than 5 MiB', () => {
  const fiveMiB = 5 * 1024 * 1024;
  assert.equal(handsOhosMultipartPartLength(fiveMiB + 1, 0), fiveMiB);
  assert.equal(handsOhosMultipartPartLength(fiveMiB + 1, 1), 1);
  assert.equal(handsOhosMultipartPartLength(fiveMiB + 1, 2), 0);
  assert.equal(handsOhosMultipartPartLength(1, 0), 1);
  assert.equal(handsOhosMultipartPartLength(0, 0), 0);
});
