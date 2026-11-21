// A universal APK is registered without an ABI. Asking for its delta sources
// with an empty arch must look up the APKs that also have no ABI.
import { describe, expect, it } from "vitest";
import { handleDeltaSources } from "../src/routes/delta";

async function boundArch(query: Record<string, string | undefined>): Promise<unknown> {
  let bound: unknown[] = [];
  const c = {
    env: {
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => {
            bound = args;
            return { all: async () => ({ results: [] }) };
          },
        }),
      },
    },
    req: {
      url: "https://hands.test/api/apps/app-1/delta-sources",
      param: () => "app-1",
      query: (name: string) => query[name],
      header: () => undefined,
    },
    json: (data: unknown, status = 200) => Response.json(data, { status }),
  };
  const res = await handleDeltaSources(c as never);
  expect(res.status).toBe(200);
  return bound[1];
}

describe("delta-sources arch", () => {
  it("treats an empty or missing arch as no ABI", async () => {
    expect(await boundArch({ arch: "", before: "100" })).toBeNull();
    expect(await boundArch({ arch: "  ", before: "100" })).toBeNull();
    expect(await boundArch({ before: "100" })).toBeNull();
  });

  it("keeps an explicit ABI", async () => {
    expect(await boundArch({ arch: "arm64-v8a", before: "100" })).toBe("arm64-v8a");
  });
});
