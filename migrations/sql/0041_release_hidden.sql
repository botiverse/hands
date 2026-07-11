-- Hide a release from the public history / release-notes surfaces without
-- deleting it. Superseded and cancelled releases can't be deleted (they are
-- part of the real release chain), but junk/duplicate old entries should not
-- clutter the public changelog. This flag is reversible.
ALTER TABLE releases ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
