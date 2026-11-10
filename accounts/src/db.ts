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
					open TEXT NOT NULL DEFAULT 'members' CHECK (open IN ('members', 'link')),
					app_grant TEXT
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
		-- People. "own" marks the owner's own group, which holds them alone and always exists.
		CREATE TABLE IF NOT EXISTS "group" (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			own INTEGER NOT NULL DEFAULT 0,
			created TEXT NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS group_own ON "group" (owner) WHERE own = 1;
		-- Everyone in a group, its owner included.
		CREATE TABLE IF NOT EXISTS group_member (
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			PRIMARY KEY ("group", user)
		);
		-- A group's named set of sessions. "app" is the app whose sessions it holds,
		-- by its client_id, in the person's own group: such a project holds that app's sessions alone.
		CREATE TABLE IF NOT EXISTS project (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			app TEXT,
			created TEXT NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS project_app ON project ("group", app) WHERE app IS NOT NULL;
		-- "secret" is the secret part of the session's address on the relay.
		-- "open" is who may join: its group's members only, or anyone with its address.
		-- "creator" is who created it, who with the group's owner may delete it.
		CREATE TABLE IF NOT EXISTS owned_session (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			project TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
			creator TEXT REFERENCES user(id) ON DELETE SET NULL,
			secret TEXT UNIQUE,
			created TEXT NOT NULL,
			open TEXT NOT NULL DEFAULT 'members' CHECK (open IN ('members', 'link')),
			-- The app's grant that owns the session, for the person, such as messagent's for a
			-- Telegram chat: the app manages it, and revoking the app ends it.
			-- A Better Auth session, which no foreign key names, since Better Auth makes its tables.
			app_grant TEXT
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
		-- Two friends' DM, one session per pair, "a" the lesser id. It is no group's: only the two
		-- and their agents join it, and only while they are friends. It outlasts their friendship,
		-- so that becoming friends again brings it back as it was.
		-- "secret" is the secret part of its address on the relay, as a session's.
		CREATE TABLE IF NOT EXISTS dm (
			id TEXT PRIMARY KEY,
			a TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			b TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			secret TEXT UNIQUE,
			created TEXT NOT NULL,
			UNIQUE (a, b),
			CHECK (a < b)
		);
	`);
	for (const { id } of db.prepare("SELECT id FROM user").all() as {
		id: string;
	}[])
		ownGroupOf(id);
	// Databases from before groups and projects, whose sessions each had an owner and members.
	if (hasColumn("owned_session", "owner")) intoGroups();
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

/** The id of the person's own group, made where it doesn't exist yet. */
export function ownGroupOf(user: string): string {
	const own = db
		.prepare(`SELECT id FROM "group" WHERE owner = ? AND own = 1`)
		.get(user) as { id: string } | undefined;
	if (own) return own.id;
	const id = newId("g");
	const login = db.prepare("SELECT login FROM user WHERE id = ?").get(user) as
		| { login: string }
		| undefined;
	db.prepare(
		`INSERT INTO "group" (id, name, owner, own, created) VALUES (?, ?, ?, 1, ?)`,
	).run(id, login?.login ?? user, user, new Date().toISOString());
	db.prepare(`INSERT INTO group_member ("group", user) VALUES (?, ?)`).run(
		id,
		user,
	);
	return id;
}

/** The id of the project of `app`, by its client_id, in the person's own group, made where it doesn't exist yet. */
export function appProjectOf(user: string, app: string): string {
	const group = ownGroupOf(user);
	const project = db
		.prepare(`SELECT id FROM project WHERE "group" = ? AND app = ?`)
		.get(group, app) as { id: string } | undefined;
	if (project) return project.id;
	const id = newId("p");
	db.prepare(
		`INSERT INTO project (id, name, "group", app, created) VALUES (?, ?, ?, ?, ?)`,
	).run(id, app, group, app, new Date().toISOString());
	return id;
}

/**
 * Moves every session into a project, keeping exactly who may join it: one of the owner's
 * alone into the owner's own group, one with members into a group of exactly its owner and its
 * members, owned by its owner and shared by every session with the same people, and an app's into
 * its app's project. Each session but an app's gets a project of its own, named after it.
 * Its owner becomes its creator.
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
				if (session.app)
					moved.push({
						...session,
						project: appProjectOf(session.owner, session.app),
					});
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
						`INSERT INTO "group" (id, name, owner, created) VALUES (?, ?, ?, ?)`,
					).run(group, session.name, session.owner, now);
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

/** Whether `user` is in `group`, its owner included. */
export function isMember(group: string, user: string): boolean {
	return (
		db
			.prepare(`SELECT 1 FROM group_member WHERE "group" = ? AND user = ?`)
			.get(group, user) !== undefined
	);
}
