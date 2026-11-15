-- Vibe Together's schema. Times are ISO 8601 in UTC with milliseconds, so they compare as text.

-- A person, signed in with GitHub, keyed by the GitHub user id, which never changes. "login" is
-- their GitHub login in lower case, which a rename on GitHub changes at their next sign-in.
CREATE TABLE account (
  id TEXT PRIMARY KEY,
  github INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  image TEXT,
  created TEXT NOT NULL
);

-- One credential of an account: a browser's sign-in, or a token of its kind. "token" is the
-- SHA-256 of the secret, base64url, so the database holds no secret. "expires" is when a
-- sign-in ends unless it is used; a token lasts until it is revoked.
CREATE TABLE login (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'agent', 'person')),
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created TEXT NOT NULL,
  expires TEXT
);
CREATE INDEX login_of ON login (account);

-- People, as equals. "person" is set only on a person's own group, which holds them alone and
-- lives as long as they do.
CREATE TABLE "group" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  person TEXT UNIQUE REFERENCES account(id) ON DELETE CASCADE,
  created TEXT NOT NULL
);
CREATE TABLE group_member (
  "group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
  account TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  PRIMARY KEY ("group", account)
);
CREATE INDEX group_member_of ON group_member (account);

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
  created TEXT NOT NULL
);
-- The GitHub repositories a project points at, as "owner/name", in the order given.
CREATE TABLE project_repo (
  project TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  repo TEXT NOT NULL,
  PRIMARY KEY (project, position),
  UNIQUE (project, repo)
);

-- A project's session, or one in no project: a group's own, which a row of "group_session"
-- names, or a DM, which a row of "dm" names.
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project TEXT REFERENCES project(id) ON DELETE CASCADE,
  creator TEXT REFERENCES account(id) ON DELETE SET NULL,
  created TEXT NOT NULL
);
CREATE INDEX session_of ON session (project);
-- A session of a group's own. "general" marks the one every group has, made with it and
-- deleted only with it.
CREATE TABLE group_session (
  session TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  "group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
  general INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX group_session_of ON group_session ("group");
CREATE UNIQUE INDEX general_of ON group_session ("group") WHERE general = 1;
CREATE TRIGGER group_session_gone AFTER DELETE ON group_session
BEGIN
  DELETE FROM session WHERE id = OLD.session;
END;
-- Two people's DM, one per pair, "a" the lesser id. It outlasts their friendship.
CREATE TABLE dm (
  a TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  b TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  session TEXT NOT NULL UNIQUE REFERENCES session(id),
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE TRIGGER dm_gone AFTER DELETE ON dm
BEGIN
  DELETE FROM session WHERE id = OLD.session;
END;
-- One row per side: "from" added "to". Two people are friends where both rows exist.
CREATE TABLE friend (
  "from" TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  "to" TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  created TEXT NOT NULL,
  PRIMARY KEY ("from", "to")
);

-- A session's log. "sender" is the name it was sent under, kept as it was, and "participant" the
-- sender's id, which outlasts a rename; null for Vibe Together's own. "text" is the payload where
-- it is short text, and "payload" the payload otherwise.
CREATE TABLE entry (
  session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  time TEXT NOT NULL,
  sender TEXT NOT NULL,
  participant TEXT,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  filename TEXT,
  text TEXT,
  payload BLOB,
  PRIMARY KEY (session, n)
) WITHOUT ROWID;

-- An agent of a person: "name" is its part below theirs, unique among their agents that are not
-- archived. "holder" is the login that holds it, since it is one mind at a time, and "seen" when
-- that login last acted as it. "archived" is when it said it won't come back.
CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  holder TEXT,
  seen TEXT,
  archived TEXT,
  created TEXT NOT NULL
);
CREATE UNIQUE INDEX agent_name ON agent (account, name) WHERE archived IS NULL;

-- A participant's status, by its id: a person's account id, or an agent's.
CREATE TABLE status (
  participant TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  text TEXT NOT NULL
);

-- A participant in a session, by its id, with its person ("account"). "inside" while joined;
-- "entry" its last join or leave; "received" and "read" the last entries of the session it
-- received and read, from its stream; "since" when its last receive ended, or when it joined.
CREATE TABLE participant (
  session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  account TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  inside INTEGER NOT NULL,
  entry INTEGER NOT NULL,
  received INTEGER NOT NULL,
  read INTEGER NOT NULL,
  since TEXT NOT NULL,
  PRIMARY KEY (session, id)
);
CREATE INDEX participant_by ON participant (id);

-- Each participant's stream: its last item's number, and its received and read positions.
CREATE TABLE stream_head (
  participant TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  last INTEGER NOT NULL,
  received INTEGER NOT NULL,
  read INTEGER NOT NULL
);
-- A stream's unread items, each pointing at its session's entry, with why it reached the
-- participant ("reach": ping, fyi or session). An item goes once read, or after a week.
CREATE TABLE stream (
  participant TEXT NOT NULL REFERENCES stream_head(participant) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  entry INTEGER NOT NULL,
  reach TEXT NOT NULL,
  created TEXT NOT NULL,
  PRIMARY KEY (participant, n)
) WITHOUT ROWID;
CREATE INDEX stream_age ON stream (created);
CREATE INDEX stream_session ON stream (session);

-- What a token changed in its person's account, for the person to see. "login" and "name" are
-- the login's id and name, kept as they were, and "agent" the id of the agent it acted as.
CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  agent TEXT,
  operation TEXT NOT NULL,
  arguments TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX activity_of ON activity (account, created);

-- An invite to be friends, and to a group where "group" is set, landing in "session" where set,
-- else the group's general. "code" is its link, kept so that its maker sees it again; it works
-- once.
CREATE TABLE invite (
  code TEXT PRIMARY KEY,
  inviter TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  "group" TEXT REFERENCES "group"(id) ON DELETE CASCADE,
  session TEXT REFERENCES session(id) ON DELETE SET NULL,
  created TEXT NOT NULL,
  expires TEXT NOT NULL,
  accepted_by TEXT REFERENCES account(id) ON DELETE CASCADE,
  accepted TEXT
);
