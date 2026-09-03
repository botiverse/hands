import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const adapterDir = resolve(scriptDir, "..");
const sourcePath = resolve(adapterDir, "wrangler.jsonc");
const outputArgIndex = process.argv.indexOf("--output");
const outputPath = resolve(
  adapterDir,
  outputArgIndex >= 0 && process.argv[outputArgIndex + 1]
    ? process.argv[outputArgIndex + 1]
    : "wrangler.generated.jsonc",
);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment value ${name}`);
  return value;
}

function workerName(name) {
  const value = required(name);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(`${name} must be a valid Cloudflare Worker service name`);
  }
  return value;
}

function positiveInteger(name) {
  const value = required(name);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

const errors = [];
const config = parse(readFileSync(sourcePath, "utf8"), errors, {
  allowTrailingComma: true,
  disallowComments: false,
});
if (errors.length > 0 || !config || typeof config !== "object") {
  const detail = errors.map((error) => printParseErrorCode(error.error)).join(", ");
  throw new Error(`Unable to parse ${sourcePath}: ${detail || "invalid JSONC"}`);
}

config.name = workerName("HANDS_PLAY_ADAPTER_WORKER_NAME");
config.vars = {
  MAX_AAB_SIZE_BYTES: positiveInteger("HANDS_PLAY_MAX_AAB_SIZE_BYTES"),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Rendered Google Play adapter config: ${outputPath}`);
