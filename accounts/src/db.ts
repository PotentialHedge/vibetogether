import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

/** One database, shared with Better Auth, whose tables are its own. */
export const db = new DatabaseSync(config.database);

db.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA foreign_keys = ON;
`);

function hasColumn(table: string, column: string): boolean {
	return (
		db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as {
			name: string;
		}[]
	).some((c) => c.name === column);
}

function hasTable(table: string): boolean {
	return (
		db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(table) !== undefined
	);
}

/**
 * The tables of owned sessions and friends, which refer to Better Auth's users.
 * Better Auth's own `session` is a sign-in, so an account's session is an `owned_session`.
 */
export function migrate(): void {
	// Databases from before a room could be open by link, and before friends had no setting.
	if (hasTable("room") && !hasColumn("room", "open"))
		db.exec(
			"ALTER TABLE room ADD COLUMN open TEXT NOT NULL DEFAULT 'members' CHECK (open IN ('members', 'link'))",
		);
	if (hasTable("friend") && hasColumn("friend", "agents"))
		db.exec("ALTER TABLE friend DROP COLUMN agents");
	// Databases from before an app could own a session.
	if (hasTable("owned_session") && !hasColumn("owned_session", "app_grant"))
		db.exec("ALTER TABLE owned_session ADD COLUMN app_grant TEXT");
	// Databases from before an app could act as its person.
	if (hasTable("device_request") && !hasColumn("device_request", "person"))
		db.exec(`
			ALTER TABLE device_request ADD COLUMN device_code TEXT;
			ALTER TABLE device_request ADD COLUMN person INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE device_request ADD COLUMN claim TEXT;
		`);
	db.exec(`
		-- "secret" is the secret part of the session's address on the relay.
		-- "open" is who may join: its members only, or anyone with its address.
		CREATE TABLE IF NOT EXISTS owned_session (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			secret TEXT UNIQUE,
			created TEXT NOT NULL,
			open TEXT NOT NULL DEFAULT 'members' CHECK (open IN ('members', 'link')),
			-- The app's grant that owns the session, for the person, such as messagent's for a
			-- Telegram chat: the app manages it, and revoking the app ends it.
			-- A Better Auth session, which no foreign key names, since Better Auth makes its tables.
			app_grant TEXT
		);
		CREATE TABLE IF NOT EXISTS session_member (
			session TEXT NOT NULL REFERENCES owned_session(id) ON DELETE CASCADE,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			PRIMARY KEY (session, user)
		);
		-- Who asked for an OTP, for the person to judge before approving it.
		-- "device_code" is the SHA-256 of the OTP's device code, by which its token is made.
		-- "person" is whether an app asked to act as the person, and "claim" what it says it is for.
		CREATE TABLE IF NOT EXISTS device_request (
			user_code TEXT PRIMARY KEY,
			requested TEXT NOT NULL,
			"from" TEXT NOT NULL,
			device_code TEXT,
			person INTEGER NOT NULL DEFAULT 0,
			claim TEXT
		);
		-- One row per side: "from" added "to". Two people are friends where both rows exist.
		CREATE TABLE IF NOT EXISTS friend (
			"from" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			"to" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			PRIMARY KEY ("from", "to")
		);
	`);
	// Databases from before Vibe Together said session for room: the rows move over, their ids
	// from r_ to s_, and the secret in each address stays, so that every address still works.
	if (hasTable("room")) {
		db.exec("BEGIN");
		try {
			db.exec(`
				INSERT INTO owned_session (id, name, owner, secret, created, open)
					SELECT 's_' || substr(id, 3), name, owner, session, created, open FROM room;
				INSERT INTO session_member (session, user)
					SELECT 's_' || substr(room, 3), user FROM member;
				DROP TABLE member;
				DROP TABLE room;
			`);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
}
