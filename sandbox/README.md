# Stamp merge-queue sandbox

Staging-only retest branch for Stamp's merge queue. Not part of hands.

- `sandbox/BASE_RED`: when present, the branch's push run and queue
  candidates fail; ordinary PRs still pass. Add it in a PR to make the base
  red; remove it in a PR to recover.
- `sandbox/CANDIDATE_SLEEP`: seconds (max 1200) a queue candidate waits in
  testing, so the base can be moved while a batch tests.
- Member PRs: change any file under `sandbox/notes/`.
