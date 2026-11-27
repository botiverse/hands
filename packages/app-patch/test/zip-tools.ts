// Zip helpers for the tests: Python's zipfile (checks every crc; modes and
// symlinks come from the central directory), and an `unzip` stand-in on PATH
// when the machine has none (CI runners do; the release pipeline needs it).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const UNZIP_PY = `
import os, stat, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
for i in z.infolist():
    mode = i.external_attr >> 16
    dst = os.path.join(sys.argv[2], i.filename)
    os.makedirs(os.path.dirname(dst.rstrip("/")) or ".", exist_ok=True)
    if stat.S_ISLNK(mode): os.symlink(z.read(i).decode(), dst)
    elif stat.S_ISDIR(mode) or i.filename.endswith("/"): os.makedirs(dst, exist_ok=True); os.chmod(dst, stat.S_IMODE(mode) or 0o755)
    else:
        with open(dst, "wb") as f: f.write(z.read(i))
        os.chmod(dst, stat.S_IMODE(mode) or 0o644)
`;

const ZIP_PY = `
import os, stat, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    base = os.path.dirname(src)
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(dirs) + sorted(files):
            p = os.path.join(root, name)
            rel = os.path.relpath(p, base)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                i = zipfile.ZipInfo(rel); i.create_system = 3; i.external_attr = (st.st_mode & 0xFFFF) << 16
                z.writestr(i, os.readlink(p))
            elif stat.S_ISDIR(st.st_mode):
                i = zipfile.ZipInfo(rel + "/"); i.create_system = 3; i.external_attr = ((st.st_mode & 0xFFFF) << 16) | 0x10
                z.writestr(i, b"")
            else:
                z.write(p, rel)
`;

export const havePython = (() => { try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const haveUnzip = (() => { try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** Unpacks a zip with Python, keeping modes and symlinks. */
export function pyUnzip(zip: string, into: string): void {
  execFileSync("python3", ["-I", "-c", UNZIP_PY, zip, into]);
}

/** Zips `dir` (its folder name included) the way ditto does: modes and symlinks kept. */
export function pyZip(dir: string, out: string): void {
  execFileSync("python3", ["-I", "-c", ZIP_PY, dir, out]);
}

/** Makes sure `unzip -q <zip> -d <dir>` works: the real one, or a Python stand-in put first on PATH. */
export function ensureUnzip(): void {
  if (haveUnzip) return;
  const bin = mkdtempSync(path.join(tmpdir(), "hands-unzip-"));
  const script = path.join(bin, "unzip");
  writeFileSync(script, `#!/usr/bin/env python3\nimport sys\nargs = [a for a in sys.argv[1:] if a != "-q"]\nzip_file, dest = args[0], args[args.index("-d") + 1]\nsys.argv = ["unzip", zip_file, dest]\n${UNZIP_PY}`);
  chmodSync(script, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
}
