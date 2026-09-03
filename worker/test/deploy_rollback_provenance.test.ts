import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Provenance guards for deploy-hands-server.yml (task #190).
 *
 * Measured on production run 33790593239 (2026-09-03, exact 42f3ae12):
 * one protected deploy produced TEN Cloudflare versions — one `wrangler deploy`
 * plus one per `wrangler secret put` (9 secrets). Two consequences, both of which
 * make a receipt read correctly while pointing at the wrong thing:
 *
 *   1. The run printed `Current Version ID: cd3f5f6d…` from the deploy step, but
 *      the terminal live version was `c8cbb03b…` — created 23s later by the last
 *      secret put. Anyone recording the deploy step's id records a version that
 *      was never the live one.
 *   2. /deployments returns ten entries, so this single run filled it end to end
 *      and evicted the pre-run live version. `deployments[1]` therefore points at
 *      another version of the SAME run, not at the previous release. Rolling back
 *      to it would be a no-op that looks like a rollback.
 *
 * These are ordering/sourcing properties of the workflow, so they are asserted
 * against the real file rather than a copy: a step that moves re-binds the test.
 */

const workflowPath = resolve(
  __dirname,
  "../../.github/workflows/deploy-hands-server.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

/** Index of a top-level step by its `- name:` line. -1 when absent. */
function stepIndex(name: string): number {
  const re = new RegExp(`^      - name: ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const m = workflow.match(re);
  return m?.index ?? -1;
}

const ANCHOR_STEP = "Capture pre-deploy rollback anchor";
const DEPLOY_STEP = "Deploy Hands Worker and admin assets";
const SECRETS_STEP = "Configure Hands Worker secrets";
const TERMINAL_STEP = "Read back the terminal live version";

describe("deploy rollback provenance", () => {
  it("captures a rollback anchor before the first Worker write", () => {
    const anchor = stepIndex(ANCHOR_STEP);
    const deploy = stepIndex(DEPLOY_STEP);
    expect(anchor, `missing step: ${ANCHOR_STEP}`).toBeGreaterThan(-1);
    expect(deploy, `missing step: ${DEPLOY_STEP}`).toBeGreaterThan(-1);
    // Strictly before: after the deploy the pre-run version is already one
    // eviction closer to falling out of /deployments.
    expect(anchor).toBeLessThan(deploy);
  });

  it("reads the terminal live version AFTER the secret puts, not from the deploy step", () => {
    const secrets = stepIndex(SECRETS_STEP);
    const terminal = stepIndex(TERMINAL_STEP);
    expect(secrets, `missing step: ${SECRETS_STEP}`).toBeGreaterThan(-1);
    expect(terminal, `missing step: ${TERMINAL_STEP}`).toBeGreaterThan(-1);
    expect(terminal).toBeGreaterThan(secrets);
  });

  it("never infers a rollback target from a /deployments index", () => {
    // deployments[1] is the specific trap: it reads like "the previous release"
    // and is another version of the same run.
    expect(workflow).not.toMatch(/deployments\[\s*1\s*\]/);
  });

  it("proves the captured anchor is durable by checking it against /versions", () => {
    const body = workflow.slice(stepIndex(ANCHOR_STEP), stepIndex(DEPLOY_STEP));
    // Deliberately NOT a bare /versions match: the string also appears in the
    // step's own prose, so a mention would satisfy it while the actual check was
    // gone. Mutation M2 (delete the durability block, keep the wording) passed a
    // bare match and is the reason these assert executable text.
    expect(body, "anchor step must actually fetch /versions").toMatch(
      /curl[^\n]*\$\{api\}\/versions/,
    );
    expect(body, "anchor must fail closed when absent from /versions").toMatch(
      /absent from \/versions/,
    );
  });

  it("fails closed when the anchor cannot be read", () => {
    const body = workflow.slice(stepIndex(ANCHOR_STEP), stepIndex(DEPLOY_STEP));
    // An unreadable anchor must stop the deploy, not proceed unanchored.
    expect(body).toMatch(/exit 1/);
  });
});
