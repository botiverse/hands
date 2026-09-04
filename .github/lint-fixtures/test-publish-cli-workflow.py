#!/usr/bin/env python3
from pathlib import Path
import subprocess
import yaml

ROOT = Path(__file__).resolve().parents[2]
workflow = yaml.safe_load((ROOT / ".github/workflows/publish-cli.yml").read_text())
steps = workflow["jobs"]["publish"]["steps"]
verify_node = next(step for step in steps if step.get("name") == "Verify Hands Node SDK dependency is published")
assert "scripts/resolve-workspace-dependency-version.mjs" in verify_node["run"]
assert 'npm view "@botiverse/hands-node@${version}" version' in verify_node["run"]
# The resolver call is the gate, not its output. It throws unless the consumer
# declares `workspace:*` and the dependency package carries a version, so running
# it is what proves the contract. Comparing the printed value to a literal only
# restated packages/node/package.json back to itself, and went red on every
# legitimate version bump -- #510 bumped agent-session-store and the pinned copy
# below it failed the publish contract check for a release it had nothing to say
# about. Dropped per @artin 2026-09-04.
subprocess.check_output([
    "node", "scripts/resolve-workspace-dependency-version.mjs",
    "packages/cli/package.json", "@botiverse/hands-node", "packages/node/package.json",
], cwd=ROOT, text=True)
verify_store = next(step for step in steps if step.get("name") == "Verify agent-session-store dependency is published")
assert "scripts/resolve-workspace-dependency-version.mjs" in verify_store["run"]
assert 'npm view "@botiverse/agent-session-store@${version}" version' in verify_store["run"]
subprocess.check_output([
    "node", "scripts/resolve-workspace-dependency-version.mjs",
    "packages/cli/package.json", "@botiverse/agent-session-store", "packages/agent-session-store/package.json",
], cwd=ROOT, text=True)
installed_json = next(step for step in steps if step.get("name") == "Verify installed device JSON commands")
assert 'node packages/cli/test/installed-device-json.mjs "$PACKAGE_PATH"' in installed_json["run"]
assert installed_json["env"]["PACKAGE_PATH"] == "${{ steps.pack.outputs.path }}"
print("Publish CLI dependency contract clean: both dependencies are declared workspace:*, the publish workflow resolves them through the resolver, and each is npm view-gated before publish.")
