/**
 * Unit tests for the legacy proxy shim's path classifier.
 *
 * The shim reverse-proxies machine/API paths (never redirects — POST bodies
 * would be dropped) and 302-redirects human pages. The subtle cases are the
 * `/share/:token` page (redirect) vs its `/download|/unlock|/icon` sub-resources
 * (proxy), and `/apps/:slug/history*` (proxy) vs the bare `/apps/:slug` admin
 * SPA route (redirect).
 */

import { describe, it, expect } from "vitest";
import { isMachinePath } from "../src/proxy-shim";

describe("proxy-shim isMachinePath", () => {
  it("proxies public API paths (update-check + POST endpoints)", () => {
    for (const p of [
      "/public/v2/apps/raft-android/latest",
      "/public/v2/apps/raft-android/updates/check",
      "/public/v2/apps/raft-android/feedback",
      "/public/v2/apps/raft-android/minidump",
      "/public/v2/apps/raft-android/devices",
      "/public/v2/apps/raft-android/metrics",
      "/public/v2/apps/raft-android/feedback/presign",
      "/public/apps/raft-android/icon",
      "/public/r2/some-key",
    ]) {
      expect(isMachinePath(p), p).toBe(true);
    }
  });

  it("proxies admin/auth API, electron assets, manifests, health", () => {
    for (const p of [
      "/api/auth/me",
      "/api/orgs",
      "/api/invites/abc",
      "/electron/raft-desktop/main/latest.yml",
      "/.well-known/raft-agent-manifest.json",
      "/health",
      "/openapi.json",
      "/login/raft/callback",
    ]) {
      expect(isMachinePath(p), p).toBe(true);
    }
  });

  it("proxies /share sub-resources but redirects the /share page", () => {
    expect(isMachinePath("/share/TOKEN123/download")).toBe(true);
    expect(isMachinePath("/share/TOKEN123/unlock")).toBe(true);
    expect(isMachinePath("/share/TOKEN123/icon")).toBe(true);
    // bare share page -> human -> redirect
    expect(isMachinePath("/share/TOKEN123")).toBe(false);
  });

  it("proxies /apps history JSON + download, redirects bare SPA route", () => {
    expect(isMachinePath("/apps/raft-android/history")).toBe(true);
    expect(isMachinePath("/apps/raft-android/history/rel-id/download")).toBe(true);
    expect(isMachinePath("/apps/raft-android/latest")).toBe(true);
    expect(isMachinePath("/apps/raft-android/latest/download")).toBe(true);
    // bare admin SPA route -> human -> redirect
    expect(isMachinePath("/apps/raft-android")).toBe(false);
  });

  it("redirects human pages", () => {
    for (const p of [
      "/",
      "/docs",
      "/docs.md",
      "/docs/android-sdk/",
      "/notes/raft-android",
      "/api-docs",
      "/assets/index-abc123.js",
      "/favicon.ico",
    ]) {
      expect(isMachinePath(p), p).toBe(false);
    }
  });
});
