-- Cancelling a release disables that lifecycle and releases its version
-- identity for a corrected upload. The cancelled release, build, assets, and
-- audit history remain immutable and addressable; only non-cancelled rows
-- reserve an app/channel/product/release-type/version coordinate.
--
-- Replacing the insert trigger is required because migration 0053 deliberately
-- reserved cancelled versions. The reactivation trigger closes the inverse
-- race: an old cancelled lifecycle cannot be restored while a replacement owns
-- the same version coordinate.

DROP TRIGGER IF EXISTS trg_releases_version_once_insert;

-- Cloudflare's remote D1 migration parser requires trigger bodies on one
-- physical line (workers-sdk#4998 / CFSQL-1402). Keep these compact.
CREATE TRIGGER IF NOT EXISTS trg_releases_version_once_insert BEFORE INSERT ON releases WHEN EXISTS (SELECT 1 FROM builds incoming JOIN releases existing ON existing.app_id = NEW.app_id AND existing.channel_id = NEW.channel_id AND existing.product_type = NEW.product_type AND existing.release_type = NEW.release_type JOIN builds existing_build ON existing_build.id = existing.build_id WHERE incoming.id = NEW.build_id AND incoming.app_id = NEW.app_id AND existing_build.version_code = incoming.version_code AND existing.status <> 'cancelled') BEGIN SELECT RAISE(ABORT, 'release version already exists'); END;

CREATE TRIGGER IF NOT EXISTS trg_releases_version_once_reactivate BEFORE UPDATE OF status ON releases WHEN OLD.status = 'cancelled' AND NEW.status <> 'cancelled' AND EXISTS (SELECT 1 FROM builds target_build JOIN releases existing ON existing.app_id = OLD.app_id AND existing.channel_id = OLD.channel_id AND existing.product_type = OLD.product_type AND existing.release_type = OLD.release_type AND existing.id <> OLD.id JOIN builds existing_build ON existing_build.id = existing.build_id WHERE target_build.id = OLD.build_id AND existing_build.version_code = target_build.version_code AND existing.status <> 'cancelled') BEGIN SELECT RAISE(ABORT, 'release version already exists'); END;
