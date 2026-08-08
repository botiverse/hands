#!/usr/bin/env python3
"""Checks over workflow files, and the means to run them against a file that should
fail them.

  check-workflows.py <file>...   exit 0 clean, 1 defects, 2 could-not-run

Three exits, not two: a tool that could not run must not be mistaken for one that
found nothing. That happened four times in a day here - a probe refused by D1, an
absent PyYAML twice, and an injection that never modified its target.

The interpolation check walks the *parsed* document rather than the lines. "|", ">",
"|-", ">+" and a plain one-line scalar are serialisation details that vanish at parse
time: each becomes the same string under a step's "run" key. Scanning lines meant
enumerating those spellings, and the first version enumerated them wrong - it matched
only "run: |" while this repository holds 70 single-line "run:" steps and no block
ones, so it called the tree clean without having examined one statement. Parsing does
not make that enumeration more complete; it removes it.

Kept outside .github/workflows/ so GitHub never parses the fixture beside it.
"""

import sys

try:
    import yaml
except ModuleNotFoundError:
    # Exit 2, not 1. Otherwise the import error is a non-zero exit the caller reads as
    # "defects found", sending someone after a duplicate key that does not exist - and
    # the usual answer to a red nobody can reproduce is to relax the check.
    print("CANNOT RUN: PyYAML is not installed; no file was checked.", file=sys.stderr)
    raise SystemExit(2)

# Assembled rather than written, so this file does not match its own rule.
INTERPOLATION = "${" + "{"


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


def _steps(doc):
    """Every step, labelled so a human can find it without a line number."""
    for job_name, job in (doc.get("jobs") or {}).items():
        if not isinstance(job, dict):
            continue
        for i, step in enumerate(job.get("steps") or []):
            if isinstance(step, dict):
                yield f"{job_name} / {step.get('name') or 'step ' + str(i)}", step
    for i, step in enumerate(((doc.get("runs") or {}) if isinstance(doc.get("runs"), dict) else {}).get("steps") or []):
        if isinstance(step, dict):
            yield f"runs / {step.get('name') or 'step ' + str(i)}", step


def _executable_text(step):
    """Text the step will execute. `run` is shell; github-script's `script` is
    JavaScript, and interpolating into that is the same defect in another language."""
    if isinstance(step.get("run"), str):
        yield "run", step["run"]
    uses = step.get("uses") or ""
    with_ = step.get("with") or {}
    if (isinstance(uses, str) and "github-script" in uses
            and isinstance(with_, dict) and isinstance(with_.get("script"), str)):
        yield "with.script", with_["script"]


def interpolations(path, doc):
    return [
        f"{path}: {where}: interpolation inside {key}"
        for where, step in _steps(doc)
        for key, text in _executable_text(step)
        if INTERPOLATION in text
    ]


def uncovered_carriers(path, doc):
    """References to files holding steps this run was not given.

    What can carry executable text is not a fixed set, and no rule enumerates what
    does not exist yet — but it can notice the set changing. Checked against the
    parsed document rather than the text: a grep for this pattern matched the comment
    describing it, which is the same self-match the lint's own token had.
    """
    out = []
    for where, step in _steps(doc):
        uses = step.get("uses")
        if isinstance(uses, str) and uses.startswith("./"):
            out.append(f"{path}: {where}: uses {uses}, whose steps were not scanned")
    for job_name, job in (doc.get("jobs") or {}).items():
        if isinstance(job, dict) and isinstance(job.get("uses"), str) and job["uses"].startswith("./"):
            out.append(f"{path}: {job_name}: uses {job['uses']}, whose steps were not scanned")
    return out


def duplicate_keys(path):
    try:
        yaml.load(open(path, encoding="utf-8"), _Strict)
    except yaml.YAMLError as exc:
        return [f"{path}: {exc}"]
    return []


def main(paths):
    problems, uncovered = [], []
    for path in paths:
        problems += duplicate_keys(path)
        try:
            doc = yaml.safe_load(open(path, encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            print(f"CANNOT RUN: {path} does not parse: {exc}", file=sys.stderr)
            return 2
        problems += interpolations(path, doc)
        uncovered += uncovered_carriers(path, doc)
    for line in problems:
        print(line)
    if uncovered:
        # Exit 2: this is not a defect found, it is coverage lost. Reporting it as
        # clean would be the silent version of the same gap.
        print("", file=sys.stderr)
        print("CANNOT RUN (partial): steps exist in files this run did not scan.", file=sys.stderr)
        for line in uncovered:
            print(f"  {line}", file=sys.stderr)
        return 2
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
