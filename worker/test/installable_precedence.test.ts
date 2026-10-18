import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  INSTALLABLE_ORDER_BY,
  installableRank,
  selectInstallable,
} from "../src/lib/installable_precedence";

// Real production rows from raft-ohos release 42d1dc1d (1.14.1 / 11401004).
// The `.app` row was inserted 18 seconds BEFORE the `.hap` row, which is why
// the old `ORDER BY ba.filetype = 'apk' DESC, ba.created_at ASC` served the
// AppGallery bundle from a sideload-style link.
const appgalleryApp = {
  filetype: "app",
  variant: "appgallery",
  distribution: "appgallery",
  created_at: 1792354092533,
};
const sideloadHap = {
  filetype: "hap",
  variant: "sideload",
  distribution: "sideload",
  created_at: 1792354110652,
};

describe("installableRank", () => {
  it("keeps Android's apk preference first (behaviour must not change)", () => {
    expect(installableRank({ filetype: "apk" })).toBe(0);
    expect(installableRank({ filetype: "apk" })).toBeLessThan(
      installableRank(sideloadHap),
    );
  });

  it("ranks the OHOS sideload hap above the AppGallery app", () => {
    expect(installableRank(sideloadHap)).toBeLessThan(
      installableRank(appgalleryApp),
    );
  });

  it("places ipa between the sideload artefacts and the OHOS store bundle", () => {
    expect(installableRank({ filetype: "ipa" })).toBe(2);
    expect(installableRank({ filetype: "ipa" })).toBeGreaterThan(
      installableRank(sideloadHap),
    );
    expect(installableRank({ filetype: "ipa" })).toBeLessThan(
      installableRank(appgalleryApp),
    );
  });

  it("treats an `app` row whose distribution says sideload as a sideload artefact", () => {
    expect(installableRank({ filetype: "app", distribution: "sideload" })).toBe(1);
  });

  it("falls back to variant when metadata has no distribution", () => {
    expect(installableRank({ filetype: "app", variant: "sideload" })).toBe(1);
  });
});

describe("selectInstallable", () => {
  it("picks the hap over the app even though the app is older", () => {
    expect(
      selectInstallable([appgalleryApp, sideloadHap]),
    ).toBe(sideloadHap);
    // Order-independent.
    expect(
      selectInstallable([sideloadHap, appgalleryApp]),
    ).toBe(sideloadHap);
  });

  it("still serves an app when it is the only installable (no over-correction)", () => {
    expect(selectInstallable([appgalleryApp])).toBe(appgalleryApp);
  });

  it("prefers apk among Android artefacts regardless of creation order", () => {
    const older = { filetype: "aab", created_at: 1 };
    const newer = { filetype: "apk", created_at: 2 };
    expect(selectInstallable([older, newer])).toBe(newer);
  });

  it("returns null for an empty list", () => {
    expect(selectInstallable([])).toBeNull();
  });

  it("breaks ties by oldest creation, then input order", () => {
    const a = { filetype: "hap", created_at: 10 };
    const b = { filetype: "hap", created_at: 5 };
    expect(selectInstallable([a, b])).toBe(b);
    const c = { filetype: "hap", created_at: 7 };
    const d = { filetype: "hap", created_at: 7 };
    expect(selectInstallable([c, d])).toBe(c);
  });
});

/**
 * The SQL expression and the JS helper are two encodings of the same rule; if
 * they drifted, the query sites (which use SQL) would silently disagree with
 * any caller using the JS helper. Execute the real SQL against a real SQLite
 * database and assert both orders agree.
 */
describe("INSTALLABLE_ORDER_BY agrees with selectInstallable", () => {
  it("orders the production OHOS fixture identically", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE build_assets (
      id TEXT PRIMARY KEY,
      filetype TEXT NOT NULL,
      variant TEXT,
      metadata_json TEXT,
      created_at INTEGER
    )`);
    const insert = db.prepare(
      "INSERT INTO build_assets (id, filetype, variant, metadata_json, created_at) VALUES (?,?,?,?,?)",
    );
    insert.run(
      "app-row",
      "app",
      "appgallery",
      JSON.stringify({ distribution: "appgallery" }),
      appgalleryApp.created_at,
    );
    insert.run(
      "hap-row",
      "hap",
      "sideload",
      JSON.stringify({ distribution: "sideload" }),
      sideloadHap.created_at,
    );

    const rows = db
      .prepare(
        `SELECT id, filetype, variant, json_extract(metadata_json,'$.distribution') AS distribution, created_at
         FROM build_assets ba ORDER BY ${INSTALLABLE_ORDER_BY}`,
      )
      .all() as Array<{
      id: string;
      filetype: string;
      variant: string | null;
      distribution: string | null;
      created_at: number;
    }>;

    const sqlBest = rows[0];
    const jsBest = selectInstallable(
      rows.map((r) => ({ ...r, distribution: r.distribution, created_at: r.created_at })),
    );

    expect(sqlBest?.id).toBe("hap-row");
    expect(jsBest?.filetype).toBe(sqlBest?.filetype);
    expect(rows.map((r) => r.id)).toEqual(["hap-row", "app-row"]);
  });

  it("agrees across a mixed set containing every ranked filetype", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE build_assets (
      id TEXT PRIMARY KEY, filetype TEXT NOT NULL, variant TEXT, metadata_json TEXT, created_at INTEGER
    )`);
    const insert = db.prepare(
      "INSERT INTO build_assets (id, filetype, variant, metadata_json, created_at) VALUES (?,?,?,?,?)",
    );
    const fixtures = [
      { id: "app", filetype: "app", variant: "appgallery", distribution: "appgallery", created_at: 1 },
      { id: "hap", filetype: "hap", variant: "sideload", distribution: "sideload", created_at: 9 },
      { id: "ipa", filetype: "ipa", variant: null, distribution: null, created_at: 2 },
      { id: "apk", filetype: "apk", variant: null, distribution: null, created_at: 8 },
      { id: "other", filetype: "zip", variant: null, distribution: null, created_at: 3 },
    ];
    for (const f of fixtures) {
      insert.run(
        f.id,
        f.filetype,
        f.variant,
        JSON.stringify({ distribution: f.distribution }),
        f.created_at,
      );
    }
    const rows = db
      .prepare(
        `SELECT id, filetype, variant, json_extract(metadata_json,'$.distribution') AS distribution, created_at
         FROM build_assets ba ORDER BY ${INSTALLABLE_ORDER_BY}`,
      )
      .all() as Array<{ id: string; filetype: string; distribution: string | null; created_at: number }>;

    expect(rows.map((r) => r.id)).toEqual(["apk", "hap", "ipa", "app", "other"]);
    expect(selectInstallable(rows)?.id).toBe(rows[0]?.id);
  });
});
