import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";

// Preview lanes were removed; fail loudly instead of silently rendering a
// production config for a caller that still expects preview behavior.
if (process.argv.includes("--preview")) {
  console.error("Preview lanes were removed; --preview is no longer supported.");
  process.exit(1);
}

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

function booleanString(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be exactly true or false`);
  }
  return value;
}

function optionalKeyVersion(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new Error(`${name} must be a valid key version`);
  }
  return value;
}

function optionalWorkerName(name) {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(`${name} must be a valid Cloudflare Worker service name`);
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
const reporterSessionEnabled = booleanString("HANDS_FEEDBACK_REPORTER_SESSION_ENABLED", "false");
const reporterSessionActiveKeyVersion = optionalKeyVersion(
  "HANDS_FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION",
);
const playReleaseServiceName = optionalWorkerName("HANDS_PLAY_RELEASE_SERVICE_NAME");
const playCredentialActiveKeyVersion = optionalKeyVersion(
  "HANDS_PLAY_CRED_ENC_ACTIVE_KEY_VERSION",
);
if (reporterSessionEnabled === "true" && !reporterSessionActiveKeyVersion) {
  throw new Error(
    "HANDS_FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION is required when reporter sessions are enabled",
  );
}
const d1 = config.d1_databases?.find((binding) => binding.binding === "DB");
const r2 = config.r2_buckets?.find((binding) => binding.binding === "APK_BUCKET");
if (!d1 || !r2) throw new Error("Hands DB or APK_BUCKET binding is missing from the base config");

config.name = required("HANDS_WORKER_NAME");
config.flagship = [
  {
    binding: "FLAGS",
    app_id: uuid("HANDS_FLAGSHIP_APP_ID"),
  },
];
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
  HANDS_ADMIN_ALLOWED_SERVER_IDS: required("HANDS_ADMIN_ALLOWED_SERVER_IDS"),
  R2_BUCKET_NAME: r2.bucket_name,
  FEEDBACK_REPORTER_SESSION_ENABLED: reporterSessionEnabled,
};
if (reporterSessionActiveKeyVersion) {
  config.vars.FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION = reporterSessionActiveKeyVersion;
} else {
  delete config.vars.FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION;
}
if (playReleaseServiceName) {
  if (!playCredentialActiveKeyVersion) {
    throw new Error(
      "HANDS_PLAY_CRED_ENC_ACTIVE_KEY_VERSION is required when the Play adapter is configured",
    );
  }
  config.vars.PLAY_CRED_ENC_ACTIVE_KEY_VERSION = playCredentialActiveKeyVersion;
  config.services = [
    ...(config.services ?? []).filter((binding) => binding.binding !== "PLAY_RELEASE_SERVICE"),
      { binding: "PLAY_RELEASE_SERVICE", service: playReleaseServiceName },
  ];
} else if (Array.isArray(config.services)) {
  config.services = config.services.filter((binding) => binding.binding !== "PLAY_RELEASE_SERVICE");
  if (config.services.length === 0) delete config.services;
}
if (!playReleaseServiceName) {
  delete config.vars.PLAY_CRED_ENC_ACTIVE_KEY_VERSION;
}

// Build stamp for the container image, so a rollout can be verified by reading the
// container rather than by trusting that the workflow went green. `image_vars` is
// wrangler's build-arg channel - its own type says "available to the image at
// build-time only" - and the Dockerfile turns GIT_SHA into BUILD_SHA, which /health
// reports.
//
// Left absent when GITHUB_SHA is unset (local renders), rather than defaulting to a
// placeholder: a stamp that always has *some* value cannot distinguish "built by a
// deploy" from "built by hand", and this exists precisely to make that distinguishable.
const gitSha = (process.env.GITHUB_SHA ?? "").trim();
const containerApp = config.containers?.find(
  (entry) => entry.class_name === "ApkParserContainer",
);
if (!containerApp) {
  throw new Error("ApkParserContainer is missing from the base config");
}
if (gitSha) {
  containerApp.image_vars = { ...containerApp.image_vars, GIT_SHA: gitSha };
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Rendered production Wrangler config: ${outputPath}`);
