import { describe, expect, it, vi } from "vitest";
import { readR2WithRetry } from "../src/lib/r2_read_retry";

describe("R2 read retry", () => {
  it("retries 10001 and logs only the operation and attempts after succeeding", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("head: We encountered an internal error. Please try again. (10001)"))
      .mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(readR2WithRetry("head", read, { delays: [1, 2], sleep })).resolves.toBe("ok");
    expect(read).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
    expect(info).toHaveBeenCalledWith(
      "r2_read_retry_succeeded",
      JSON.stringify({ operation: "head", attempts: 2 }),
    );
    expect(info.mock.calls.flat().join(" ")).not.toContain("10001");
  });

  it("retries another 5xx status", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("storage unavailable"), { status: 503 }))
      .mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(readR2WithRetry("get", read, { delays: [1], sleep })).resolves.toBe("ok");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not retry 404 or other 4xx", async () => {
    for (const status of [400, 404, 409, 422]) {
      const read = vi.fn().mockRejectedValue(Object.assign(new Error("refused"), { status }));
      const sleep = vi.fn().mockResolvedValue(undefined);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});

      await expect(readR2WithRetry("get", read, { delays: [1, 2], sleep })).rejects.toThrow("refused");
      expect(read).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    }
  });

  it("stops after two retries and does not log success on failure", async () => {
    const read = vi.fn().mockRejectedValue(new Error("get: We encountered an internal error. (10001)"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(readR2WithRetry("get", read, { delays: [1, 2], sleep })).rejects.toThrow("10001");
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1, 2]);
    expect(info).not.toHaveBeenCalled();
  });

  it("does not retry an arbitrary client or programming error", async () => {
    const read = vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(readR2WithRetry("get", read, { delays: [1], sleep })).rejects.toThrow(TypeError);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
