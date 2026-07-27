import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

const workerDir = resolve(import.meta.dirname, "..");
const repositoryDir = resolve(workerDir, "..");
const renderScript = resolve(workerDir, "scripts/render-production-config.mjs");

const BASE_ENV = {
  HANDS_WORKER_NAME: "hands-test",
  HANDS_D1_DATABASE_NAME: "hands-test-db",
  HANDS_D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
  HANDS_R2_BUCKET_NAME: "hands-test-artifacts",
  HANDS_BUSINESS_DOMAIN: "hands.build",
  HANDS_DASHBOARD_DOMAIN: "app.hands.build",
  HANDS_CORS_ALLOWED_ORIGINS: "https://hands.build",
  HANDS_RAFT_ORIGIN: "https://app.raft.build",
  HANDS_RAFT_API_ORIGIN: "https://api.raft.build",
  HANDS_RAFT_CLIENT_ID: "hands-test-client",
};

function render(extraEnv: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hands-production-config-"));
  const output = join(directory, "wrangler.json");
  const result = spawnSync(process.execPath, [renderScript, "--output", output], {
    cwd: workerDir,
    encoding: "utf8",
    env: { ...process.env, ...BASE_ENV, ...extraEnv },
  });
  return {
    result,
    output,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("production config keeps reporter sessions disabled by default", () => {
  const fixture = render();
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const config = JSON.parse(readFileSync(fixture.output, "utf8"));
    assert.equal(config.vars.FEEDBACK_REPORTER_SESSION_ENABLED, "false");
    assert.equal("FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION" in config.vars, false);
  } finally {
    fixture.cleanup();
  }
});

test("production config requires a closed key version before enabling reporter sessions", () => {
  const invalidFlag = render({ HANDS_FEEDBACK_REPORTER_SESSION_ENABLED: "TRUE" });
  try {
    assert.notEqual(invalidFlag.result.status, 0);
    assert.match(invalidFlag.result.stderr, /must be exactly true or false/);
  } finally {
    invalidFlag.cleanup();
  }

  const missing = render({ HANDS_FEEDBACK_REPORTER_SESSION_ENABLED: "true" });
  try {
    assert.notEqual(missing.result.status, 0);
    assert.match(missing.result.stderr, /ACTIVE_KEY_VERSION is required/);
  } finally {
    missing.cleanup();
  }

  const enabled = render({
    HANDS_FEEDBACK_REPORTER_SESSION_ENABLED: "true",
    HANDS_FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION: "staging-v1",
  });
  try {
    assert.equal(enabled.result.status, 0, enabled.result.stderr);
    const config = JSON.parse(readFileSync(enabled.output, "utf8"));
    assert.equal(config.vars.FEEDBACK_REPORTER_SESSION_ENABLED, "true");
    assert.equal(config.vars.FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION, "staging-v1");
  } finally {
    enabled.cleanup();
  }
});

test("deploy workflow binds the keyring only through the secret store", () => {
  const workflow = readFileSync(resolve(repositoryDir, ".github/workflows/deploy-hands-server.yml"), "utf8");
  assert.match(workflow, /jobs:\n  deploy:\n    environment: reporter-session-production\n/);
  assert.match(
    workflow,
    /FEEDBACK_REPORTER_SESSION_KEYS: \$\{\{ secrets\.HANDS_FEEDBACK_REPORTER_SESSION_KEYS \}\}/,
  );
  assert.match(
    workflow,
    /wrangler secret put FEEDBACK_REPORTER_SESSION_KEYS --config/,
  );
  assert.doesNotMatch(workflow, /FEEDBACK_REPORTER_SESSION_KEYS: \$\{\{ vars\./);
  assert.match(
    workflow,
    /HANDS_FEEDBACK_REPORTER_SESSION_ENABLED: \$\{\{ vars\.HANDS_FEEDBACK_REPORTER_SESSION_ENABLED \}\}/,
  );
  const validationIndex = workflow.indexOf("- name: Validate reporter-session rollout inputs");
  const deployIndex = workflow.indexOf("- name: Deploy Hands Worker and admin assets");
  assert.ok(validationIndex >= 0 && deployIndex > validationIndex, "enabled inputs fail before Worker deploy");
});
