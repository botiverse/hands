#!/usr/bin/env python3
"""Two checks over workflow files, plus the ability to be run against a file that
should fail them.

  check-workflows.py <file>...        report defects, exit 1 if any

Both defects are silent by nature, which is why they are worth a check at all:

  interpolation in a run block  the value is spliced in as program text before the
                                shell parses the line, so it is code rather than data
  duplicate mapping key         YAML keeps the last and discards the first without
                                complaint, so an added `env:` can delete the one
                                already there

Kept outside .github/workflows/ so GitHub never treats the fixture beside it as a
workflow.
"""

import re
import sys

try:
    import yaml
except ModuleNotFoundError:
    # Exit 2, not 1. Without this the import error becomes a non-zero exit that the
    # caller reads as "defects found", sending someone to look for a duplicate key
    # that does not exist - and the usual response to a red that cannot be reproduced
    # is to relax the check. Could-not-run is a third outcome and has to name itself.
    print("CANNOT RUN: PyYAML is not installed; no file was checked.", file=sys.stderr)
    raise SystemExit(2)

# Assembled rather than written, so this file does not match its own rule.
INTERPOLATION = "${" + "{"


def interpolations_in_run_blocks(path):
    """Interpolations in shell that a `run:` will execute, in any of its forms.

    Covering only `run: |` would have missed the majority of this repository: it holds
    70 single-line `run:` statements and no block ones. None of them interpolate today,
    so a block-only checker would have reported the tree clean and been right by
    accident — it could not have detected the case it was written to prevent.

    Handled: `run: |`, `run: >`, and `run: <command>` on one line, each with or
    without the `- ` list-item prefix — which is how every step in this repository
    actually writes it, and which an earlier version of this function did not match.
    """
    found, in_run, indent = [], False, 0
    for lineno, line in enumerate(open(path, encoding="utf-8"), 1):
        line = line.rstrip("\n")

        block = re.match(r"^(\s*)(?:-\s+)?run: [|>]", line)
        if block:
            in_run, indent = True, len(block.group(1))
            continue

        inline = re.match(r"^(\s*)(?:-\s+)?run: (?!\s*$)(.*)$", line)
        if inline and not block:
            in_run = False
            if INTERPOLATION in inline.group(2):
                found.append((lineno, line.strip()))
            continue

        if in_run and line.strip():
            if len(line) - len(line.lstrip()) <= indent:
                in_run = False
            elif INTERPOLATION in line:
                found.append((lineno, line.strip()))
    return found


class _Strict(yaml.SafeLoader):
    pass


def _no_duplicates(loader, node, deep=False):
    seen, out = set(), {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in seen:
            raise yaml.YAMLError(
                f"duplicate key {key!r} at line {key_node.start_mark.line + 1}"
            )
        seen.add(key)
        out[key] = loader.construct_object(value_node, deep=deep)
    return out


_Strict.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _no_duplicates)


def duplicate_keys(path):
    try:
        yaml.load(open(path, encoding="utf-8"), _Strict)
    except yaml.YAMLError as exc:
        return [str(exc)]
    return []


def main(paths):
    bad = 0
    for path in paths:
        for lineno, text in interpolations_in_run_blocks(path):
            print(f"{path}:{lineno}: interpolation inside a run block: {text}")
            bad += 1
        for message in duplicate_keys(path):
            print(f"{path}: {message}")
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
