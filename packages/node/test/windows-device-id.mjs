import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getHandsDeviceId, handsDeviceIdLocation } from "../dist/index.js";

if (process.platform !== "win32") throw new Error("Windows device ID test requires Windows");
const exec = promisify(execFile);
const key = "HKCU\\Software\\hands.build";
const localAppData = await mkdtemp(join(tmpdir(), "hands-device-win-"));
const clean = () => { try { execFileSync("reg.exe", ["delete", key, "/f"], { stdio: "ignore" }); } catch {} };
try {
  clean();
  assert.equal(handsDeviceIdLocation(), `${key}\\deviceid`, "unexpected Windows namespace");
  const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
  const script = `import {getHandsDeviceId} from ${JSON.stringify(moduleUrl)};process.stdout.write(await getHandsDeviceId());`;
  const env = { ...process.env, LOCALAPPDATA: localAppData };
  const results = await Promise.all(Array.from({ length: 8 }, () => exec(process.execPath, ["--input-type=module", "--eval", script], { env, windowsHide: true })));
  assert.equal(new Set(results.map(({ stdout }) => stdout)).size, 1, "concurrent processes returned different IDs");
  assert.equal(await getHandsDeviceId({ env }), results[0].stdout, "reopen did not reuse committed ID");
  execFileSync("reg.exe", ["add", key, "/v", "deviceid", "/t", "REG_SZ", "/d", "malformed", "/f"], { stdio: "ignore" });
  await assert.rejects(getHandsDeviceId({ env }), (error) => error?.code === "DEVICE_ID_INVALID");
} finally { clean(); await rm(localAppData, { recursive: true, force: true }); }
