import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { verifyStreamingUploadSource } from './streaming-upload-source-contract.mjs';

const clientPath = fileURLToPath(new URL('../hands/src/main/ets/HandsFeedbackClient.ets', import.meta.url));
const source = readFileSync(clientPath, 'utf8');

test('production OHOS large upload uses bounded pure-ArkTS multipart parts', () => {
  assert.deepEqual(verifyStreamingUploadSource(source), []);
});

test('source contract fails causally for each bounded-streaming invariant', () => {
  const mutations = [
    source.replace("upload_mode: 'r2_multipart_proxy'", "upload_mode: 'missing'"),
    source.replace('fs.read(file.fd, buffer', 'fs.missingRead(file.fd, buffer'),
    source.replaceAll('HANDS_OHOS_MULTIPART_PART_BYTES', 'MISSING_PART_BOUND'),
    source.replace('feedback/multipart/complete', 'feedback/multipart/missing-complete'),
    source.replace('feedback/multipart/abort', 'feedback/multipart/missing-abort'),
    `${source}\nrequest.uploadFile(context, {});\n`,
    `${source}\nfunction readFileBytes(path: string): ArrayBuffer { return new ArrayBuffer(stat.size); }\n`,
  ];
  for (const mutated of mutations) {
    assert.notDeepEqual(verifyStreamingUploadSource(mutated), []);
  }
});
