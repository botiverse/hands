ALTER TABLE build_assets
  ADD COLUMN artifact_kind TEXT NOT NULL DEFAULT 'installable';

