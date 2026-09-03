import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Negative control for the "Check who is watching a pending migration" gate in
 * deploy-hands-server.yml (PR #423). The gate's fail-closed property was a design
 * assertion nobody had ever exercised: the only production dispatch since baseline
 * hit "No migrations pending" and short-circuited before the id-shape check ever
 * ran, so N=0 traversals of the reject branch — armed, never fired (flagged by
 * @Gogo/@Sentinel 2026-08-12). A green "Apply migrations" step does not mean a
 * migration was applied, and "the gate is fail-closed" only says it exists, not
 * that it blocks.
 *
 * This gives that branch a standing denominator: it extracts the reference regex
 * VERBATIM from the workflow (so a change to the gate re-binds the test rather
 * than testing a stale copy) and runs the gate's decision logic — stubbing only
 * the wrangler fetch — across the truth table. The reject branch is right-cause
 * RED: opaque/off-surface references stop before apply; canonical reference
 * shapes pass; no-pending short-circuits.
 */

const workflowPath = resolve(
  __dirname,
  "../../.github/workflows/deploy-hands-server.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

// Extract the canonical-reference regex verbatim from the gate step. If this
// fails, the gate changed shape and the test should be re-read, not silently pass.
const regexMatch = workflow.match(
  /READBACK_OWNER\}"\s*=~\s*(.+?)\s+\]\]; then/,
);
const SHAPE_RE = regexMatch?.[1];

// Faithful reproduction of the gate's decision logic. Only the wrangler fetch is
// replaced by $PENDING; everything else mirrors the workflow step.
function runGate(pending: string, reference: string): { code: number; out: string } {
  const script = `
    set -euo pipefail
    pending="$1"
    READBACK_OWNER="$2"
    if grep -qi "no migrations to apply" <<<"$pending"; then
      echo "short-circuit"; exit 0
    fi
    if [[ ! "\${READBACK_OWNER}" =~ ${SHAPE_RE} ]]; then
      echo "stopped-before-apply"; exit 1
    fi
    echo "proceeds-to-apply"
  `;
  const r = spawnSync("bash", ["-c", script, "bash", pending, reference], {
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: (r.stdout + r.stderr).trim() };
}

describe("migration handshake gate — the reject branch, exercised", () => {
  it("extracts the canonical-reference regex from the live workflow", () => {
    // The regex the gate actually uses. Pinned so a change to it fails here
    // rather than drifting from what the test exercises.
    expect(SHAPE_RE).toBe(
      "^#proj-hands:3308eb65\\ msg=([0-9a-fA-F]{8}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$",
    );
  });

  // Migrations pending + a value that is not a canonical reference to the
  // required independently visible thread must stop before the apply.
  it.each([
    ["none (the dispatch default)", "none"],
    ["too short", "12345"],
    ["illegal characters", "not-an-id!!"],
    ["empty", ""],
    ["a bare id", "f9eca512"],
    ["an off-surface thread", "#joint-hands:dcbb01c3 msg=f9eca512"],
    ["a malformed canonical id", "#proj-hands:3308eb65 msg=f9eca512-extra"],
    ["a double-space separator", "#proj-hands:3308eb65  msg=f9eca512"],
    ["a tab separator", "#proj-hands:3308eb65\tmsg=f9eca512"],
    ["a newline separator", "#proj-hands:3308eb65\nmsg=f9eca512"],
    ["a carriage-return separator", "#proj-hands:3308eb65\rmsg=f9eca512"],
  ])("stops before apply when pending and reference is %s", (_label, reference) => {
    const { code, out } = runGate("0063_something.sql (pending)", reference);
    expect(code).toBe(1);
    expect(out).toContain("stopped-before-apply");
  });

  // Positive control: canonical reference shapes pass, so the reject above is
  // right-cause (wrong surface/shape), not a blanket failure. `deadbeef` is
  // intentionally unverified: the runner has no Raft credential and this test
  // preserves that existence/author/predates remain the readback owner's job.
  it.each([
    ["canonical short id", "#proj-hands:3308eb65 msg=deadbeef"],
    [
      "canonical full UUID",
      "#proj-hands:3308eb65 msg=a1b2c3d4-1111-2222-3333-444455556666",
    ],
  ])("proceeds when pending and reference is a %s", (_label, reference) => {
    const { code, out } = runGate("0063_something.sql (pending)", reference);
    expect(code).toBe(0);
    expect(out).toContain("proceeds-to-apply");
  });

  // The branch that actually fired on the 2026-08-10 deploy: nothing pending →
  // short-circuit before the shape check, so an unrelated deploy is never asked
  // for a handshake.
  it("short-circuits (no handshake required) when no migrations are pending", () => {
    const { code, out } = runGate("No migrations to apply!", "none");
    expect(code).toBe(0);
    expect(out).toContain("short-circuit");
  });
});

describe("migration handshake gate — structure holds", () => {
  // The gate step spans from its own name to the next step ("Apply Hands D1
  // migrations"). "Render production Wrangler config" comes BEFORE the gate, not
  // after — using it as the end boundary produced a backwards slice, which this
  // test's own structural check caught.
  const gateStep = workflow.slice(
    workflow.indexOf("Check who is watching a pending migration"),
    workflow.indexOf("Apply Hands D1 migrations"),
  );

  it("short-circuits on no-pending BEFORE the id-shape check", () => {
    // If the shape check ran first, a routine no-migration deploy would demand a
    // handshake it does not need.
    const shortCircuit = gateStep.indexOf("no migrations to apply");
    const shapeCheck = gateStep.indexOf("=~");
    expect(shortCircuit).toBeGreaterThanOrEqual(0);
    expect(shapeCheck).toBeGreaterThan(shortCircuit);
  });

  // Gogo's rule: every behaviour runGate asserts must be pinned on the ORIGINAL
  // workflow too, or the assertion is dangling — runGate is a reconstruction and
  // could keep exiting 1 while the real gate stopped doing so. runGate asserts
  // three exit behaviours; order is already pinned above, but the two exit CODES
  // were only in the reconstruction. Pin them to the real gate here.
  it("pins the short-circuit exit 0 on the real no-pending branch", () => {
    const scIdx = gateStep.indexOf("no migrations to apply");
    const exit0 = gateStep.indexOf("exit 0", scIdx);
    const shapeCheck = gateStep.indexOf("=~");
    expect(exit0).toBeGreaterThan(scIdx);
    expect(exit0).toBeLessThan(shapeCheck); // the short-circuit exits before the shape check
  });

  it("pins the reject exit 1 on the real branch, after the shape check", () => {
    const shapeCheck = gateStep.indexOf("=~");
    const exit1 = gateStep.indexOf("exit 1", shapeCheck);
    expect(shapeCheck).toBeGreaterThanOrEqual(0);
    expect(exit1).toBeGreaterThan(shapeCheck); // the reject branch really exits non-zero
  });

  it("states that canonical shape does not prove message existence", () => {
    expect(gateStep).toContain("verify against Raft, which this runner cannot reach");
    expect(gateStep).toContain("exists in that exact thread");
    expect(gateStep).toContain("only checked");
    expect(gateStep).toContain("reference shape");
  });

  it("places the gate BEFORE the apply step, so it can stop before apply", () => {
    const gateIdx = workflow.indexOf("Check who is watching a pending migration");
    const applyIdx = workflow.indexOf("Apply Hands D1 migrations");
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(applyIdx).toBeGreaterThan(gateIdx);
  });
});
