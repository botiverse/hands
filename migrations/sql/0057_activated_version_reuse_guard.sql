-- Once a release has been activated (shipped to clients), its version
-- coordinate is permanently bound to that build's binary. Migration 0056
-- released every cancelled coordinate for reuse; that silently allowed two
-- different binaries to ship under one version coordinate, which breaks the
-- version_code leg of the binary/build/symbols identity binding (crash
-- symbolication selects symbol assets by version_code; Android retrace has no
-- build-id check and would produce silently wrong stacks).
--
-- New rule, both directions:
--   * never-activated cancelled coordinates remain reusable (0056 intent:
--     a wrong upload that never shipped can be corrected under the same
--     version);
--   * a cancelled release with activated_at set blocks any OTHER build from
--     taking the coordinate — on insert and on un-cancel of a different
--     release — while re-releasing the SAME build (identical binary) stays
--     allowed.
--
-- Cloudflare's remote D1 migration parser requires trigger bodies on one
-- physical line (workers-sdk#4998 / CFSQL-1402). Keep these compact.

DROP TRIGGER IF EXISTS trg_releases_version_once_insert;
DROP TRIGGER IF EXISTS trg_releases_version_once_reactivate;

CREATE TRIGGER IF NOT EXISTS trg_releases_version_once_insert BEFORE INSERT ON releases WHEN EXISTS (SELECT 1 FROM builds incoming JOIN releases existing ON existing.app_id = NEW.app_id AND existing.channel_id = NEW.channel_id AND existing.product_type = NEW.product_type AND existing.release_type = NEW.release_type JOIN builds existing_build ON existing_build.id = existing.build_id WHERE incoming.id = NEW.build_id AND incoming.app_id = NEW.app_id AND existing_build.version_code = incoming.version_code AND (existing.status <> 'cancelled' OR (existing.activated_at IS NOT NULL AND existing.build_id <> NEW.build_id))) BEGIN SELECT RAISE(ABORT, 'release version already exists'); END;

CREATE TRIGGER IF NOT EXISTS trg_releases_version_once_reactivate BEFORE UPDATE OF status ON releases WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled' AND EXISTS (SELECT 1 FROM builds target_build JOIN releases existing ON existing.app_id = OLD.app_id AND existing.channel_id = OLD.channel_id AND existing.product_type = OLD.product_type AND existing.release_type = OLD.release_type AND existing.id <> OLD.id JOIN builds existing_build ON existing_build.id = existing.build_id WHERE target_build.id = OLD.build_id AND existing_build.version_code = target_build.version_code AND (existing.status <> 'cancelled' OR (existing.activated_at IS NOT NULL AND existing.build_id <> OLD.build_id))) BEGIN SELECT RAISE(ABORT, 'release version already exists'); END;
