import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(
  fileURLToPath(new URL(path, import.meta.url)),
  "utf8",
);

describe("admin user-facing copy", () => {
  it.each([
    ["./pages/Feedback.tsx", "POST /public/v2/apps/"],
    ["./pages/Errors.tsx", "captureException"],
    ["./components/ChangelogMarkdown.tsx", "Editor powered by @uiw/react-md-editor"],
    ["./pages/OrgSettings.tsx", "Worker Cron Trigger"],
    ["./pages/Settings.tsx", "The Worker owns the OAuth callback"],
    ["./pages/Settings.tsx", "Cloudflare Access can be disabled"],
    ["./components/ReleaseAssetUploader.tsx", "underlying R2 binary"],
    ["./pages/AppDetail.tsx", "all stored files in\n                R2"],
    ["./pages/AppDetail.tsx", "data in R2 is not removed"],
  ])("removes implementation detail %s: %s", (path, detail) => {
    expect(source(path)).not.toContain(detail);
  });

  it.each([
    ["./pages/Feedback.tsx", "Feedback and crash reports submitted from this app."],
    ["./pages/Errors.tsx", "A signature combines the type of error"],
    ["./pages/Errors.tsx", "error with where it happened in your code"],
    ["./components/ChangelogMarkdown.tsx", "Public preview supports paragraphs"],
    ["./pages/OrgSettings.tsx", "Pending deliveries are retried every 5 minutes."],
    ["./pages/Settings.tsx", "Access follows your Raft"],
    ["./components/ReleaseAssetUploader.tsx", "does not reclaim its"],
    ["./pages/AppDetail.tsx", "feedback tickets, and uploaded files"],
    ["./pages/AppDetail.tsx", "Archiving does not free up storage."],
  ])("keeps the user-visible outcome %s: %s", (path, outcome) => {
    expect(source(path).replace(/\s+/g, " ")).toContain(outcome);
  });
});
