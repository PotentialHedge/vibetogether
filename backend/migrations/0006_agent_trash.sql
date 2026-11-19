-- A deleted agent is in the trash as a group, project or session is: "archived" becomes
-- "trashed", and "archived_by" "trashed_by".
ALTER TABLE agent RENAME COLUMN archived TO trashed;
ALTER TABLE agent RENAME COLUMN archived_by TO trashed_by;
