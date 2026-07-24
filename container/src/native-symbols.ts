export interface NativeSymbolCandidate {
  path: string;
  buildId: string;
}

export type NativeSymbolSelection =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Select one same-soname symbols file by exact ELF BuildId.
 *
 * Archives commonly contain one `libfoo.so` per ABI. Traversal order is not
 * identity, so missing/unreadable/mismatched BuildIds always fail closed.
 */
export function selectNativeSymbolCandidate(
  candidates: NativeSymbolCandidate[],
  crashBuildIdInput: unknown,
  soname: string,
): NativeSymbolSelection {
  const crashBuildId = String(crashBuildIdInput ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(crashBuildId)) {
    return { ok: false, error: "missing crash BuildId (fail-closed)" };
  }
  const exact = candidates.find((candidate) => candidate.buildId === crashBuildId);
  if (exact) return { ok: true, path: exact.path };

  const readableIds = [...new Set(candidates.map((candidate) => candidate.buildId).filter(Boolean))];
  return {
    ok: false,
    error: readableIds.length > 0
      ? `BuildId mismatch: crash ${crashBuildId}, archive ${readableIds.join(",")}`
      : `BuildId unverifiable for ${soname} (fail-closed)`,
  };
}
