// @botiverse/hands-app-patch: the update patch format and its applier.
// The generator is in "@botiverse/hands-app-patch/make".
export {
  AppPatchError,
  LEGACY_PATCH_MAGIC,
  MAX_PATCH_FILE,
  PATCH_ALGORITHM,
  PATCH_CHUNK,
  PATCH_FORMAT,
  PATCH_MAGIC,
  PATCH_MAGICS,
  PATCH_WHOLE_DICT_MAX,
  PATCH_WINDOW_LOG,
  checkFileManifest,
  checkManifest,
  dictionaryRange,
  zstdDictionarySupported,
} from "./format.js";
export type {
  AppPatchReason,
  FilePatchManifest,
  PatchBlob,
  PatchBuild,
  PatchChunk,
  PatchEntry,
  PatchFileEntry,
  PatchManifest,
} from "./format.js";
export { buildFileFromPatch, buildZipFromPatch } from "./apply.js";
export type { BuildFileFromPatchOptions, BuildFromPatchOptions } from "./apply.js";
