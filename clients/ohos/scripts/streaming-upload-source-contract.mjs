import { readFileSync } from 'node:fs';

export function verifyStreamingUploadSource(source) {
  const failures = [];
  if (/new\s+ArrayBuffer\s*\(\s*stat\.size\s*\)/.test(source)) {
    failures.push('whole-file ArrayBuffer allocation is present');
  }
  if (/function\s+readFileBytes\s*\(/.test(source)) {
    failures.push('whole-file readFileBytes helper is present');
  }
  if (/request\.uploadFile\s*\(/.test(source)) {
    failures.push('multipart-only request.uploadFile must not be used for raw attachment bytes');
  }
  if (!/upload_mode:\s*['"]r2_multipart_proxy['"]/.test(source)) {
    failures.push('pure-ArkTS R2 multipart mode is missing');
  }
  if (!/fs\.read\s*\(\s*file\.fd\s*,\s*buffer/.test(source)) {
    failures.push('bounded file-part read is missing');
  }
  if (!/HANDS_OHOS_MULTIPART_PART_BYTES/.test(source)) {
    failures.push('bounded multipart part size is missing');
  }
  if (!/feedback\/multipart\/complete/.test(source)) {
    failures.push('multipart completion is missing');
  }
  if (!/feedback\/multipart\/abort/.test(source)) {
    failures.push('multipart abort cleanup is missing');
  }
  return failures;
}

export function verifyStreamingUploadSourceFile(path) {
  return verifyStreamingUploadSource(readFileSync(path, 'utf8'));
}
