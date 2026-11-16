-- What wakes a participant in a session: every message ('all') or only one naming it ('mentions').
ALTER TABLE participant ADD COLUMN notify TEXT NOT NULL DEFAULT 'all';
