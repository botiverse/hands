import { describe, expect, it } from "vitest";
import {
  DEFAULT_HANDS_ENDPOINT,
  METRICS_STATE_FILENAME,
  buildSubmitURL,
} from "../src/common.js";

describe("Hands Electron migration contracts", () => {
  it("uses the Hands production origin by default", () => {
    expect(DEFAULT_HANDS_ENDPOINT).toBe("https://hands.build");
    expect(buildSubmitURL({ appSlug: "raft", clientKey: "public-key" })).toBe(
      "https://hands.build/public/v2/apps/raft/minidump?client_key=public-key",
    );
  });

  it("honors an explicit endpoint without a duplicate trailing slash", () => {
    expect(
      buildSubmitURL({
        appSlug: "raft desktop",
        clientKey: "public/key",
        endpoint: "https://preview.hands.build/",
      }),
    ).toBe(
      "https://preview.hands.build/public/v2/apps/raft%20desktop/minidump?client_key=public%2Fkey",
    );
  });

  it("preserves the legacy metrics state filename", () => {
    expect(METRICS_STATE_FILENAME).toBe("quiver-metrics.json");
  });
});
