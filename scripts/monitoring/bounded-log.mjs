import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// One active file plus seven generations: at most 64 MiB across restarts.
export function boundedLog(output, maxBytes = 8 * 1024 * 1024, generations = 8) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || !Number.isSafeInteger(generations) || generations < 1) throw new Error('Invalid log bounds');
  mkdirSync(dirname(resolve(output)), { recursive: true, mode: 0o700 });
  let size = existsSync(output) ? statSync(output).size : 0;
  return (row) => {
    const line = JSON.stringify(row) + '\n';
    const bytes = Buffer.byteLength(line);
    if (bytes > maxBytes) throw new Error('Log record exceeds file limit');
    if (size + bytes > maxBytes) {
      for (let i = generations - 1; i >= 0; i--) {
        const source = i === 0 ? output : `${output}.${i}`;
        if (!existsSync(source)) continue;
        if (i === generations - 1) unlinkSync(source);
        else renameSync(source, `${output}.${i + 1}`);
      }
      size = 0;
    }
    appendFileSync(output, line, { mode: 0o600 }); size += bytes;
  };
}
