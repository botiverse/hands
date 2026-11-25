-- Channel scope for feature flags: a JSON array of channel slugs; empty = all
-- channels. Lets delta_updates offer patches on some release channels (e.g.
-- alpha, preview) while others (main) stay off. Existing rows keep '[]', so
-- behaviour is unchanged until a flag lists channels.
ALTER TABLE feature_flags ADD COLUMN channels TEXT NOT NULL DEFAULT '[]';
