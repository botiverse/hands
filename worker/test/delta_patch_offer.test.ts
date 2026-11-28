// Which delta patch the update check offers when one version code shipped as
// several APKs (universal and per-ABI) and the build holds a patch from each.
import { describe, expect, it } from "vitest";
import { chooseDeltaPatch, parseInstalledSha256, type DeltaPatchCandidate } from "../src/routes/public_v2";

const ARM = "a".repeat(64);
const UNI = "b".repeat(64);
const GZIP = "archive-patcher-v1+gzip";
const XZ = "archive-patcher-v1+xz";

function row(key: string, size: number, source: { sha?: string; arch?: string | null } | null, extra: Partial<DeltaPatchCandidate> = {}): DeltaPatchCandidate {
  return {
    r2_key: key,
    size_bytes: size,
    arch: "arm64-v8a",
    algorithm: GZIP,
    target_sha256: "t",
    from_sha256: source?.sha ?? null,
    from_arch: source?.arch ?? null,
    from_arch_known: source && "arch" in source ? 1 : 0,
    ...extra,
  };
}

const pick = (rows: DeltaPatchCandidate[], installedSha256: string | null, arch: string | null = "arm64-v8a", algorithms = new Set([GZIP])) =>
  chooseDeltaPatch(rows, { arch, algorithms, installedSha256 })?.r2_key ?? null;

describe("parseInstalledSha256", () => {
  it("accepts 64 hex characters, lower-cased, and ignores anything else", () => {
    expect(parseInstalledSha256(ARM.toUpperCase())).toBe(ARM);
    expect(parseInstalledSha256(` ${UNI} `)).toBe(UNI);
    expect(parseInstalledSha256("a".repeat(63))).toBeNull();
    expect(parseInstalledSha256("g".repeat(64))).toBeNull();
    expect(parseInstalledSha256("")).toBeNull();
    expect(parseInstalledSha256(undefined)).toBeNull();
  });
});

describe("chooseDeltaPatch", () => {
  const rows = [
    row("arm", 300, { sha: ARM, arch: "arm64-v8a" }),
    row("uni", 200, { sha: UNI, arch: null }),
    row("legacy", 100, null),
  ];

  it("with the installed hash: that APK's patch, then legacy patches, never another APK's", () => {
    expect(pick(rows, UNI)).toBe("uni");
    expect(pick(rows, ARM)).toBe("arm");
    expect(pick(rows, "c".repeat(64))).toBe("legacy");
    expect(pick(rows.filter((r) => r.r2_key !== "legacy"), "c".repeat(64))).toBeNull();
    // The exact source's patch only in an algorithm the client lacks: legacy, not the other APK's.
    expect(pick([row("arm-xz", 50, { sha: ARM, arch: "arm64-v8a" }, { algorithm: XZ }), ...rows], ARM)).toBe("arm");
  });

  it("without a hash: a patch from an APK of the offered arch, then legacy, then other arches", () => {
    expect(pick(rows, null)).toBe("arm");
    // A universal APK is offered: the universal source is the likely installed one.
    const universalRows = rows.map((r) => ({ ...r, arch: null }));
    expect(pick(universalRows, null, null)).toBe("uni");
    // `universal` spelled out on either side is still universal.
    expect(pick(universalRows, null, "universal")).toBe("uni");
    expect(pick(rows.filter((r) => r.r2_key !== "arm"), null)).toBe("legacy");
    expect(pick(rows.filter((r) => r.r2_key === "uni"), null)).toBe("uni");
  });

  it("keeps the exact-arch-then-smallest order within one source rank", () => {
    const same = [
      row("universal-small", 100, { sha: ARM, arch: "arm64-v8a" }, { arch: null }),
      row("exact-big", 300, { sha: ARM, arch: "arm64-v8a" }),
      row("exact-small", 200, { sha: ARM, arch: "arm64-v8a" }, { algorithm: XZ }),
    ];
    expect(pick(same, ARM, "arm64-v8a", new Set([GZIP, XZ]))).toBe("exact-small");
    expect(pick(same, ARM, "arm64-v8a", new Set([GZIP]))).toBe("exact-big");
    // Legacy rows keep today's behaviour exactly.
    const legacy = [row("l-universal", 100, null, { arch: null }), row("l-exact", 300, null)];
    expect(pick(legacy, null)).toBe("l-exact");
  });
});
