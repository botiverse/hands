import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export type DeviceIdErrorCode = "DEVICE_ID_INVALID" | "DEVICE_ID_READ_FAILED" | "DEVICE_ID_PERSIST_FAILED";
export class DeviceIdError extends Error {
  constructor(readonly code: DeviceIdErrorCode, message: string) { super(message); this.name = "DeviceIdError"; }
}

export interface DeviceIdOptions { platform?: NodeJS.Platform; homeDir?: string; env?: NodeJS.ProcessEnv }
const exec = promisify(execFile);
const WINDOWS_KEY = "HKCU\\Software\\hands.build";

export function handsDeviceIdLocation(options: DeviceIdOptions = {}): string {
  const os = options.platform ?? platform();
  const home = options.homeDir ?? homedir();
  if (os === "win32") return `${WINDOWS_KEY}\\deviceid`;
  if (os === "darwin") return join(home, "Library", "Application Support", "hands.build", "deviceid");
  return join(options.env?.XDG_STATE_HOME ?? join(home, ".local", "state"), "hands.build", "deviceid");
}

async function readWindows(): Promise<string | undefined> {
  try {
    const { stdout } = await exec("reg.exe", ["query", WINDOWS_KEY, "/v", "deviceid"], { windowsHide: true });
    const value = stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu)?.[0]?.toLowerCase();
    if (!value || !UUID.test(value)) throw new DeviceIdError("DEVICE_ID_INVALID", "Hands device ID is malformed");
    return value;
  } catch (error) {
    if (error instanceof DeviceIdError) throw error;
    if ((error as NodeJS.ErrnoException).code === "1") return undefined;
    throw new DeviceIdError("DEVICE_ID_READ_FAILED", "Hands device ID could not be read");
  }
}

async function readValid(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (!UUID.test(value)) throw new DeviceIdError("DEVICE_ID_INVALID", "Hands device ID is malformed");
    return value;
  } catch (error) {
    if (error instanceof DeviceIdError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new DeviceIdError("DEVICE_ID_READ_FAILED", "Hands device ID could not be read");
  }
}

export async function getHandsDeviceId(options: DeviceIdOptions = {}): Promise<string> {
  const os = options.platform ?? platform();
  const path = handsDeviceIdLocation(options);
  const dir = os === "win32"
    ? join(options.env?.LOCALAPPDATA ?? join(options.homeDir ?? homedir(), "AppData", "Local"), "hands.build")
    : dirname(path);
  const lock = join(dir, "deviceid.lock");
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {
    throw new DeviceIdError("DEVICE_ID_PERSIST_FAILED", "Hands device ID directory could not be created");
  });
  if (os !== "win32") await chmod(dir, 0o700).catch(() => {
    throw new DeviceIdError("DEVICE_ID_PERSIST_FAILED", "Hands device ID directory permissions could not be set");
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const existing = os === "win32" ? await readWindows() : await readValid(path);
    if (existing) return existing;
    let acquired = false;
    try {
      await mkdir(lock);
      acquired = true;
      const afterLock = os === "win32" ? await readWindows() : await readValid(path);
      if (afterLock) return afterLock;
      const value = randomUUID().toLowerCase();
      if (os === "win32") {
        await exec("reg.exe", ["add", WINDOWS_KEY, "/v", "deviceid", "/t", "REG_SZ", "/d", value, "/f"], { windowsHide: true });
        return value;
      }
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      const handle = await open(temp, "wx", 0o600);
      await handle.writeFile(`${value}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await chmod(temp, 0o600);
      await rename(temp, path);
      const directory = await open(dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error instanceof DeviceIdError ? error : new DeviceIdError("DEVICE_ID_PERSIST_FAILED", "Hands device ID could not be persisted");
      }
    } finally { if (acquired) await rm(lock, { recursive: true, force: true }); }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new DeviceIdError("DEVICE_ID_PERSIST_FAILED", "Hands device ID creation remained contended");
}

export async function resetHandsDeviceId(options: DeviceIdOptions = {}): Promise<void> {
  if ((options.platform ?? platform()) === "win32") {
    try { await exec("reg.exe", ["delete", WINDOWS_KEY, "/v", "deviceid", "/f"], { windowsHide: true }); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "1") throw new DeviceIdError("DEVICE_ID_PERSIST_FAILED", "Hands device ID could not be reset"); return; }
  }
  try { await rm(handsDeviceIdLocation(options)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DeviceIdError("DEVICE_ID_PERSIST_FAILED", "Hands device ID could not be reset");
  }
}
