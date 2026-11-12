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

  it("points at the TestFlight commands when there are no tickets, but keeps --json clean", async () => {
    apiRequest.mockImplementation(async (path: string) =>
      path === "/api/apps"
        ? { apps: [{ id: "11111111-2222-3333-4444-555555555555", slug: "ferry-ios" }] }
        : { tickets: [] });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerFeedbackCommands(program);
    await program.parseAsync(["node", "hands", "feedback", "list", "ferry-ios"]);
    const text = output.mock.calls.map((call) => String(call[0])).join("\n");
    expect(text).toContain("No tickets.");
    expect(text).toContain("hands testflight crashes ferry-ios");
    expect(text).toContain("hands testflight feedback ferry-ios");

    output.mockClear();
    const jsonProgram = new Command();
    registerFeedbackCommands(jsonProgram);
    await jsonProgram.parseAsync(["node", "hands", "feedback", "list", "11111111-2222-3333-4444-555555555555", "--json"]);
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({ tickets: [] });
  });

  it("filters by crash_type and labels non-exception crash types", async () => {
    apiRequest.mockResolvedValue({ tickets: [{
      id: "ticket-kill", status: "open", kind: "crash", assignee: null,
      message: "System kill: other", version_name: "1.22.0", attachment_count: 1,
      comment_count: 0, crash_type: "system_kill",
    }] });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerFeedbackCommands(program);
    await program.parseAsync([
      "node", "hands", "feedback", "list",
      "11111111-2222-3333-4444-555555555555",
      "--kind", "crash", "--crash-type", "system_kill",
    ]);
    expect(apiRequest).toHaveBeenCalledWith(
      "/api/apps/11111111-2222-3333-4444-555555555555/feedback?kind=crash&crash_type=system_kill",
    );
    expect(output).toHaveBeenCalledWith(expect.stringContaining("[system_kill]"));
  });

  it("filters by signature, device_id, and version_code and tags background_system_kill", async () => {
    apiRequest.mockResolvedValue({ tickets: [{
      id: "ticket-bg-kill", status: "closed", kind: "crash", assignee: null,
      message: "System kill: other", version_name: "1.22.0", attachment_count: 1,
      comment_count: 0, crash_type: "system_kill", background_system_kill: 1,
    }] });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerFeedbackCommands(program);
    await program.parseAsync([
      "node", "hands", "feedback", "list",
      "11111111-2222-3333-4444-555555555555",
      "--signature", "SystemKill@background",
      "--device-id", "dev-123",
      "--version-code", "1022000",
    ]);
    expect(apiRequest).toHaveBeenCalledWith(
      "/api/apps/11111111-2222-3333-4444-555555555555/feedback?signature=SystemKill%40background&device_id=dev-123&version_code=1022000",
    );
    expect(output).toHaveBeenCalledWith(expect.stringContaining("[background_system_kill]"));
  });

  it("passes closure_reason and duplicate_of_ticket_id on feedback update", async () => {
    apiRequest.mockResolvedValue({
      id: "a14fc3a1-cad6-4830-828a-29dd14e84ee1",
      status: "closed",
      closure_reason: "not_planned",
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerFeedbackCommands(program);
    await program.parseAsync([
      "node", "hands", "feedback", "update",
      "11111111-2222-3333-4444-555555555555",
      "a14fc3a1",
      "--status", "closed",
      "--closure-reason", "not_planned",
    ]);
    expect(apiRequest).toHaveBeenCalledWith(
      "/api/apps/11111111-2222-3333-4444-555555555555/feedback/a14fc3a1",
      {
        method: "PATCH",
        body: { status: "closed", closure_reason: "not_planned" },
      },
    );
    expect(output).toHaveBeenCalledWith("Updated ticket a14fc3a1.");
  });

  it("infers closed status and duplicate closure_reason when --duplicate-of is passed", async () => {
    apiRequest.mockResolvedValue({
      id: "40eb8cea-bfd4-4fed-b79a-c06f996e5ad8",
      status: "closed",
      closure_reason: "duplicate",
      duplicate_of_ticket_id: "a14fc3a1-cad6-4830-828a-29dd14e84ee1",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerFeedbackCommands(program);
    await program.parseAsync([
      "node", "hands", "feedback", "update",
      "11111111-2222-3333-4444-555555555555",
      "40eb8cea",
      "--duplicate-of", "a14fc3a1",
    ]);
    expect(apiRequest).toHaveBeenCalledWith(
      "/api/apps/11111111-2222-3333-4444-555555555555/feedback/40eb8cea",
      {
        method: "PATCH",
        body: {
          status: "closed",
          closure_reason: "duplicate",
          duplicate_of_ticket_id: "a14fc3a1",
        },
      },
    );
  });
});
