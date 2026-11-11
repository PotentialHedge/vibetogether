import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

/** One database, shared with Better Auth, whose tables are `user`, `account`, `login` and its plugins'. */
export const db = new DatabaseSync(config.database);

db.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA foreign_keys = ON;
`);

/** A new id, such as `s_…` for a session, hard to guess. */
export function newId(prefix: string): string {
	return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/** Runs `work` in one transaction. */
export function transaction<T>(work: () => T): T {
	db.exec("BEGIN");
	try {
		const result = work();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/** The backend's own tables, once Better Auth's exist, since they refer to its users and logins. */
export function createTables(): void {
	db.exec(`
		-- People, as equals. "person" is set only on a person's own group, which holds them alone
		-- and lives as long as they do.
		CREATE TABLE IF NOT EXISTS "group" (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			person TEXT UNIQUE REFERENCES user(id) ON DELETE CASCADE,
			created TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS group_member (
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			PRIMARY KEY ("group", user)
		);
		CREATE TABLE IF NOT EXISTS project (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			created TEXT NOT NULL
		);
		-- The GitHub repositories a project points at, as "owner/name", in the order given.
		CREATE TABLE IF NOT EXISTS project_repo (
			project TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
			position INTEGER NOT NULL,
			repo TEXT NOT NULL,
			PRIMARY KEY (project, position),
			UNIQUE (project, repo)
		);
		-- A project's session, or a DM, whose project is null and which a row of "dm" names.
		CREATE TABLE IF NOT EXISTS session (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			project TEXT REFERENCES project(id) ON DELETE CASCADE,
			creator TEXT REFERENCES user(id) ON DELETE SET NULL,
			created TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS session_of ON session (project);
		-- Two people's DM, one per pair, "a" the lesser id. It outlasts their friendship.
		CREATE TABLE IF NOT EXISTS dm (
			a TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			b TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			session TEXT NOT NULL UNIQUE REFERENCES session(id),
			PRIMARY KEY (a, b),
			CHECK (a < b)
		);
		CREATE TRIGGER IF NOT EXISTS dm_session AFTER DELETE ON dm
		BEGIN
			DELETE FROM session WHERE id = OLD.session;
		END;
		-- One row per side: "from" added "to". Two people are friends where both rows exist.
		CREATE TABLE IF NOT EXISTS friend (
			"from" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			"to" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			PRIMARY KEY ("from", "to")
		);

		-- A session's log. "sender" is the name it was sent under, kept as it was.
		-- "text" is the payload as text where it is short text, and "payload" the payload otherwise.
		CREATE TABLE IF NOT EXISTS entry (
			session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
			n INTEGER NOT NULL,
			time TEXT NOT NULL,
			sender TEXT NOT NULL,
			type TEXT NOT NULL,
			size INTEGER NOT NULL,
			filename TEXT,
			text TEXT,
			payload BLOB,
			PRIMARY KEY (session, n)
		) WITHOUT ROWID;
		-- A name in a session: the person, where "agent" is empty, or one of their agents.
		-- "inside" while joined; "entry" its last join or leave. "holder" is the login that holds
		-- an agent's name, null for the person, whose every login is theirs.
		-- "since" is when its last receive ended, or when it joined.
		CREATE TABLE IF NOT EXISTS participant (
			session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			agent TEXT NOT NULL,
			inside INTEGER NOT NULL,
			entry INTEGER NOT NULL,
			read INTEGER NOT NULL,
			since TEXT NOT NULL,
			holder TEXT,
			status TEXT,
			PRIMARY KEY (session, user, agent)
		);

		-- What an agent changed in its person's account, for the person to see.
		-- "login" and "agent" are the login's id and name as list_logins gives them, kept as they were.
		CREATE TABLE IF NOT EXISTS activity (
			id INTEGER PRIMARY KEY,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			login TEXT NOT NULL,
			agent TEXT NOT NULL,
			operation TEXT NOT NULL,
			arguments TEXT NOT NULL,
			created TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS activity_of ON activity (user, created);
		-- An invite to be friends, or to a project. "code" is its link, kept so that its maker
		-- sees it again; it works once.
		CREATE TABLE IF NOT EXISTS invite (
			code TEXT PRIMARY KEY,
			inviter TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			project TEXT REFERENCES project(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			expires TEXT NOT NULL,
			accepted_by TEXT REFERENCES user(id) ON DELETE CASCADE,
			accepted TEXT
		);
		-- When and from where an OTP was asked for, for the person to judge before approving it.
		CREATE TABLE IF NOT EXISTS otp_request (
			user_code TEXT PRIMARY KEY,
			requested TEXT NOT NULL,
			"from" TEXT NOT NULL
		);
	`);
}

/** Whether `a` and `b` are friends: each has added the other. */
export function areFriends(a: string, b: string): boolean {
	return (
		(
			db
				.prepare(
					`SELECT count(*) AS n FROM friend WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)`,
				)
				.get(a, b, b, a) as { n: number }
		).n === 2
	);
}

/** The session of the DM of `x` and `y`, made where it doesn't exist yet. */
export function dmOf(x: string, y: string): string {
	const [a, b] = x < y ? [x, y] : [y, x];
	const existing = db
		.prepare("SELECT session FROM dm WHERE a = ? AND b = ?")
		.get(a, b) as { session: string } | undefined;
	if (existing) return existing.session;
	return transaction(() => {
		const session = newId("s");
		db.prepare(
			"INSERT INTO session (id, name, created) VALUES (?, 'DM', ?)",
		).run(session, new Date().toISOString());
		db.prepare("INSERT INTO dm (a, b, session) VALUES (?, ?, ?)").run(
			a,
			b,
			session,
		);
		return session;
	});
}

/** The person's own group, made where it doesn't exist yet. */
export function ownGroupOf(user: string): string {
	const own = db.prepare(`SELECT id FROM "group" WHERE person = ?`).get(user) as
		| { id: string }
		| undefined;
	if (own) return own.id;
	const login = db.prepare("SELECT login FROM user WHERE id = ?").get(user) as
		| { login: string }
		| undefined;
	return transaction(() => {
		const id = newId("g");
		db.prepare(
			`INSERT INTO "group" (id, name, person, created) VALUES (?, ?, ?, ?)`,
		).run(id, login?.login ?? user, user, new Date().toISOString());
		db.prepare(`INSERT INTO group_member ("group", user) VALUES (?, ?)`).run(
			id,
			user,
		);
		return id;
	});
}

/** Whether `user` is in `group`. */
export function isMember(group: string, user: string): boolean {
	return (
		db
			.prepare(`SELECT 1 FROM group_member WHERE "group" = ? AND user = ?`)
			.get(group, user) !== undefined
	);
}

/** A session as access to it is decided: its project's group, or its DM's two people. */
export type SessionAccess = {
	id: string;
	name: string;
	project: string | null;
	group: string | null;
	a: string | null;
	b: string | null;
};

/** The session, where `user` takes part in it: a member of its group, or one of its DM's two friends. */
export function sessionFor(
	id: string,
	user: string,
): SessionAccess | undefined {
	const session = db
		.prepare(
			`SELECT s.id, s.name, s.project, p."group" AS "group", d.a, d.b FROM session s
			 LEFT JOIN project p ON p.id = s.project LEFT JOIN dm d ON d.session = s.id
			 WHERE s.id = ?`,
		)
		.get(id) as SessionAccess | undefined;
	if (!session) return undefined;
	if (session.group) return isMember(session.group, user) ? session : undefined;
	if (session.a && session.b && (session.a === user || session.b === user))
		return areFriends(session.a, session.b) ? session : undefined;
	return undefined;
}
