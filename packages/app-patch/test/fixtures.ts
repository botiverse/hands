// A fake .app: a 16 MB binary with a small change, a changed asar, an
// unchanged, an empty, an added and a removed file, and a framework's symlinks.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PATCH_CHUNK } from "../src/index.js";

export const big = randomBytes(PATCH_CHUNK * 2 + 1000);
export const bigNext = Buffer.from(big);
bigNext.write("a small change", PATCH_CHUNK + 500);

export async function fakeApp(dir: string, version: string, next: boolean): Promise<string> {
  const root = path.join(dir, "My App.app");
  const put = async (rel: string, body: string | Buffer, mode = 0o644): Promise<void> => {
    const file = path.join(root, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    await chmod(file, mode);
  };
  await put("Contents/Info.plist", `<plist><key>CFBundleShortVersionString</key>\n<string>${version}</string></plist>`);
  await put("Contents/MacOS/My App", next ? bigNext : big, 0o755);
  await put("Contents/Resources/app.asar", `asar ${"frontend ".repeat(20_000)}${version}`);
  await put("Contents/Resources/unchanged.bin", "same");
  await put("Contents/Resources/empty", "");
  if (next) await put("Contents/Resources/新文件.txt", "added");
  else await put("Contents/Resources/removed.txt", "gone");
  await mkdir(path.join(root, "Contents/Frameworks/F.framework/Versions/A"), { recursive: true });
  await put("Contents/Frameworks/F.framework/Versions/A/F", "fw");
  await symlink("A", path.join(root, "Contents/Frameworks/F.framework/Versions/Current"));
  await symlink("Versions/Current/F", path.join(root, "Contents/Frameworks/F.framework/F"));
  return root;
}

