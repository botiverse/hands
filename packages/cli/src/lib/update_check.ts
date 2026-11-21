/**
 * Tells people running an old CLI that a newer one exists. The CLI has no other
 * way to learn this, so a client that the server has moved past (a renamed app
 * id, a new login flow) only fails with an error that does not mention
 * upgrading.
 *
 * At most one registry lookup per day, cached in the config directory. The
 * lookup runs alongside the command and is waited for only briefly at the end;
 * a slow or offline registry never delays or fails a command. The notice goes
 * to stderr, so `--json` output on stdout is unchanged. Skipped in CI and when
 * HANDS_NO_UPDATE_CHECK is set.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "./config.js";
import { readEnv } from "./env.js";

export const PACKAGE_NAME = "@botiverse/hands-cli";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
const FINISH_WAIT_MS = 1000;

interface UpdateCache {
  checkedAt: number;
  latest: string;
}

export function updateCachePath(): string {
  return join(configDir(), "hands", "update-check.json");
}

function readCache(): UpdateCache | null {
  try {
    const parsed = JSON.parse(readFileSync(updateCachePath(), "utf8")) as Partial<UpdateCache>;
    if (typeof parsed.checkedAt === "number" && typeof parsed.latest === "string") {
      return { checkedAt: parsed.checkedAt, latest: parsed.latest };
    }
  } catch {
    // missing or unreadable: treat as never checked
  }
  return null;
}

function writeCache(cache: UpdateCache): void {
  try {
    mkdirSync(dirname(updateCachePath()), { recursive: true });
    writeFileSync(updateCachePath(), JSON.stringify(cache));
  } catch {
    // a read-only home must not break the command
  }
}

/** Plain x.y.z comparison; anything else (pre-releases, garbage) is never "newer". */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (readEnv("NO_UPDATE_CHECK")) return true;
  if (env.CI && env.CI !== "false" && env.CI !== "0") return true;
  return false;
}

export function upgradeHint(latest: string, current: string): string {
  return `A newer Hands CLI is available: ${current} -> ${latest}. Upgrade with: npm i -g ${PACKAGE_NAME}@latest`;
}

export interface UpdateCheck {
  /** Wait briefly for the lookup, then print the notice if one is due. */
  finish(): Promise<void>;
}

export function startUpdateCheck(
  current: string,
  deps: {
    now?: () => number;
    fetchLatest?: (signal: AbortSignal) => Promise<string | null>;
    write?: (line: string) => void;
    env?: NodeJS.ProcessEnv;
  } = {},
): UpdateCheck {
  const env = deps.env ?? process.env;
  if (updateCheckDisabled(env)) return { finish: async () => {} };
  const now = deps.now ?? Date.now;
  const write = deps.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fetchLatest = deps.fetchLatest ?? fetchLatestFromRegistry;

  const cache = readCache();
  let latest = cache?.latest ?? null;
  let lookup: Promise<void> | null = null;
  const controller = new AbortController();
  if (!cache || now() - cache.checkedAt >= CHECK_INTERVAL_MS) {
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    timer.unref?.();
    lookup = fetchLatest(controller.signal)
      .then((found) => {
        if (found) {
          latest = found;
          writeCache({ checkedAt: now(), latest: found });
        }
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  }

  return {
    async finish() {
      if (lookup) {
        await Promise.race([
          lookup,
          new Promise<void>((resolve) => setTimeout(resolve, FINISH_WAIT_MS).unref?.()),
        ]);
        // Never keep the process alive for a lookup the command did not wait for.
        controller.abort();
      }
      if (latest && isNewerVersion(latest, current)) write(upgradeHint(latest, current));
    },
  };
}

async function fetchLatestFromRegistry(signal: AbortSignal): Promise<string | null> {
  const res = await fetch(REGISTRY_URL, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const body = (await res.json()) as { version?: unknown };
  return typeof body.version === "string" ? body.version : null;
}
