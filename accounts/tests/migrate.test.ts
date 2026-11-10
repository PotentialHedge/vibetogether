import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// A database as production's was before rooms had `open` and friends lost their setting (accounts a7dcf2a).
const database = join(
	mkdtempSync(join(tmpdir(), "vibetogether-accounts-")),
	"accounts.db",
);
const old = new DatabaseSync(database);
old.exec(`
	CREATE TABLE user (id TEXT PRIMARY KEY, login TEXT);
	CREATE TABLE session (id TEXT PRIMARY KEY, agent TEXT, person INTEGER);
	CREATE TABLE room (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		session TEXT UNIQUE,
		created TEXT NOT NULL
	);
	CREATE TABLE friend (
		"from" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		"to" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		agents TEXT NOT NULL CHECK (agents IN ('ping', 'fyi')),
		created TEXT NOT NULL,
		PRIMARY KEY ("from", "to")
	);
	INSERT INTO user VALUES ('a', 'a'), ('b', 'b');
	INSERT INTO room VALUES ('r_1', 'ben', 'a', 'secret', '2026-11-09T00:00:00Z');
	CREATE TABLE member (
		room TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
		user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		PRIMARY KEY (room, user)
	);
	INSERT INTO member VALUES ('r_1', 'b');
	INSERT INTO friend VALUES ('a', 'b', 'ping', '2026-11-09T00:00:00Z');
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

test("an existing room becomes a session with the same address, open to its members only, and friends keep each other", async () => {
	const { db, migrate } = await import("../src/db.ts");
	migrate();
	migrate();
	assert.deepEqual(
		db
			.prepare("SELECT id, secret, open FROM owned_session")
			.all()
			.map((r) => ({ ...r })),
		[{ id: "s_1", secret: "secret", open: "members" }],
	);
	// Its members and its owner make a group, which the owner owns.
	assert.deepEqual(
		db
			.prepare(
				`SELECT g.owner, g.name, m.user FROM owned_session s JOIN project p ON p.id = s.project
				 JOIN "group" g ON g.id = p."group" JOIN group_member m ON m."group" = g.id ORDER BY m.user`,
			)
			.all()
			.map((r) => ({ ...r })),
		[
			{ owner: "a", name: "ben", user: "a" },
			{ owner: "a", name: "ben", user: "b" },
		],
	);
	assert.equal(
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE name IN ('room', 'member')",
			)
			.get(),
		undefined,
	);
	assert.deepEqual(
		db
			.prepare("SELECT * FROM friend")
			.all()
			.map((r) => ({ ...r })),
		[{ from: "a", to: "b", created: "2026-11-09T00:00:00Z" }],
	);
});
