import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePatchCompression, xzArgs, XZ_DICT_MIB } from "./patch-compression.js";

test("parsePatchCompression defaults to gzip and rejects unknown values", () => {
  assert.equal(parsePatchCompression(undefined), "gzip");
  assert.equal(parsePatchCompression(null), "gzip");
  assert.equal(parsePatchCompression("gzip"), "gzip");
  assert.equal(parsePatchCompression("xz"), "xz");
  assert.equal(parsePatchCompression("zstd"), null);
  assert.equal(parsePatchCompression(""), null);
  assert.equal(parsePatchCompression(1), null);
});

test("xzArgs pins a single-threaded preset 9e stream with the capped dictionary", () => {
  const args = xzArgs("/tmp/out.patch");
  assert.equal(XZ_DICT_MIB, 16);
  assert.ok(args.includes("--threads=1"));
  assert.ok(args.includes("--lzma2=preset=9e,dict=16MiB"));
  assert.equal(args.at(-1), "/tmp/out.patch");
});

const hasXz = spawnSync("xz", ["--version"]).status === 0;

test("xz output is deterministic, round-trips, and records a 16 MiB dictionary", { skip: !hasXz && "xz CLI not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "patch-xz-"));
  try {
    // Mostly zeros with some structure, like a raw archive-patcher patch.
    const raw = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < raw.length; i += 4099) raw[i] = i & 0xff;
    const rawPath = join(dir, "out.patch");
    await writeFile(rawPath, raw);
    execFileSync("xz", xzArgs(rawPath));
    const first = await readFile(`${rawPath}.xz`);
    execFileSync("xz", xzArgs(rawPath));
    const second = await readFile(`${rawPath}.xz`);
    assert.deepEqual(first, second);
    assert.deepEqual(execFileSync("xz", ["--decompress", "--stdout", `${rawPath}.xz`], { maxBuffer: 8 * 1024 * 1024 }), raw);
    const listing = execFileSync("xz", ["--list", "--verbose", "--verbose", `${rawPath}.xz`]).toString();
    assert.match(listing, /dict=16MiB/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
