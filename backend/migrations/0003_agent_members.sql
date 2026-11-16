-- A group's members are people and agents: "member" is a person's account id or an agent's id,
-- and "account" the person, themselves or the agent's. An agent is in its person's own group
-- from its creation, and in another only while its person is.
CREATE TABLE group_member_new (
  "group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
  member TEXT NOT NULL,
  account TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  PRIMARY KEY ("group", member)
);
INSERT INTO group_member_new ("group", member, account)
  SELECT "group", account, account FROM group_member;
DROP TABLE group_member;
ALTER TABLE group_member_new RENAME TO group_member;
CREATE INDEX group_member_of ON group_member (member);
CREATE INDEX group_member_account ON group_member (account);

-- Every agent is in its person's own group.
INSERT INTO group_member ("group", member, account)
  SELECT g.id, ag.id, ag.account FROM agent ag JOIN "group" g ON g.person = ag.account;

-- An agent that is not archived is in every group of a session it took part in, where its person
-- still is, so that the work going on keeps going.
INSERT OR IGNORE INTO group_member ("group", member, account)
  SELECT DISTINCT coalesce(p."group", gs."group"), ag.id, ag.account
  FROM participant pa JOIN agent ag ON ag.id = pa.id AND ag.archived IS NULL
  JOIN session s ON s.id = pa.session LEFT JOIN project p ON p.id = s.project
  LEFT JOIN group_session gs ON gs.session = s.id
  WHERE coalesce(p."group", gs."group") IS NOT NULL
  AND EXISTS (SELECT 1 FROM group_member m
    WHERE m."group" = coalesce(p."group", gs."group") AND m.member = ag.account);

-- A DM holds its two people alone.
UPDATE participant SET inside = 0
  WHERE id IN (SELECT id FROM agent) AND session IN (SELECT session FROM dm);
