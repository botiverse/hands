/**
 * Container server — APK + multi-format metadata parser.
 *
 * Endpoints:
 *   GET  /health       — liveness
 *   POST /parse        — body = raw binary bytes, optional X-Quiver-Filename
 *                        header; optional ?parser_kind=... or
 *                        X-Quiver-Parser-Kind header to force dispatch.
 *                        Auto-detects apk / aab / asar / RN bundle / ELF CLI
 *                        binary and returns { parser_kind, platform, arch,
 *                        version, version_code, package_id, app_label,
 *                        size_bytes, file_hash_sha256, raw }.
 *   POST /parse?parser_kind=... — same as above, but with the dispatch hint
 *                        baked into the URL.
 *
 * Backward compat: the old /parse endpoint returned a flat APK-only shape
 * (package_name, version_name, ...). New shape is namespaced under those
 * same keys when parser_kind === 'apk-aapt' so the v1 admin client still
 * works — the worker just spreads .raw back into the response.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { writeFile, unlink, mkdir, rm, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectParserKind,
  parseWithDispatcher,
  type ParserKind,
} from "./parsers/index.js";

const app = new Hono();

const execFileAsync = promisify(execFile);

const RETRACE_BIN = "/opt/android-sdk/cmdline-tools/latest/bin/retrace";

app.get("/health", (c) => c.json({ ok: true, service: "multi-parser" }));

/**
 * POST /retrace — body = { mapping, trace }. Deobfuscates an R8/ProGuard
 * stack trace against the given mapping using the Android SDK retrace tool.
 * Returns { retraced }.
 */
app.post("/retrace", async (c) => {
  let body: { mapping?: string; trace?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const mapping = typeof body.mapping === "string" ? body.mapping : "";
  const trace = typeof body.trace === "string" ? body.trace : "";
  if (!mapping.trim() || !trace.trim()) {
    return c.json({ error: "mapping and trace are required" }, 400);
  }
  if (mapping.length > 200 * 1024 * 1024) {
    return c.json({ error: "mapping too large" }, 413);
  }
  const dir = join(tmpdir(), `retrace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const mappingPath = join(dir, "mapping.txt");
  const tracePath = join(dir, "trace.txt");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(mappingPath, mapping);
    await writeFile(tracePath, trace);
    const { stdout } = await execFileAsync(
      RETRACE_BIN,
      [mappingPath, tracePath],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return c.json({ retraced: stdout });
  } catch (err) {
    return c.json(
      { error: `retrace failed: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  } finally {
    await Promise.allSettled([unlink(mappingPath), unlink(tracePath)]);
  }
});

/**
 * POST /symbolicate-native — body = raw native-symbols zip (unstripped .so
 * files), X-Quiver-Frames header = JSON array of
 * { index, offset, soname, build_id? } (offset hex like "0x1a2b" or bare
 * hex). Extracts the zip, matches each frame's soname (verifying the ELF
 * BuildId when provided), and resolves offsets with llvm-symbolizer.
 * Returns { frames: [{ index, resolved | error }] }.
 */
app.post("/symbolicate-native", async (c) => {
  const framesHeader = c.req.header("X-Quiver-Frames") ?? "[]";
  let frames: Array<{ index: number; offset: string; soname: string; build_id?: string }>;
  try {
    frames = JSON.parse(framesHeader);
    if (!Array.isArray(frames)) throw new Error("not an array");
  } catch {
    return c.json({ error: "X-Quiver-Frames must be a JSON array" }, 400);
  }
  if (frames.length === 0 || frames.length > 256) {
    return c.json({ error: "frames must contain 1-256 entries" }, 400);
  }
  const ab = await c.req.arrayBuffer();
  if (ab.byteLength === 0) return c.json({ error: "empty symbols zip" }, 400);
  if (ab.byteLength > 500 * 1024 * 1024) return c.json({ error: "symbols zip too large" }, 413);

  const dir = join(tmpdir(), `natsym-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const zipPath = join(dir, "symbols.zip");
  const outDir = join(dir, "symbols");
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(zipPath, Buffer.from(ab));
    await execFileAsync("unzip", ["-o", "-q", zipPath, "-d", outDir], {
      maxBuffer: 8 * 1024 * 1024,
    });

    // Index extracted .so files by basename (archives often nest abi dirs).
    const soByName = new Map<string, string>();
    const walk = async (d: string): Promise<void> => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".so") && !soByName.has(entry.name)) soByName.set(entry.name, full);
      }
    };
    await walk(outDir);

    const buildIdCache = new Map<string, string>();
    const elfBuildId = async (soPath: string): Promise<string> => {
      const cached = buildIdCache.get(soPath);
      if (cached !== undefined) return cached;
      let id = "";
      try {
        const { stdout } = await execFileAsync("readelf", ["-n", soPath], {
          maxBuffer: 4 * 1024 * 1024,
        });
        id = /Build ID:\s*([0-9a-f]+)/i.exec(stdout)?.[1]?.toLowerCase() ?? "";
      } catch {
        // leave empty — treated as unverifiable
      }
      buildIdCache.set(soPath, id);
      return id;
    };

    const results: Array<{ index: number; resolved?: string; error?: string }> = [];
    for (const frame of frames) {
      const soname = String(frame.soname ?? "").split("/").pop() ?? "";
      const soPath = soname ? soByName.get(soname) : undefined;
      if (!soPath) {
        results.push({ index: frame.index, error: `no ${soname || "(missing soname)"} in symbols archive` });
        continue;
      }
      if (frame.build_id) {
        const actual = await elfBuildId(soPath);
        if (actual && actual !== String(frame.build_id).toLowerCase()) {
          results.push({
            index: frame.index,
            error: `BuildId mismatch: crash ${frame.build_id}, archive ${actual}`,
          });
          continue;
        }
      }
      const offset = String(frame.offset ?? "").startsWith("0x")
        ? String(frame.offset)
        : `0x${frame.offset}`;
      try {
        const { stdout } = await execFileAsync(
          "llvm-symbolizer",
          ["--obj=" + soPath, "--output-style=GNU", "--demangle", "--functions=linkage", offset],
          { maxBuffer: 4 * 1024 * 1024 },
        );
        const lines = stdout.trim().split("\n").filter(Boolean);
        results.push({
          index: frame.index,
          resolved: lines.length > 0 ? `${lines[0]}${lines[1] ? ` (${lines[1]})` : ""}` : "??",
        });
      } catch (err) {
        results.push({
          index: frame.index,
          error: `symbolizer failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return c.json({ frames: results });
  } catch (err) {
    return c.json(
      { error: `symbolicate failed: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * POST /symbolicate-dsym — body = raw dSYM zip (one or more .dSYM bundles),
 * X-Quiver-Frames header = JSON array of { index, offset, image } where
 * `offset` is the address minus the image's runtime load address (hex) and
 * `image` is the binary/image name. Extracts the zip, indexes the DWARF
 * Mach-O binaries (`*.dSYM/Contents/Resources/DWARF/*`) by basename, and
 * resolves each frame with llvm-symbolizer at `IOS_TEXT_VMADDR + offset`.
 * Returns { frames: [{ index, resolved | error }] }.
 *
 * IOS_TEXT_VMADDR is the standard arm64 iOS PIE __TEXT base (0x100000000),
 * which is the link-time base every app main executable's offsets are
 * relative to. (Reading it per-binary is a robustness follow-up; system
 * frameworks usually ship no dSYM and fall back to name+offset anyway.)
 */
const IOS_TEXT_VMADDR = 0x100000000n;
app.post("/symbolicate-dsym", async (c) => {
  const framesHeader = c.req.header("X-Quiver-Frames") ?? "[]";
  let frames: Array<{ index: number; offset: string; image: string }>;
  try {
    frames = JSON.parse(framesHeader);
    if (!Array.isArray(frames)) throw new Error("not an array");
  } catch {
    return c.json({ error: "X-Quiver-Frames must be a JSON array" }, 400);
  }
  if (frames.length === 0 || frames.length > 256) {
    return c.json({ error: "frames must contain 1-256 entries" }, 400);
  }
  const ab = await c.req.arrayBuffer();
  if (ab.byteLength === 0) return c.json({ error: "empty dSYM zip" }, 400);
  if (ab.byteLength > 500 * 1024 * 1024) return c.json({ error: "dSYM zip too large" }, 413);

  const dir = join(tmpdir(), `dsym-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const zipPath = join(dir, "dsym.zip");
  const outDir = join(dir, "dsym");
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(zipPath, Buffer.from(ab));
    await execFileAsync("unzip", ["-o", "-q", zipPath, "-d", outDir], {
      maxBuffer: 8 * 1024 * 1024,
    });

    // Index DWARF Mach-O binaries (…/Contents/Resources/DWARF/<name>) by name.
    const dwarfByName = new Map<string, string>();
    const walk = async (d: string): Promise<void> => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (full.includes("/DWARF/") && !dwarfByName.has(entry.name)) {
          dwarfByName.set(entry.name, full);
        }
      }
    };
    await walk(outDir);

    const results: Array<{ index: number; resolved?: string; error?: string }> = [];
    for (const frame of frames) {
      const image = String(frame.image ?? "").split("/").pop() ?? "";
      const dwarfPath = image ? dwarfByName.get(image) : undefined;
      if (!dwarfPath) {
        results.push({ index: frame.index, error: `no dSYM for ${image || "(missing image)"}` });
        continue;
      }
      let offsetBig: bigint;
      try {
        const raw = String(frame.offset ?? "").trim();
        offsetBig = BigInt(raw.startsWith("0x") ? raw : `0x${raw}`);
      } catch {
        results.push({ index: frame.index, error: `bad offset: ${frame.offset}` });
        continue;
      }
      const staticAddr = "0x" + (IOS_TEXT_VMADDR + offsetBig).toString(16);
      try {
        const { stdout } = await execFileAsync(
          "llvm-symbolizer",
          ["--obj=" + dwarfPath, "--output-style=GNU", "--demangle", "--functions=linkage", staticAddr],
          { maxBuffer: 4 * 1024 * 1024 },
        );
        const lines = stdout.trim().split("\n").filter(Boolean);
        results.push({
          index: frame.index,
          resolved: lines.length > 0 ? `${lines[0]}${lines[1] ? ` (${lines[1]})` : ""}` : "??",
        });
      } catch (err) {
        results.push({
          index: frame.index,
          error: `symbolizer failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return c.json({ frames: results });
  } catch (err) {
    return c.json(
      { error: `symbolicate-dsym failed: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.post("/parse", async (c) => {
  const ab = await c.req.arrayBuffer();
  if (ab.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (ab.byteLength > 200 * 1024 * 1024) {
    return c.json({ error: "file too large (>200MB)" }, 413);
  }

  const bytes = new Uint8Array(ab);
  const explicit =
    (c.req.query("parser_kind") as ParserKind | null) ??
    (c.req.header("X-Quiver-Parser-Kind") as ParserKind | null);
  const filename =
    c.req.header("X-Quiver-Filename") ??
    c.req.query("filename") ??
    null;

  const kind = detectParserKind({
    explicit: explicit ?? null,
    filename,
    bytes,
  });

  // For APK we keep the historical behavior of writing to tmpfile so
  // aapt/apksigner can exec on it. Other parsers read bytes directly.
  let tmpDir: string | null = null;
  let tmpPath: string | null = null;
  if (kind === "apk-aapt") {
    tmpDir = join(
      tmpdir(),
      `quiver-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tmpDir, { recursive: true });
    tmpPath = join(tmpDir, "input.bin");
    await writeFile(tmpPath, bytes);
  }

  try {
    const metadata = await parseWithDispatcher({
      parserKind: kind,
      bytes,
      filename,
      filePath: tmpPath,
    });
    // Backward compat: when parser_kind === 'apk-aapt' also surface the
    // historical flat keys (package_name, version_name, ...) so the
    // existing admin UI client doesn't break.
    if (metadata.parser_kind === "apk-aapt") {
      return c.json({
        ...metadata,
        package_name: metadata.package_id,
        version_name: metadata.version,
        signature_sha256: (metadata.raw.signature_sha256 as string) ?? "",
        min_sdk: metadata.raw.min_sdk ?? null,
        target_sdk: metadata.raw.target_sdk ?? null,
      });
    }
    return c.json(metadata);
  } catch (err) {
    console.error("parse error:", err);
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  } finally {
    if (tmpPath) {
      await unlink(tmpPath).catch(() => {});
    }
  }
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`multi-parser listening on :${info.port}`);
});
