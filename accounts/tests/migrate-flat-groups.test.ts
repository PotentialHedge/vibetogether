import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// A database in production's schema from before groups lost their owner
// (`production-schema-before-flat-groups.sql`, copied from lwirth-cloud on 2026-11-11),
// with own groups and a shared group as production has them.
const database = join(
	mkdtempSync(join(tmpdir(), "vibetogether-accounts-")),
	"accounts.db",
);
const old = new DatabaseSync(database);
old.exec("PRAGMA foreign_keys = ON");
old.exec(
	readFileSync(
		new URL("production-schema-before-flat-groups.sql", import.meta.url),
		"utf8",
	),
);
const user = old.prepare(
	`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, login) VALUES (?, ?, ?, 1, 0, 0, ?)`,
);
for (const login of ["luiswirth", "benedict-armstrong"])
	user.run(`u-${login}`, login, `${login}@example.com`, login);
old
	.prepare(
		`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, agent) VALUES ('t', 9e15, 'tok-ben', 0, 0, 'u-benedict-armstrong', 'laptop')`,
	)
	.run();
old.exec(`
	INSERT INTO "group" VALUES ('g_luis', 'luiswirth', 'u-luiswirth', 1, '2026-11-09T00:00:00Z');
	INSERT INTO "group" VALUES ('g_ben', 'benedict-armstrong', 'u-benedict-armstrong', 1, '2026-11-09T00:00:00Z');
	INSERT INTO "group" VALUES ('g_ph', 'Potential Hedge', 'u-luiswirth', 0, '2026-11-09T00:00:01Z');
	INSERT INTO group_member VALUES ('g_luis', 'u-luiswirth'), ('g_ben', 'u-benedict-armstrong'),
		('g_ph', 'u-luiswirth'), ('g_ph', 'u-benedict-armstrong');
	INSERT INTO project VALUES ('p_vt', 'vibetogether', 'g_ph', NULL, '2026-11-09T00:00:00Z');
	INSERT INTO owned_session VALUES ('s_agents', 'agents', 'p_vt', 'u-luiswirth', 'x1', '2026-11-09T00:00:00Z', NULL);
`);
old.close();

Object.assign(process.env, {
	ACCOUNTS_URL: "http://localhost:3000",
	ACCOUNTS_DATABASE: database,
	ACCOUNTS_SECRET: "a-secret-for-tests-only-that-is-long-enough",
	GITHUB_CLIENT_ID: "test",
	GITHUB_CLIENT_SECRET: "test",
	AGENTWIRE_RELAY: "http://127.0.0.1:9",
});

test("a group keeps only its person, where it is someone's own, and outlives whoever created it", async () => {
	const { db, migrate } = await import("../src/db.ts");
	migrate();
	migrate();
	const rows = (sql: string) =>
		db
			.prepare(sql)
			.all()
			.map((r) => ({ ...r }) as Record<string, unknown>);
	assert.deepEqual(
		rows(`SELECT name FROM pragma_table_info('group') ORDER BY cid`).map(
			(c) => c.name,
		),
		["id", "name", "person", "created"],
	);
	assert.deepEqual(rows(`SELECT id, person FROM "group" ORDER BY id`), [
		{ id: "g_ben", person: "u-benedict-armstrong" },
		{ id: "g_luis", person: "u-luiswirth" },
		{ id: "g_ph", person: null },
	]);
	assert.deepEqual(
		rows("SELECT name FROM sqlite_master WHERE name = 'group_own'"),
		[],
	);
	assert.deepEqual(rows("PRAGMA foreign_key_check"), []);

	const { app } = await import("../src/app.ts");
	const groups = (await (
		await app.request("/api/groups", {
			headers: { authorization: "Bearer tok-ben" },
		})
	).json()) as { id: string; own: boolean }[];
	assert.deepEqual(
		groups.map((g) => [g.id, g.own]),
		[
			["g_ben", true],
			["g_ph", false],
		],
	);

	// Who created a group no longer takes it along: only their own group goes with them.
	db.prepare("DELETE FROM user WHERE id = 'u-luiswirth'").run();
	assert.deepEqual(rows(`SELECT id FROM "group" ORDER BY id`), [
		{ id: "g_ben" },
		{ id: "g_ph" },
	]);
	assert.deepEqual(rows("SELECT id, creator FROM owned_session"), [
		{ id: "s_agents", creator: null },
	]);
});
