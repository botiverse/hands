import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerFeedbackCommands } from "./feedback.js";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("../lib/api.js", () => ({ apiRequest }));

describe("feedback origin filtering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    apiRequest.mockReset();
  });

  it("requests the external view and labels its reports", async () => {
    apiRequest.mockResolvedValue({ tickets: [{
      id: "ticket", status: "open", kind: "crash", assignee: null,
      message: "external crash", version_name: "1", attachment_count: 0,
      comment_count: 0, build_origin: "external",
    }] });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerFeedbackCommands(program);
    await program.parseAsync(["node", "hands", "feedback", "list", "11111111-2222-3333-4444-555555555555", "--build-scope", "external"]);
    expect(apiRequest).toHaveBeenCalledWith("/api/apps/11111111-2222-3333-4444-555555555555/feedback?build_scope=external");
    expect(output).toHaveBeenCalledWith(expect.stringContaining("[external]"));
  });
});
