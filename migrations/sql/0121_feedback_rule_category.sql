-- What kind of noise a feedback rule identifies. 'user_cleanup' marks a rule
-- whose matches are confirmed to be cleanup the user started (for example
-- Xiaomi's swipe-up clean from recents). The daily background system kill
-- summary lists those reports separately and leaves them out of its rates.
-- NULL: no category; matching reports are counted like any other.
ALTER TABLE feedback_rules ADD COLUMN category TEXT CHECK (category IS NULL OR category IN ('user_cleanup'));
