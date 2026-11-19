-- The trash: a group, project or session deleted is marked "trashed", when, and "trashed_by",
-- by whom as they were named then, and shows to no one but in the trash, until it is restored
-- or purged 30 days after. An archived agent is in the trash the same way: "archived_by" names
-- who archived it.
ALTER TABLE "group" ADD COLUMN trashed TEXT;
ALTER TABLE "group" ADD COLUMN trashed_by TEXT;
ALTER TABLE project ADD COLUMN trashed TEXT;
ALTER TABLE project ADD COLUMN trashed_by TEXT;
ALTER TABLE session ADD COLUMN trashed TEXT;
ALTER TABLE session ADD COLUMN trashed_by TEXT;
ALTER TABLE agent ADD COLUMN archived_by TEXT;
