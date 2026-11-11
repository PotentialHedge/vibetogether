import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// A database in production's schema from before grants (`production-schema-before-grants.sql`,
// copied from lwirth-cloud on 2026-11-11): a bridge's credential for one session, the room it
// described, Luis's linked Telegram account, an agent's token, and a bridge's OTP asked for.
const database = join(
	mkdtempSync(join(tmpdir(), "vibetogether-accounts-")),
	"accounts.db",
);
const old = new DatabaseSync(database);
old.exec("PRAGMA foreign_keys = ON");
old.exec(
	readFileSync(
		new URL("production-schema-before-grants.sql", import.meta.url),
		"utf8",
	),
);
old.exec(`
	INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, login)
		VALUES ('u-luis', 'Luis', 'luis@example.com', 1, 0, 0, 'luiswirth');
	INSERT INTO "group" VALUES ('g_luis', 'luiswirth', 'u-luis', '2026-11-11T00:00:00Z');
	INSERT INTO group_member VALUES ('g_luis', 'u-luis');
	INSERT INTO project VALUES ('p_vt', 'vibetogether', 'g_luis', '2026-11-11T00:00:00Z');
	INSERT INTO owned_session VALUES ('s_vt', 'agents', 'p_vt', 'u-luis', 'x1', '2026-11-11T00:00:00Z');
	INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, agent, claim, bridge) VALUES
		('bridged', 9e15, 'tok-bridge', 0, 0, 'u-luis', 'messagent', 'Telegram group "Team"', 's_vt'),
		('laptop', 9e15, 'tok-laptop', 0, 0, 'u-luis', 'laptop', NULL, NULL);
	INSERT INTO bridge_room VALUES ('bridged', 'the Telegram group "Team" (3 people)');
	INSERT INTO identity VALUES ('i_1', 'messagent', '123', 'u-luis', '@luiswirth', '2026-11-11T00:00:00Z');
	INSERT INTO device_request VALUES ('ABCDEFGH', '2026-11-11T00:00:00Z', '192.0.2.1', 'hash', 'messagent', 'a claim', '123', '@luiswirth', NULL);
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

test("a bridge's credential for one session and a linked identity go, and tokens stay", async () => {
	await import("../src/auth.ts");
	const { db, migrate } = await import("../src/db.ts");
	migrate();
	// Twice, as every start runs it.
	migrate();
	const rows = (sql: string) =>
		db
			.prepare(sql)
			.all()
			.map((r) => ({ ...r }) as Record<string, unknown>);
	const columns = (table: string) =>
		rows(`SELECT name FROM pragma_table_info('${table}')`).map((r) => r.name);
	const names = (type: string) =>
		rows(
			`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`,
		).map((r) => r.name);
	assert.deepEqual(rows("SELECT id FROM session ORDER BY id"), [
		{ id: "laptop" },
	]);
	assert.equal(names("table").includes("identity"), false);
	assert.deepEqual(columns("bridge_room"), [
		"id",
		"session",
		"bridge",
		"user",
		"about",
		"created",
	]);
	assert.deepEqual(rows("SELECT * FROM bridge_room"), []);
	assert.deepEqual(columns("device_request"), [
		"user_code",
		"requested",
		"from",
		"device_code",
		"bridge",
		"claim",
	]);
	assert.deepEqual(rows("SELECT * FROM device_request"), []);
	const triggers = names("trigger");
	assert.ok(triggers.includes("room_with_grant"), triggers.join(" "));
	assert.ok(triggers.includes("room_with_member"), triggers.join(" "));
	assert.ok(!triggers.includes("bridge_with_session"), triggers.join(" "));
	assert.ok(!triggers.includes("bridge_with_member"), triggers.join(" "));
	assert.deepEqual(rows("PRAGMA foreign_key_check"), []);

	const { app } = await import("../src/app.ts");
	const sessions = await app.request("/api/sessions", {
		headers: { authorization: "Bearer tok-laptop" },
	});
	assert.equal(sessions.status, 200);
	const [session] = (await sessions.json()) as { bridges: unknown[] }[];
	assert.deepEqual(session?.bridges, []);
	const bridge = await app.request("/api/bridges/self", {
		headers: { authorization: "Bearer tok-bridge" },
	});
	assert.equal(bridge.status, 401);
});
