export type CountByType = { type: string; count: number };
export type HandsObservabilityOverview = {
  measured_at: number;
  summary: { users: number; organizations: number; apps: number; active_apps: number; builds: number; releases: number };
  users_by_type: CountByType[];
  apps_by_platform: CountByType[];
  builds_by_product_type: CountByType[];
  releases_by_status: Array<{ status: string; count: number }>;
  releases_by_week: Array<{ week: string; count: number }>;
  storage: { r2: { object_count: number; size_bytes: number }; registered: { object_count: number; size_bytes: number }; note: string };
};

async function measureR2(bucket: R2Bucket) {
  let cursor: string | undefined, objectCount = 0, sizeBytes = 0;
  do {
    const page = await bucket.list(cursor ? { cursor, limit: 1000 } : { limit: 1000 });
    for (const object of page.objects) { objectCount += 1; sizeBytes += object.size; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { object_count: objectCount, size_bytes: sizeBytes };
}

export async function getHandsObservabilityOverview(env: Env): Promise<HandsObservabilityOverview> {
  const [summary, users, platforms, productTypes, statuses, weeks, registered, r2] = await Promise.all([
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM raft_accounts) AS users, (SELECT COUNT(*) FROM organizations WHERE archived = 0) AS organizations, (SELECT COUNT(*) FROM apps) AS apps, (SELECT COUNT(*) FROM apps WHERE archived = 0) AS active_apps, (SELECT COUNT(*) FROM builds) AS builds, (SELECT COUNT(*) FROM releases) AS releases`).first<HandsObservabilityOverview["summary"]>(),
    env.DB.prepare(`SELECT principal_type AS type, COUNT(*) AS count FROM raft_accounts GROUP BY principal_type ORDER BY count DESC, type ASC`).all<CountByType>(),
    env.DB.prepare(`SELECT platform AS type, COUNT(*) AS count FROM apps GROUP BY platform ORDER BY count DESC, type ASC`).all<CountByType>(),
    env.DB.prepare(`SELECT product_type AS type, COUNT(*) AS count FROM builds GROUP BY product_type ORDER BY count DESC, type ASC`).all<CountByType>(),
    env.DB.prepare(`SELECT status, COUNT(*) AS count FROM releases GROUP BY status ORDER BY count DESC, status ASC`).all<{ status: string; count: number }>(),
    env.DB.prepare(`SELECT strftime('%Y-%W', created_at / 1000, 'unixepoch') AS week, COUNT(*) AS count FROM releases WHERE created_at >= (strftime('%s', 'now', '-12 weeks') * 1000) GROUP BY week ORDER BY week ASC`).all<{ week: string; count: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS object_count, COALESCE(SUM(size_bytes), 0) AS size_bytes FROM (SELECT r2_key, MAX(size_bytes) AS size_bytes FROM (SELECT r2_key, size_bytes FROM build_assets UNION ALL SELECT r2_key, size_bytes FROM feedback_attachments) GROUP BY r2_key)`).first<{ object_count: number; size_bytes: number }>(),
    measureR2(env.APK_BUCKET),
  ]);
  return {
    measured_at: Date.now(),
    summary: summary ?? { users: 0, organizations: 0, apps: 0, active_apps: 0, builds: 0, releases: 0 },
    users_by_type: users.results, apps_by_platform: platforms.results, builds_by_product_type: productTypes.results,
    releases_by_status: statuses.results, releases_by_week: weeks.results,
    storage: { r2, registered: registered ?? { object_count: 0, size_bytes: 0 }, note: "R2 is measured from the bucket. Registered storage is deduplicated D1 metadata for build and feedback objects and can differ from R2." },
  };
}
