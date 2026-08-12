export type HandsObservabilityOverview = {
  measured_at: number;
  summary: { users: number; organizations: number; apps: number; active_apps: number; builds: number; releases: number };
  users_by_type: Array<{ type: string; count: number }>;
  apps_by_platform: Array<{ type: string; count: number }>;
  builds_by_product_type: Array<{ type: string; count: number }>;
  releases_by_status: Array<{ status: string; count: number }>;
  releases_by_week: Array<{ week: string; count: number }>;
  storage: {
    r2: { object_count: number; size_bytes: number };
    registered: { object_count: number; size_bytes: number };
    note: string;
  };
};

export interface HandsObservabilityService {
  getOverview(): Promise<HandsObservabilityOverview>;
}

export interface AdminWorkerEnv {
  HANDS_OBSERVABILITY: HandsObservabilityService;
  AUDIT_DB: D1Database;
  RAFT_ORIGIN: string;
  RAFT_API_ORIGIN: string;
  RAFT_CLIENT_ID: string;
  RAFT_CLIENT_SECRET: string;
  RAFT_ALLOWED_SERVER_IDS: string;
  SESSION_SECRET: string;
}
