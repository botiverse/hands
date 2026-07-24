-- One release lifecycle per app/channel/product/release-type/version.
--
-- Historical rows are retained, including legacy duplicates. The triggers
-- reject every new duplicate by joining through builds.version_code and make
-- both sides of the identity immutable after release creation, so the
-- invariant covers API, admin, CI, and any future direct writer.
-- activated_at lets rollback reactivate the original release row without
-- cloning it merely to make it the newest resolver candidate.

ALTER TABLE releases ADD COLUMN activated_at INTEGER;

UPDATE releases
SET activated_at = CASE
  WHEN status = 'draft' THEN NULL
  ELSE COALESCE(updated_at, created_at)
END;

CREATE INDEX IF NOT EXISTS idx_builds_release_identity
  ON builds(app_id, channel_id, product_type, release_type, version_code);

CREATE INDEX IF NOT EXISTS idx_releases_activation
  ON releases(app_id, channel_id, product_type, release_type, status, activated_at DESC);

-- Cloudflare's remote D1 migration parser requires trigger bodies on one
-- physical line (workers-sdk#4998 / CFSQL-1402). Keep these compact.
CREATE TRIGGER IF NOT EXISTS trg_releases_version_once_insert BEFORE INSERT ON releases WHEN EXISTS (SELECT 1 FROM builds incoming JOIN releases existing ON existing.app_id = NEW.app_id AND existing.channel_id = NEW.channel_id AND existing.product_type = NEW.product_type AND existing.release_type = NEW.release_type JOIN builds existing_build ON existing_build.id = existing.build_id WHERE incoming.id = NEW.build_id AND incoming.app_id = NEW.app_id AND existing_build.version_code = incoming.version_code) BEGIN SELECT RAISE(ABORT, 'release version already exists'); END;

CREATE TRIGGER IF NOT EXISTS trg_releases_identity_immutable_update BEFORE UPDATE OF app_id, build_id, channel_id, product_type, release_type ON releases WHEN NEW.app_id <> OLD.app_id OR NEW.build_id <> OLD.build_id OR NEW.channel_id <> OLD.channel_id OR NEW.product_type <> OLD.product_type OR NEW.release_type <> OLD.release_type BEGIN SELECT RAISE(ABORT, 'release identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_released_build_identity_immutable_update BEFORE UPDATE OF app_id, channel_id, product_type, release_type, version_code ON builds WHEN EXISTS (SELECT 1 FROM releases target WHERE target.build_id = OLD.id) AND (NEW.app_id <> OLD.app_id OR NEW.channel_id <> OLD.channel_id OR NEW.product_type <> OLD.product_type OR NEW.release_type <> OLD.release_type OR NEW.version_code <> OLD.version_code) BEGIN SELECT RAISE(ABORT, 'released build identity is immutable'); END;
