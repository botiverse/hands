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
  HANDS_ADMIN_ALLOWED_SERVER_IDS: "server-test",
  HANDS_FLAGSHIP_APP_ID: "22222222-2222-4222-8222-222222222222",
};

function render(extraEnv: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hands-production-config-"));
  const output = join(directory, "wrangler.json");
  const inheritedEnv = { ...process.env };
  for (const key of Object.keys(inheritedEnv)) {
    if (key.startsWith("HANDS_FEEDBACK_REPORTER_SESSION_")) delete inheritedEnv[key];
  }
  const result = spawnSync(process.execPath, [renderScript, "--output", output], {
    cwd: workerDir,
    encoding: "utf8",
    env: { ...inheritedEnv, ...BASE_ENV, ...extraEnv },
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
    assert.deepEqual(config.placement, { mode: "smart" });
    assert.deepEqual(config.flagship, [
      {
        binding: "FLAGS",
        app_id: BASE_ENV.HANDS_FLAGSHIP_APP_ID,
      },
    ]);
    assert.deepEqual(config.observability.traces, {
      enabled: true,
      head_sampling_rate: 0.05,
      persist: true,
    });
    assert.equal(config.vars.FEEDBACK_REPORTER_SESSION_ENABLED, "false");
    assert.equal(config.vars.HANDS_ADMIN_ALLOWED_SERVER_IDS, "server-test");
    assert.equal("FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION" in config.vars, false);
  } finally {
    fixture.cleanup();
  }
});

test("production config requires a valid Flagship app id", () => {
  const missing = render({ HANDS_FLAGSHIP_APP_ID: "" });
  try {
    assert.notEqual(missing.result.status, 0);
    assert.match(missing.result.stderr, /Missing required environment value HANDS_FLAGSHIP_APP_ID/);
  } finally {
    missing.cleanup();
  }

  const invalid = render({ HANDS_FLAGSHIP_APP_ID: "not-an-app-id" });
  try {
    assert.notEqual(invalid.result.status, 0);
    assert.match(invalid.result.stderr, /HANDS_FLAGSHIP_APP_ID must be a UUID/);
  } finally {
    invalid.cleanup();
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

// This test used to assert that the reporter-session keyring reached the Worker only
// through the secret store. That keyring is gone - deleted from the GitHub environment,
// from the Worker, and finally from this workflow - so every "it is wired this way"
// assertion here now describes a thing that should not exist. Inverted rather than
// deleted: the assertions are the record of what was removed, and a deleted test cannot
// notice the wiring coming back.
test("the reporter-session keyring is gone from the deploy workflow", () => {
  const workflow = readFileSync(resolve(repositoryDir, ".github/workflows/deploy-hands-server.yml"), "utf8");

  assert.doesNotMatch(workflow, /HANDS_FEEDBACK_REPORTER_SESSION_KEYS/);
  assert.doesNotMatch(workflow, /wrangler secret put FEEDBACK_REPORTER_SESSION_KEYS/);
  assert.doesNotMatch(workflow, /vars\.HANDS_FEEDBACK_REPORTER_SESSION_/);
  assert.doesNotMatch(workflow, /- name: Validate reporter-session rollout inputs/);

  // Positive control. Every assertion above passes on an empty string, on a file that
  // was renamed out from under this test, and on a read that silently returned nothing -
  // "the wiring is absent" and "there is no file here" are the same result. This anchors
  // them to a workflow that was actually read.
  assert.match(workflow, /HANDS_FLAGSHIP_APP_ID: \$\{\{ vars\.HANDS_FLAGSHIP_APP_ID \}\}/);
});

// Split from the case above because it outlived it. The environment is named for the
// retired feature but is not part of it: its deployment branch policy is what confines
// this production deploy to main, and the cleanup that removed the keyring came within a
// commit of removing this too.
//
// Matched on the line at job-key indentation rather than on `jobs:\n  deploy:\n
// environment:` as before. That earlier form required the two lines to be adjacent, so
// it broke the moment a comment was added above `environment:` to explain why it must
// stay - a test that fails when someone documents the thing it protects will be
// "corrected" by deleting the documentation. Anchoring to indentation keeps the property
// (a job-level binding, not a string appearing somewhere in the file) without pinning
// what may sit between them.
test("the deploy job stays bound to its environment", () => {
  const workflow = readFileSync(resolve(repositoryDir, ".github/workflows/deploy-hands-server.yml"), "utf8");
  assert.match(workflow, /^  deploy:$/m);
  assert.match(workflow, /^    environment: reporter-session-production$/m);
});
