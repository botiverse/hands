import { apiRequest, QuiverApiError } from "./api.js";

/**
 * Hands lets only a person create an already-active release; agents and
 * deploy tokens create a draft and publish it (the server answers
 * AGENT_ACTIVE_RELEASE_FORBIDDEN otherwise). The publish commands create the
 * release last, after every upload, so without this check a non-human caller
 * uploads the whole build before learning it should have passed --draft.
 *
 * Asks the server who is calling before anything is uploaded. A signed-in
 * human passes. An agent session, a deploy token (which /api/auth/me does not
 * recognise) or an expired session stops here. If the question itself cannot
 * be answered (network or server error), the command carries on and the
 * server still enforces the rule.
 */
export async function assertActiveReleaseAllowed(
  draft: boolean | undefined,
  request: typeof apiRequest = apiRequest,
): Promise<void> {
  if (draft) return;
  let principal: string | null = null;
  try {
    const me = await request<{ account?: { principal_type?: string } }>("/api/auth/me");
    principal = me.account?.principal_type ?? null;
  } catch (error) {
    if (!(error instanceof QuiverApiError) || error.status !== 401) return;
  }
  if (principal === "human") return;
  throw new Error(
    "Only a person can create an active release; agents and deploy tokens create drafts. " +
      "Re-run with --draft, then publish the draft with `hands releases publish`. " +
      "Nothing has been uploaded." +
      (principal === null ? " (If you are a person, your session may have expired: run `hands login`.)" : ""),
  );
}
