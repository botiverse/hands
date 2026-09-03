import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

const adapterDir = resolve(import.meta.dirname, "..");
const repositoryDir = resolve(adapterDir, "..");
const renderScript = resolve(adapterDir, "scripts/render-production-config.mjs");
const BASE_ENV = {
  HANDS_PLAY_ADAPTER_WORKER_NAME: "hands-google-play-adapter",
  HANDS_PLAY_MAX_AAB_SIZE_BYTES: "209715200",
};

function render(extraEnv: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hands-play-config-"));
  const output = join(directory, "wrangler.json");
  const result = spawnSync(process.execPath, [renderScript, "--output", output], {
    cwd: adapterDir,
    encoding: "utf8",
    env: { ...process.env, ...BASE_ENV, ...extraEnv },
  });
  return { result, output, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("production config keeps the adapter private and renders the exact bounded surface", () => {
  const fixture = render();
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const config = JSON.parse(readFileSync(fixture.output, "utf8"));
    assert.equal(config.name, BASE_ENV.HANDS_PLAY_ADAPTER_WORKER_NAME);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal("routes" in config, false);
    assert.deepEqual(config.vars, {
      MAX_AAB_SIZE_BYTES: "209715200",
    });
    assert.doesNotMatch(JSON.stringify(config), /SERVICE_ACCOUNT|ALLOWED_PACKAGE|CLOSED_TRACK/);
  } finally {
    fixture.cleanup();
  }
});

test("adapter registers a closed HTTP handler so Cloudflare accepts the private RPC entrypoint", () => {
  const entrypoint = readFileSync(resolve(adapterDir, "src/entrypoint.ts"), "utf8");
  assert.match(entrypoint, /async fetch\(\): Promise<Response>/);
  assert.match(entrypoint, /new Response\(null, \{ status: 404 \}\)/);
});

test("production config rejects malformed service and size inputs", () => {
  const cases = [
    [{ HANDS_PLAY_ADAPTER_WORKER_NAME: "https://bad.example" }, /valid Cloudflare Worker/],
    [{ HANDS_PLAY_MAX_AAB_SIZE_BYTES: "0" }, /positive safe integer/],
  ] as const;
  for (const [environment, pattern] of cases) {
    const fixture = render(environment);
    try {
      assert.notEqual(fixture.result.status, 0);
      assert.match(fixture.result.stderr, pattern);
    } finally {
      fixture.cleanup();
    }
  }
});

test("adapter deployment is manual, environment-gated, and has no global Play credential", () => {
  const workflow = readFileSync(
    resolve(repositoryDir, ".github/workflows/deploy-hands-play-adapter.yml"),
    "utf8",
  );
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request):$/m);
  assert.match(workflow, /^    environment: hands-play-production$/m);
  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.doesNotMatch(workflow, /run_checks/);
  assert.doesNotMatch(workflow, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON|HANDS_PLAY_ALLOWED_PACKAGE_NAMES|HANDS_PLAY_CLOSED_TRACK_NAME/);
  assert.doesNotMatch(workflow, /--secrets-file|wrangler secret put/);
});
