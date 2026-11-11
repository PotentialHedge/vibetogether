import { randomBytes } from "node:crypto";
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

/** A new id, such as `s_…` for a session, hard to guess. */
export function newId(prefix: string): string {
	return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/**
 * The service's own tables, which refer to Better Auth's users: groups, their projects, and the
 * projects' sessions, and friends. Better Auth's own `session` is a sign-in, so an
 * account's session is an `owned_session`.
 */
export function migrate(): void {
	// Databases from before a room could be open by link, and before friends had no setting.
	if (hasTable("room") && !hasColumn("room", "open"))
		db.exec(
			"ALTER TABLE room ADD COLUMN open TEXT NOT NULL DEFAULT 'members' CHECK (open IN ('members', 'link'))",
		);
	if (hasTable("friend") && hasColumn("friend", "agents"))
		db.exec("ALTER TABLE friend DROP COLUMN agents");
	// Databases from before bridges: an OTP lasts 15 minutes, so the ones asked for go.
	if (hasTable("device_request") && !hasColumn("device_request", "bridge"))
		db.exec("DROP TABLE device_request");
	// Databases from before Vibe Together said session for room: the rows move over, their ids
	// from r_ to s_, and the secret in each address stays, so that every address still works.
	// They move into sessions with members of their own, which become groups below.
	if (hasTable("room")) {
		db.exec("BEGIN");
		try {
			db.exec(`
				CREATE TABLE IF NOT EXISTS owned_session (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
					secret TEXT UNIQUE,
					created TEXT NOT NULL,
					open TEXT NOT NULL DEFAULT 'members' CHECK (open IN ('members', 'link'))
				);
				CREATE TABLE IF NOT EXISTS session_member (
					session TEXT NOT NULL REFERENCES owned_session(id) ON DELETE CASCADE,
					user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
					PRIMARY KEY (session, user)
				);
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
	db.exec(`
		-- People, as equals: a group has no owner, Luis's decision (2026-11-10, "let's go flat").
		-- "person" is set only on a person's own group, which holds them alone and lives as long as they do.
		CREATE TABLE IF NOT EXISTS "group" (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			person TEXT UNIQUE REFERENCES user(id) ON DELETE CASCADE,
			created TEXT NOT NULL
		);
		-- Everyone in a group.
		CREATE TABLE IF NOT EXISTS group_member (
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			PRIMARY KEY ("group", user)
		);
		-- A group's named set of sessions.
		CREATE TABLE IF NOT EXISTS project (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			created TEXT NOT NULL
		);
		-- The GitHub repositories a project points at, where its context lives, as "owner/name",
		-- in the order given: a pointer only, which grants no access.
		CREATE TABLE IF NOT EXISTS project_repo (
			project TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
			position INTEGER NOT NULL,
			repo TEXT NOT NULL,
			PRIMARY KEY (project, position),
			UNIQUE (project, repo)
		);
		-- "secret" is the secret part of the session's address on the relay.
		-- Only its group's members and their agents join it.
		-- "creator" is who created it.
		CREATE TABLE IF NOT EXISTS owned_session (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			project TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
			creator TEXT REFERENCES user(id) ON DELETE SET NULL,
			secret TEXT UNIQUE,
			created TEXT NOT NULL
		);
		-- Who asked for an OTP, for the person to judge before approving it.
		-- "device_code" is the SHA-256 of the OTP's device code, by which its token is made.
		-- "bridge" is the bridge that asked to be added to a session, by its client_id, "claim"
		-- what it says it bridges, and "session" the session the person picked as they approved.
		-- "identity" is the sender's account on the bridge's messenger, such as a Telegram id, where
		-- the chat is theirs alone, which approving links to the person; "identity_name" its name there.
		CREATE TABLE IF NOT EXISTS device_request (
			user_code TEXT PRIMARY KEY,
			requested TEXT NOT NULL,
			"from" TEXT NOT NULL,
			device_code TEXT,
			bridge TEXT,
			claim TEXT,
			identity TEXT,
			identity_name TEXT,
			session TEXT
		);
		-- A person's account on a bridge's messenger, linked to theirs by an OTP they approved, so
		-- that the bridge carries what they write there as them. "external" is its id there, such as
		-- a Telegram id, and "name" what it was called as it was linked. It is one person's.
		CREATE TABLE IF NOT EXISTS identity (
			id TEXT PRIMARY KEY,
			bridge TEXT NOT NULL,
			external TEXT NOT NULL,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			created TEXT NOT NULL,
			UNIQUE (bridge, external)
		);
		-- What a bridge says of the room it bridges, such as a Telegram group and how many are in
		-- it, which its session's info shows: a bridge is no participant, so it says nothing in the
		-- session itself. "session" is the bridge's, Better Auth's session row of its credential.
		CREATE TABLE IF NOT EXISTS bridge_room (
			session TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
			about TEXT NOT NULL
		);
		-- One row per side: "from" added "to". Two people are friends where both rows exist.
		CREATE TABLE IF NOT EXISTS friend (
			"from" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			"to" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			PRIMARY KEY ("from", "to")
		);
		-- Two friends' DM, one session per pair, "a" the lesser id. It is no group's: only the two
		-- and their agents join it, and only while they are friends. It outlasts their friendship,
		-- so that becoming friends again brings it back as it was.
		-- "secret" is the secret part of its address on the relay, as a session's.
		-- Which token minted a machine's token, as its credential ("b_<session>" or "o_<grant>"):
		-- revoking a token revokes those it minted, so that a stolen one is cut off with its copies.
		-- A token approved or minted in the browser has no row.
		CREATE TABLE IF NOT EXISTS minted (
			session TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
			by TEXT NOT NULL
		);
		-- What an agent changed in its person's account, by an operation's id and its arguments,
		-- for the person to see, and by which the limits per hour count.
		-- "token" and "agent" are the token's id and name as /api/tokens gives them, kept as they were.
		CREATE TABLE IF NOT EXISTS activity (
			id INTEGER PRIMARY KEY,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			token TEXT NOT NULL,
			agent TEXT NOT NULL,
			operation TEXT NOT NULL,
			arguments TEXT NOT NULL,
			created TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS activity_of ON activity (user, created);
		CREATE TABLE IF NOT EXISTS dm (
			id TEXT PRIMARY KEY,
			a TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			b TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			secret TEXT UNIQUE,
			created TEXT NOT NULL,
			UNIQUE (a, b),
			CHECK (a < b)
		);

		-- "code" is the invite's link, short and hard to guess, kept as it is so that its maker
		-- sees it again. "project" is null for an invite to be friends. "accepted_by" is who
		-- accepted it, once someone has: it is single-use.
		CREATE TABLE IF NOT EXISTS invite (
			code TEXT PRIMARY KEY,
			inviter TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			project TEXT REFERENCES project(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			expires TEXT NOT NULL,
			accepted_by TEXT REFERENCES user(id) ON DELETE CASCADE,
			accepted TEXT
		);
		-- An OTP a person made for their agent, by the SHA-256 of its code, until it is used.
		CREATE TABLE IF NOT EXISTS person_otp (
			code TEXT PRIMARY KEY,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			expires TEXT NOT NULL
		);
	`);
	// Databases from before groups were flat, whose groups each had an owner.
	if (hasColumn("group", "owner")) flattenGroups();
	for (const { id } of db.prepare("SELECT id FROM user").all() as {
		id: string;
	}[])
		ownGroupOf(id);
	// Databases from before groups and projects, whose sessions each had an owner and members.
	// Such a database may be from before apps too, whose columns it gets for the step below.
	if (hasColumn("owned_session", "owner")) {
		if (!hasColumn("owned_session", "app_grant"))
			db.exec("ALTER TABLE owned_session ADD COLUMN app_grant TEXT");
		if (!hasColumn("session", "person"))
			db.exec("ALTER TABLE session ADD COLUMN person INTEGER");
		intoGroups();
	}
	// Databases from before a session kept who created it.
	if (!hasColumn("owned_session", "creator"))
		db.exec(
			"ALTER TABLE owned_session ADD COLUMN creator TEXT REFERENCES user(id) ON DELETE SET NULL",
		);
	// Databases from before DMs: friends from then on have theirs.
	for (const { a, b } of db
		.prepare(
			`SELECT f."from" AS a, f."to" AS b FROM friend f
			 JOIN friend r ON r."from" = f."to" AND r."to" = f."from" WHERE f."from" < f."to"`,
		)
		.all() as { a: string; b: string }[])
		dmOf(a, b);
	// Databases from before every session was its group's members' only, Luis's decision
	// (2026-11-10): a session open to anyone with its address is its members' only from then on.
	if (hasColumn("owned_session", "open"))
		db.exec("ALTER TABLE owned_session DROP COLUMN open");
	// Databases from before bridges, which replaced apps, Luis's decisions (2026-11-10):
	// an app's grants go, and a session an app owned stays an ordinary session of its project,
	// as one whose grant had already ended had already gone.
	if (hasColumn("owned_session", "app_grant") || hasColumn("session", "person"))
		withoutApps();
	// A bridge goes with its session, and with its person's membership in the session's group.
	// Triggers, since a session goes by a cascade too, such as with its project or group.
	db.exec(`
		CREATE TRIGGER IF NOT EXISTS bridge_with_session AFTER DELETE ON owned_session
		BEGIN
			DELETE FROM session WHERE bridge = OLD.id;
		END;
		CREATE TRIGGER IF NOT EXISTS bridge_with_member AFTER DELETE ON group_member
		BEGIN
			DELETE FROM session WHERE userId = OLD.user AND bridge IN (
				SELECT s.id FROM owned_session s JOIN project p ON p.id = s.project
				WHERE p."group" = OLD."group"
			);
		END;
	`);
}

/** Takes out what was of apps: their grants, and their mark on sessions and projects. */
function withoutApps(): void {
	db.exec("BEGIN");
	try {
		const person = hasColumn("session", "person");
		if (hasColumn("owned_session", "app_grant")) {
			db.exec(
				`DELETE FROM owned_session WHERE app_grant IS NOT NULL AND app_grant NOT IN (${
					person ? "SELECT id FROM session WHERE person = 1" : "SELECT NULL"
				})`,
			);
			db.exec("ALTER TABLE owned_session DROP COLUMN app_grant");
		}
		if (hasColumn("project", "app"))
			db.exec(`
				DROP INDEX IF EXISTS project_app;
				ALTER TABLE project DROP COLUMN app;
			`);
		if (person)
			db.exec(`
				DELETE FROM session WHERE person = 1;
				ALTER TABLE session DROP COLUMN person;
			`);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
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

/** The id of the DM of `x` and `y`, made where it doesn't exist yet, without an address until it is listed. */
export function dmOf(x: string, y: string): string {
	const [a, b] = x < y ? [x, y] : [y, x];
	db.prepare(
		"INSERT OR IGNORE INTO dm (id, a, b, created) VALUES (?, ?, ?, ?)",
	).run(newId("s"), a, b, new Date().toISOString());
	return (
		db.prepare("SELECT id FROM dm WHERE a = ? AND b = ?").get(a, b) as {
			id: string;
		}
	).id;
}

/**
 * Rebuilds `group` without its owner, which SQLite can't drop as it is a foreign key: an own group
 * keeps its person, and every other group, its members alone.
 */
function flattenGroups(): void {
	db.exec("PRAGMA foreign_keys = OFF");
	db.exec("BEGIN");
	try {
		db.exec(`
			CREATE TABLE group_flat (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				person TEXT UNIQUE REFERENCES user(id) ON DELETE CASCADE,
				created TEXT NOT NULL
			);
			INSERT INTO group_flat (id, name, person, created)
				SELECT id, name, CASE WHEN own = 1 THEN owner END, created FROM "group";
			DROP TABLE "group";
			ALTER TABLE group_flat RENAME TO "group";
		`);
		const broken = db.prepare("PRAGMA foreign_key_check").all();
		if (broken.length)
			throw new Error(
				`flattening groups broke references: ${JSON.stringify(broken)}`,
			);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	} finally {
		db.exec("PRAGMA foreign_keys = ON");
	}
}

/** The id of the person's own group, made where it doesn't exist yet. */
export function ownGroupOf(user: string): string {
	const own = db.prepare(`SELECT id FROM "group" WHERE person = ?`).get(user) as
		| { id: string }
		| undefined;
	if (own) return own.id;
	const id = newId("g");
	const login = db.prepare("SELECT login FROM user WHERE id = ?").get(user) as
		| { login: string }
		| undefined;
	db.prepare(
		`INSERT INTO "group" (id, name, person, created) VALUES (?, ?, ?, ?)`,
	).run(id, login?.login ?? user, user, new Date().toISOString());
	db.prepare(`INSERT INTO group_member ("group", user) VALUES (?, ?)`).run(
		id,
		user,
	);
	return id;
}

/**
 * Moves every session into a project, keeping exactly who may join it: one of the owner's
 * alone into the owner's own group, one with members into a group of exactly its owner and its
 * members, shared by every session with the same people, and an app's into a project of the
 * owner's own group named after the app. Each session but an app's gets a project of its own,
 * named after it. Its owner becomes its creator.
 * A session of an app whose grant is gone was already ended, and goes.
 */
function intoGroups(): void {
	type Old = {
		id: string;
		name: string;
		owner: string;
		secret: string | null;
		created: string;
		open: string;
		app_grant: string | null;
		app: string | null;
	};
	db.exec("PRAGMA foreign_keys = OFF");
	db.exec("BEGIN");
	try {
		const sessions = db
			.prepare(
				`SELECT s.*, g.agent AS app FROM owned_session s
				 LEFT JOIN session g ON g.id = s.app_grant AND g.person = 1
				 ORDER BY s.created, s.id`,
			)
			.all() as Old[];
		const groups = new Map<string, string>();
		const appProjects = new Map<string, string>();
		const moved: (Old & { project: string })[] = [];
		const now = new Date().toISOString();
		const newProject = (group: string, name: string) => {
			const id = newId("p");
			db.prepare(
				`INSERT INTO project (id, name, "group", created) VALUES (?, ?, ?, ?)`,
			).run(id, name, group, now);
			return id;
		};
		for (const session of sessions) {
			if (session.app_grant) {
				if (session.app) {
					const key = JSON.stringify([session.owner, session.app]);
					const project =
						appProjects.get(key) ??
						newProject(ownGroupOf(session.owner), session.app);
					appProjects.set(key, project);
					moved.push({ ...session, project });
				}
				continue;
			}
			const members = (
				db
					.prepare(
						"SELECT user FROM session_member WHERE session = ? AND user != ? ORDER BY user",
					)
					.all(session.id, session.owner) as { user: string }[]
			).map((m) => m.user);
			let group: string;
			if (members.length === 0) group = ownGroupOf(session.owner);
			else {
				const key = JSON.stringify([session.owner, ...members]);
				const existing = groups.get(key);
				if (existing) group = existing;
				else {
					group = newId("g");
					db.prepare(
						`INSERT INTO "group" (id, name, created) VALUES (?, ?, ?)`,
					).run(group, session.name, now);
					for (const user of [session.owner, ...members])
						db.prepare(
							`INSERT INTO group_member ("group", user) VALUES (?, ?)`,
						).run(group, user);
					groups.set(key, group);
				}
			}
			moved.push({ ...session, project: newProject(group, session.name) });
		}
		db.exec(`
			CREATE TABLE owned_session_grouped (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				project TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
				creator TEXT REFERENCES user(id) ON DELETE SET NULL,
				secret TEXT UNIQUE,
				created TEXT NOT NULL,
				open TEXT NOT NULL DEFAULT 'members' CHECK (open IN ('members', 'link')),
				app_grant TEXT
			);
		`);
		for (const s of moved)
			db.prepare(
				"INSERT INTO owned_session_grouped (id, name, project, creator, secret, created, open, app_grant) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(
				s.id,
				s.name,
				s.project,
				s.owner,
				s.secret,
				s.created,
				s.open,
				s.app_grant,
			);
		db.exec(`
			DROP TABLE session_member;
			DROP TABLE owned_session;
			ALTER TABLE owned_session_grouped RENAME TO owned_session;
		`);
		const broken = db.prepare("PRAGMA foreign_key_check").all();
		if (broken.length)
			throw new Error(
				`moving sessions into groups broke references: ${JSON.stringify(broken)}`,
			);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	} finally {
		db.exec("PRAGMA foreign_keys = ON");
	}
}

/** Whether `user` is in `group`. */
export function isMember(group: string, user: string): boolean {
	return (
		db
			.prepare(`SELECT 1 FROM group_member WHERE "group" = ? AND user = ?`)
			.get(group, user) !== undefined
	);
}
