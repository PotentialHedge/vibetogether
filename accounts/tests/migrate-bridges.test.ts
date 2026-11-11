import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// A database in production's schema from before bridges (`production-schema-before-bridges.sql`,
// copied from lwirth-cloud on 2026-11-11, after `members` and `owner`), as production has it: messagent's grant of Luis's, the
// app's project with its Telegram session, an agent's token, and an OTP asked for.
const database = join(
	mkdtempSync(join(tmpdir(), "vibetogether-accounts-")),
	"accounts.db",
);
const old = new DatabaseSync(database);
old.exec("PRAGMA foreign_keys = ON");
old.exec(
	readFileSync(
		new URL("production-schema-before-bridges.sql", import.meta.url),
		"utf8",
	),
);
old.exec(`
	INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, login)
		VALUES ('u-luis', 'Luis', 'luis@example.com', 1, 0, 0, 'luiswirth');
	INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, agent, person, claim) VALUES
		('grant', 9e15, 'tok-grant', 0, 0, 'u-luis', 'messagent', 1, 'Telegram id 9118774471, no username, named Luis'),
		('laptop', 9e15, 'tok-laptop', 0, 0, 'u-luis', 'laptop', NULL, NULL);
	INSERT INTO "group" VALUES ('g_luis', 'luiswirth', 'u-luis', '2026-11-09T00:00:00Z');
	INSERT INTO group_member VALUES ('g_luis', 'u-luis');
	INSERT INTO project VALUES ('p_tg', 'messagent', 'g_luis', 'messagent', '2026-11-09T00:00:00Z');
	INSERT INTO project VALUES ('p_vt', 'vibetogether', 'g_luis', NULL, '2026-11-09T00:00:00Z');
	INSERT INTO owned_session VALUES
		('s_tg', 'Telegram', 'p_tg', 'u-luis', 'x1', '2026-11-09T00:00:00Z', 'grant'),
		('s_vt', 'agents', 'p_vt', 'u-luis', 'x2', '2026-11-09T00:00:00Z', NULL);
	INSERT INTO device_request VALUES ('ABCDEFGH', '2026-11-10T00:00:00Z', '192.0.2.1', 'hash', 1, 'a claim');
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

test("an app's grant goes, and its session stays an ordinary one of its project", async () => {
	// Better Auth's migrations run first, as the service starts.
	await import("../src/auth.ts");
	const { db, migrate } = await import("../src/db.ts");
	migrate();
	const rows = (sql: string) =>
		db
			.prepare(sql)
			.all()
			.map((r) => ({ ...r }) as Record<string, unknown>);
	const columns = (table: string) =>
		rows(`SELECT name FROM pragma_table_info('${table}')`).map((r) => r.name);
	assert.deepEqual(rows("SELECT id FROM session ORDER BY id"), [
		{ id: "laptop" },
	]);
	assert.deepEqual(
		rows("SELECT id, project, secret FROM owned_session ORDER BY id"),
		[
			{ id: "s_tg", project: "p_tg", secret: "x1" },
			{ id: "s_vt", project: "p_vt", secret: "x2" },
		],
	);
	assert.deepEqual(rows("SELECT id, name FROM project ORDER BY id"), [
		{ id: "p_tg", name: "messagent" },
		{ id: "p_vt", name: "vibetogether" },
	]);
	assert.equal(columns("owned_session").includes("app_grant"), false);
	assert.equal(columns("owned_session").includes("open"), false);
	assert.equal(columns("project").includes("app"), false);
	assert.equal(columns("session").includes("person"), false);
	assert.equal(columns("session").includes("bridge"), true);
	assert.deepEqual(rows("SELECT * FROM device_request"), []);
	assert.equal(columns("device_request").includes("bridge"), true);
	assert.deepEqual(rows("PRAGMA foreign_key_check"), []);

	// The Telegram session is Luis's like any other.
	const { app } = await import("../src/app.ts");
	const response = await app.request("/api/sessions", {
		headers: { authorization: "Bearer tok-laptop" },
	});
	assert.equal(response.status, 200);
	const sessions = (await response.json()) as { id: string; name: string }[];
	assert.deepEqual(
		sessions.map((s) => [s.id, s.name]),
		[
			["s_tg", "Telegram"],
			["s_vt", "agents"],
		],
	);
	// The grant is no credential any more.
	const me = await app.request("/api/me", {
		headers: { authorization: "Bearer tok-grant" },
	});
	assert.equal(me.status, 401);
});
