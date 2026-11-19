-- The other servers an owner is on, each with the person token this server keeps for it
-- (`servers`): only a server with an owner keeps them. "login" is the token's login there.
CREATE TABLE server (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  login TEXT NOT NULL,
  added TEXT NOT NULL,
  UNIQUE (account, url)
);
