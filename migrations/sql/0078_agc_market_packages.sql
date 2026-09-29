-- Formal package uploads are separate from invitation-test submissions.
CREATE TABLE agc_market_packages (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploading','processing','ready','failed')),
  external_app_id TEXT,
  external_package_id TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(app_id, build_id)
);
