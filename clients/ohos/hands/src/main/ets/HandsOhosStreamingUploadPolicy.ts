/** Files up to this size upload through the bounded R2 multipart path. */
export const HANDS_OHOS_PRESIGN_MAX_BYTES: number = 200 * 1024 * 1024;

/** R2 requires every multipart part except the last to be at least 5 MiB. */
export const HANDS_OHOS_MULTIPART_PART_BYTES: number = 5 * 1024 * 1024;

/** A transient transport failure receives one fresh bounded-part attempt. */
export const HANDS_OHOS_MULTIPART_MAX_ATTEMPTS: number = 2;

export function handsOhosMultipartPartCount(totalBytes: number): number {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > HANDS_OHOS_PRESIGN_MAX_BYTES) {
    return 0;
  }
  return Math.ceil(totalBytes / HANDS_OHOS_MULTIPART_PART_BYTES);
}

export function handsOhosMultipartPartLength(totalBytes: number, zeroBasedPartIndex: number): number {
  const partCount = handsOhosMultipartPartCount(totalBytes);
  if (!Number.isSafeInteger(zeroBasedPartIndex) || zeroBasedPartIndex < 0 || zeroBasedPartIndex >= partCount) {
    return 0;
  }
  const start = zeroBasedPartIndex * HANDS_OHOS_MULTIPART_PART_BYTES;
  return Math.min(HANDS_OHOS_MULTIPART_PART_BYTES, totalBytes - start);
}
