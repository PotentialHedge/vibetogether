-- Apps: a login may be an app token, and an entry names the app a person's message came
-- through. SQLite changes a CHECK only by rebuilding the table, which nothing references.
CREATE TABLE login_new (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'agent', 'person', 'app')),
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created TEXT NOT NULL,
  expires TEXT
);
INSERT INTO login_new SELECT id, account, kind, name, token, created, expires FROM login;
DROP TABLE login;
ALTER TABLE login_new RENAME TO login;
CREATE INDEX login_of ON login (account);

ALTER TABLE entry ADD COLUMN app TEXT;
