#!/usr/bin/env python3
from pathlib import Path
import subprocess
import yaml

ROOT = Path(__file__).resolve().parents[2]
workflow = yaml.safe_load((ROOT / ".github/workflows/publish-cli.yml").read_text())
steps = workflow["jobs"]["publish"]["steps"]
verify = next(step for step in steps if step.get("name") == "Verify Hands Node SDK dependency is published")
run = verify["run"]
assert "scripts/resolve-workspace-dependency-version.mjs" in run
assert 'npm view "@botiverse/hands-node@${version}" version' in run
version = subprocess.check_output([
    "node", "scripts/resolve-workspace-dependency-version.mjs",
    "packages/cli/package.json", "@botiverse/hands-node", "packages/node/package.json",
], cwd=ROOT, text=True)
assert version == "0.5.1"
installed_json = next(step for step in steps if step.get("name") == "Verify installed device JSON commands")
assert 'node packages/cli/test/installed-device-json.mjs "$PACKAGE_PATH"' in installed_json["run"]
assert installed_json["env"]["PACKAGE_PATH"] == "${{ steps.pack.outputs.path }}"
print("Publish CLI dependency contract clean: workspace:* resolves to exact published Node package version.")
