import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// A database in the schema production has before sessions were renamed from rooms (accounts 1418a33).
const database = join(
	mkdtempSync(join(tmpdir(), "vibetogether-accounts-")),
	"accounts.db",
);
const old = new DatabaseSync(database);
old.exec(`
	PRAGMA foreign_keys = ON;
	CREATE TABLE user (id TEXT PRIMARY KEY, login TEXT);
	CREATE TABLE session (id TEXT PRIMARY KEY, agent TEXT, person INTEGER);
	CREATE TABLE room (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		session TEXT UNIQUE,
		created TEXT NOT NULL
	, open TEXT NOT NULL DEFAULT 'members' CHECK (open IN ('members', 'link')));
	CREATE TABLE member (
		room TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
		user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		PRIMARY KEY (room, user)
	);
	CREATE TABLE friend (
		"from" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		"to" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		created TEXT NOT NULL,
		PRIMARY KEY ("from", "to")
	);
	CREATE TABLE device_request (
		user_code TEXT PRIMARY KEY,
		requested TEXT NOT NULL,
		"from" TEXT NOT NULL
	);
	INSERT INTO user VALUES ('a', 'a'), ('b', 'b');
	INSERT INTO room VALUES ('r_1', 'ben', 'a', 'secret1', '2026-11-09T00:00:00Z', 'members');
	INSERT INTO room VALUES ('r_2', 'open', 'a', 'secret2', '2026-11-09T00:00:00Z', 'link');
	INSERT INTO member VALUES ('r_1', 'b');
	INSERT INTO friend VALUES ('a', 'b', '2026-11-09T00:00:00Z');
`);
old.close();

Object.assign(process.env, {
	ACCOUNTS_URL: "http://localhost:3000",
	ACCOUNTS_DATABASE: database,
	ACCOUNTS_SECRET: "a-secret-for-tests-only-that-is-long-enough",
	GITHUB_CLIENT_ID: "test",
	GITHUB_CLIENT_SECRET: "test",
	AGENTWIRE_RELAY: "http://127.0.0.1:1",
});

test("each room becomes a session with the same address, its members' only, and friends stay", async () => {
	const { db, migrate } = await import("../src/db.ts");
	migrate();
	migrate();
	const rows = (sql: string) =>
		db
			.prepare(sql)
			.all()
			.map((r) => ({ ...r }));
	assert.deepEqual(rows("SELECT id, secret FROM owned_session ORDER BY id"), [
		{ id: "s_1", secret: "secret1" },
		{ id: "s_2", secret: "secret2" },
	]);
	// A room open by its link is its members' only from then on.
	assert.deepEqual(
		rows(
			"SELECT name FROM pragma_table_info('owned_session') WHERE name = 'open'",
		),
		[],
	);
	// s_1's owner and member make a group; s_2, the owner's alone, goes into the owner's own.
	assert.deepEqual(
		rows(
			`SELECT s.id, g.own, group_concat(m.user) AS people FROM owned_session s JOIN project p ON p.id = s.project
			 JOIN "group" g ON g.id = p."group" JOIN group_member m ON m."group" = g.id GROUP BY s.id ORDER BY s.id`,
		),
		[
			{ id: "s_1", own: 0, people: "a,b" },
			{ id: "s_2", own: 1, people: "a" },
		],
	);
	assert.deepEqual(rows('SELECT "from", "to" FROM friend'), [
		{ from: "a", to: "b" },
	]);
	assert.deepEqual(
		rows("SELECT name FROM sqlite_master WHERE name IN ('room', 'member')"),
		[],
	);
});
