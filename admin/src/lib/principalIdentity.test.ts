import { describe, expect, it } from "vitest";
import {
  collidingPrincipalLabels,
  needsServerBadge,
  principalLabel,
  principalServer,
} from "./principalIdentity";

// Real shape from production: two accounts share display_name AND username
// but live on different Raft servers.
const diRenJieAndroid = {
  account_id: "d3b022aa-211c-447b-bca3-ed3428b15c8f",
  display_name: "DiRenJie",
  username: "DiRenJie",
  server_slug: "slock-android",
  server_id: "65598229-cd0a-4e92-96f3-c33e7e2e4cc1",
};
const diRenJieRaft = {
  account_id: "e3593fa9-b490-4384-aa34-36e7ad24bed7",
  display_name: "DiRenJie",
  username: "DiRenJie",
  server_slug: "raft",
  server_id: "bccd5969-5c94-498c-9221-625f87d5ca12",
};

describe("principalLabel", () => {
  it("prefers display name, then username, then a truncated subject", () => {
    expect(principalLabel({ display_name: "吉尔伽美什", username: "archer" })).toBe(
      "吉尔伽美什",
    );
    expect(
      principalLabel({ display_name: "  ", username: "archer" }),
    ).toBe("archer");
    expect(
      principalLabel({ provider_subject: "x".repeat(40) }),
    ).toBe(`${"x".repeat(16)}…`);
  });

  it("returns an empty label rather than the string 'undefined'", () => {
    expect(principalLabel({})).toBe("");
    expect(principalLabel({ display_name: null, username: null })).toBe("");
  });
});

describe("principalServer", () => {
  it("prefers the slug and falls back to the id", () => {
    expect(principalServer(diRenJieRaft)).toBe("raft");
    expect(principalServer({ server_id: "abc" })).toBe("abc");
    expect(principalServer({})).toBeNull();
  });
});

describe("collidingPrincipalLabels", () => {
  it("flags a label shared by two DIFFERENT accounts", () => {
    const colliding = collidingPrincipalLabels([
      diRenJieAndroid,
      diRenJieRaft,
    ]);
    expect(colliding.has("DiRenJie")).toBe(true);
    expect(needsServerBadge(diRenJieAndroid, colliding)).toBe(true);
    expect(needsServerBadge(diRenJieRaft, colliding)).toBe(true);
  });

  it("does not flag a unique name (current behaviour must not change)", () => {
    const colliding = collidingPrincipalLabels([
      { account_id: "a", display_name: "archer", server_slug: "botiverse" },
      { account_id: "b", display_name: "Gogo", server_slug: "botiverse" },
    ]);
    expect(colliding.size).toBe(0);
    expect(
      needsServerBadge({ display_name: "archer" }, colliding),
    ).toBe(false);
  });

  it("does not flag the SAME account listed twice", () => {
    // A duplicated row is a rendering artefact, not an identity collision;
    // badging both rows would imply two accounts exist.
    const colliding = collidingPrincipalLabels([
      diRenJieAndroid,
      diRenJieAndroid,
    ]);
    expect(colliding.size).toBe(0);
  });

  it("flags all members of a colliding group, not just the second one", () => {
    const third = {
      account_id: "c",
      display_name: "DiRenJie",
      server_slug: "third",
    };
    const colliding = collidingPrincipalLabels([
      diRenJieAndroid,
      diRenJieRaft,
      third,
    ]);
    expect(colliding.has("DiRenJie")).toBe(true);
    // Every member gets the badge, so the group reads consistently.
    for (const p of [diRenJieAndroid, diRenJieRaft, third]) {
      expect(needsServerBadge(p, colliding)).toBe(true);
    }
  });

  it("treats rows without ids as distinct (never merges them silently)", () => {
    const colliding = collidingPrincipalLabels([
      { display_name: "DiRenJie", server_slug: "a" },
      { display_name: "DiRenJie", server_slug: "b" },
    ]);
    expect(colliding.has("DiRenJie")).toBe(true);
  });

  it("ignores principals with no label at all", () => {
    const colliding = collidingPrincipalLabels([
      { account_id: "a" },
      { account_id: "b" },
    ]);
    expect(colliding.size).toBe(0);
  });
});

describe("pagination trap (why the set is computed for the whole collection)", () => {
  const gogo = {
    account_id: "z",
    display_name: "Gogo",
    server_slug: "botiverse",
  };
  const all = [diRenJieAndroid, diRenJieRaft, gogo];

  it("computing over the full collection badges both DiRenJie rows", () => {
    const colliding = collidingPrincipalLabels(all);
    expect(needsServerBadge(diRenJieAndroid, colliding)).toBe(true);
    expect(needsServerBadge(diRenJieRaft, colliding)).toBe(true);
  });

  it("computing over ONE PAGE would badge the visible row and not the other — the bug this guards", () => {
    // Page 1 contains only the android DiRenJie: no collision visible, so a
    // per-page computation labels nothing... and page 2 would label its row.
    // The user sees an unlabelled row then a labelled one: exactly the
    // inconsistency the per-collection rule exists to prevent.
    const page1Only = collidingPrincipalLabels([diRenJieAndroid]);
    expect(needsServerBadge(diRenJieAndroid, page1Only)).toBe(false);

    const page2Only = collidingPrincipalLabels([diRenJieRaft]);
    expect(needsServerBadge(diRenJieRaft, page2Only)).toBe(false);

    // Both pages disagree with the correct, collection-wide answer.
    const whole = collidingPrincipalLabels(all);
    expect(needsServerBadge(diRenJieAndroid, whole)).toBe(true);
    expect(needsServerBadge(diRenJieRaft, whole)).toBe(true);
  });
});
