import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(scriptDir, "..");
const sourcePath = resolve(workerDir, "wrangler.hands.jsonc");
const outputArgIndex = process.argv.indexOf("--output");
const outputPath = resolve(
  workerDir,
  outputArgIndex >= 0 && process.argv[outputArgIndex + 1]
    ? process.argv[outputArgIndex + 1]
    : "wrangler.hands.generated.jsonc",
);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment value ${name}`);
  return value;
}

function domain(name) {
  const value = required(name);
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(value)) {
    throw new Error(`${name} must be a hostname without a scheme or path`);
  }
  return value.toLowerCase();
}

function uuid(name) {
  const value = required(name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID`);
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

const businessDomain = domain("HANDS_BUSINESS_DOMAIN");
const dashboardDomain = domain("HANDS_DASHBOARD_DOMAIN");
const d1 = config.d1_databases?.find((binding) => binding.binding === "DB");
const r2 = config.r2_buckets?.find((binding) => binding.binding === "APK_BUCKET");
if (!d1 || !r2) throw new Error("Hands DB or APK_BUCKET binding is missing from the base config");

config.name = required("HANDS_WORKER_NAME");
const configuredRoutes = new Set(
  (config.routes ?? []).filter((route) => route.custom_domain).map((route) => route.pattern),
);
for (const expected of [businessDomain, dashboardDomain]) {
  if (!configuredRoutes.has(expected)) {
    throw new Error(`Checked-in custom-domain route does not match ${expected}`);
  }
}
d1.database_name = required("HANDS_D1_DATABASE_NAME");
d1.database_id = uuid("HANDS_D1_DATABASE_ID");
r2.bucket_name = required("HANDS_R2_BUCKET_NAME");
config.vars = {
  ...config.vars,
  ENVIRONMENT: "production",
  BUSINESS_ORIGIN: `https://${businessDomain}`,
  DASHBOARD_ORIGIN: `https://${dashboardDomain}`,
  CORS_ALLOWED_ORIGINS: required("HANDS_CORS_ALLOWED_ORIGINS"),
  RAFT_ORIGIN: required("HANDS_RAFT_ORIGIN"),
  RAFT_API_ORIGIN: required("HANDS_RAFT_API_ORIGIN"),
  RAFT_CLIENT_ID: required("HANDS_RAFT_CLIENT_ID"),
  R2_BUCKET_NAME: r2.bucket_name,
};

// Preview mode: a throwaway `hands-worker-preview` on a single fixed host
// preview.<business> for UI review (one branch previewed at a time — Raft apps
// allow only one callback, so a fixed host keeps a single registered callback).
// Reuses production D1/R2 (read-only review) + the same container/DO bindings,
// and points origins at the preview host so Login-with-Raft resolves there. Uses
// a dedicated preview Raft app (HANDS_PREVIEW_RAFT_CLIENT_ID + its secret) so the
// production hands-4cc7a2 app's single callback is untouched.
if (process.argv.includes("--preview")) {
  const previewHost = `preview.${businessDomain}`;
  config.name = "hands-worker-preview";
  config.routes = [{ pattern: previewHost, custom_domain: true }];
  config.vars.ENVIRONMENT = "preview";
  config.vars.BUSINESS_ORIGIN = `https://${previewHost}`;
  config.vars.DASHBOARD_ORIGIN = `https://${previewHost}`;
  config.vars.CORS_ALLOWED_ORIGINS = `https://${previewHost},http://localhost:5173`;
  config.vars.RAFT_CLIENT_ID = required("HANDS_PREVIEW_RAFT_CLIENT_ID");
  console.log(`Preview config: ${config.name} on https://${previewHost}`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Rendered production Wrangler config: ${outputPath}`);
