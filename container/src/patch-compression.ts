/**
 * Compression of archive-patcher delta patches (/generate-patch).
 *
 * The raw patch is a bsdiff stream that is mostly zeros, so it is always sent
 * compressed. `gzip` (archive-patcher-v1+gzip) is what every SDK understands;
 * `xz` (archive-patcher-v1+xz) is about 30% smaller and is offered only to
 * SDKs that declare it.
 */

export type PatchCompression = "gzip" | "xz";

/** Body `compression` field; absent means gzip (the original behaviour). */
export function parsePatchCompression(value: unknown): PatchCompression | null {
  if (value === undefined || value === null) return "gzip";
  if (value === "gzip" || value === "xz") return value;
  return null;
}

/**
 * LZMA2 dictionary size. The decoder allocates about this much on the phone,
 * so it is capped: on three real ~37-40 MB raw APK patches, 32 and 64 MiB
 * saved under 0.1% over 16 MiB (and 8 MiB cost up to 0.3%). The SDK's
 * XZInputStream memory limit (DeltaUpdater.XZ_MEMORY_LIMIT_KIB) is sized from
 * this value; raising it here breaks xz patches on shipped SDKs.
 */
export const XZ_DICT_MIB = 16;

/**
 * `xz` CLI arguments that compress `rawPath` into `rawPath + ".xz"`.
 * Single-threaded so the output is one block and byte-for-byte deterministic;
 * preset 9e at a 16 MiB dictionary needs about 190 MiB to compress.
 */
export function xzArgs(rawPath: string): string[] {
  return [
    "--compress",
    "--keep",
    "--force",
    "--threads=1",
    "--format=xz",
    "--check=crc64",
    `--lzma2=preset=9e,dict=${XZ_DICT_MIB}MiB`,
    rawPath,
  ];
}
