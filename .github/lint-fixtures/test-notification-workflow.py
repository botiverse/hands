#!/usr/bin/env python3
"""Keep the failure notifier aligned with the workflows it is meant to watch."""

from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
NOTIFIER = WORKFLOWS / "notify-hands-workflow-failures.yml"


class _Yaml12SafeLoader(yaml.SafeLoader):
    """Do not treat the GitHub Actions key `on` as a YAML 1.1 boolean."""


for first_char, resolvers in list(_Yaml12SafeLoader.yaml_implicit_resolvers.items()):
    _Yaml12SafeLoader.yaml_implicit_resolvers[first_char] = [
        resolver
        for resolver in resolvers
        if resolver[0] != "tag:yaml.org,2002:bool"
    ]


def load(path: Path):
    with path.open(encoding="utf-8") as stream:
        return yaml.load(stream, Loader=_Yaml12SafeLoader)


def main() -> None:
    publish_and_deploy = sorted(
        [*WORKFLOWS.glob("publish-*.yml"), *WORKFLOWS.glob("deploy-*.yml")]
    )
    expected_names = {load(path)["name"] for path in publish_and_deploy}

    notifier = load(NOTIFIER)
    watched_names = set(notifier["on"]["workflow_run"]["workflows"])
    assert watched_names == expected_names, (
        "workflow_run monitor drift: "
        f"missing={sorted(expected_names - watched_names)}, "
        f"unexpected={sorted(watched_names - expected_names)}"
    )

    job = notifier["jobs"]["notify"]
    assert job["environment"] == "raft-workflow-notifications"
    permissions = job.get("permissions", notifier.get("permissions"))
    assert permissions == {"contents": "read"}
    assert {"failure", "cancelled", "timed_out"} <= {
        conclusion
        for conclusion in ("failure", "cancelled", "timed_out")
        if f"== '{conclusion}'" in job["if"]
    }

    steps = job["steps"]
    install = next(step for step in steps if step.get("name") == "Install pinned Raft CLI")
    assert "@botiverse/raft@0.0.17" in install["run"]
    materialize = next(
        step for step in steps if step.get("name") == "Materialize isolated profile credential"
    )
    assert materialize["env"] == {
        "RAFT_CREDENTIAL_JSON": "${{ secrets.RAFT_NOTIFY_CREDENTIAL_JSON }}"
    }
    post = next(step for step in steps if step.get("name") == "Post structured failure alert")
    assert 'message send --target "#proj-hands"' in post["run"]

    print(
        "Notification contract clean: "
        f"{len(watched_names)} Publish/Deploy workflows, isolated credential, pinned CLI."
    )


if __name__ == "__main__":
    main()
