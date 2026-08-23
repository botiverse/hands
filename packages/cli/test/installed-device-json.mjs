#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const tarball = process.argv[2];
if (!tarball) throw new Error("usage: installed-device-json.mjs <cli-tarball>");
const nodeTarball = process.argv[3];

async function snapshot(path) {
  try {
    const metadata = await stat(path);
    return { bytes: await readFile(path, "utf8"), mtimeMs: metadata.mtimeMs };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const root = await mkdtemp(join(tmpdir(), "hands-cli-installed-json-"));
const install = join(root, "install");
const state = join(root, "state");
const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/auth/me") {
    response.end(JSON.stringify({
      account: {
        id: "account-1",
        provider: "test",
        provider_subject: "subject-1",
        server_id: "server-1",
        server_slug: "test-server",
        principal_type: "human",
        server_role: "member",
        username: "test-user",
        display_name: "Test User",
        avatar_url: null,
        org_id: "org-1",
        org_role: "member",
      },
    }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

try {
  await exec("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", install,
    ...(nodeTarball ? [nodeTarball] : []), tarball,
  ]);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");

  const env = { ...process.env,
    PATH: `${join(install, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: join(root, "config"),
    HANDS_BEARER_TOKEN: "test-token",
  };
  delete env.SLOCK_CLI_TRANSPORT_DIR;
  delete env.SLOCK_HOME;
  delete env.SLOCK_AGENT_ID;

  const xdgDevicePath = join(state, "hands.build", "deviceid");
  const fallbackDevicePath = join(homedir(), ".local", "state", "hands.build", "deviceid");
  const fallbackBefore = await snapshot(fallbackDevicePath);

  let expectedDevice;
  for (const bin of ["hands", "quiver"]) {
    for (const args of [["--json", "device-id"], ["device-id", "--json"]]) {
      const result = await exec(bin, args, { env });
      assert.equal(result.stderr, "");
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(parsed), ["device"]);
      assert.match(parsed.device.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(parsed.device.scope, "os_user");
      assert.equal(parsed.device.namespace, "hands.build");
      expectedDevice ??= parsed.device;
      assert.deepEqual(parsed.device, expectedDevice);
      assert.equal((await readFile(xdgDevicePath, "utf8")).trim(), parsed.device.id);
    }

    for (const args of [
      ["--api", `http://127.0.0.1:${address.port}`, "--json", "whoami"],
      ["--api", `http://127.0.0.1:${address.port}`, "whoami", "--json"],
    ]) {
      const result = await exec(bin, args, { env });
      assert.equal(result.stderr, "");
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.account.id, "account-1");
      assert.deepEqual(parsed.device, expectedDevice);
    }
  }

  const deviceText = await exec("hands", ["device-id"], { env });
  assert.match(deviceText.stdout, /^device_id: [0-9a-f-]+\ndevice_scope: os_user\ndevice_namespace: hands\.build\n$/);
  const whoamiText = await exec("quiver", ["--api", `http://127.0.0.1:${address.port}`, "whoami"], { env });
  assert.match(whoamiText.stdout, /\n  device_id: [0-9a-f-]+\n  device_scope: os_user\n  device_namespace: hands\.build\n$/);
  assert.deepEqual(await snapshot(fallbackDevicePath), fallbackBefore);

  await writeFile(xdgDevicePath, "malformed\n", { mode: 0o600 });
  for (const [bin, args] of [
    ["hands", ["--json", "device-id"]],
    ["quiver", ["--api", `http://127.0.0.1:${address.port}`, "--json", "whoami"]],
  ]) {
    try {
      await exec(bin, args, { env });
      assert.fail(`${bin} unexpectedly accepted malformed device state`);
    } catch (error) {
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /DEVICE_ID_INVALID/);
    }
  }

  console.log("Installed CLI contract clean: both bins preserve JSON/text routing and fail without partial output.");
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
