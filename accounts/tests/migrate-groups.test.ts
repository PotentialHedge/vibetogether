import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// A database in production's schema from before groups (`production-schema-before-groups.sql`, copied from
// lwirth-cloud on 2026-11-10), holding sessions like production's then, and a few more cases.
const database = join(
	mkdtempSync(join(tmpdir(), "vibetogether-accounts-")),
	"accounts.db",
);
const old = new DatabaseSync(database);
old.exec("PRAGMA foreign_keys = ON");
old.exec(
	readFileSync(
		new URL("production-schema-before-groups.sql", import.meta.url),
		"utf8",
	),
);
const user = old.prepare(
	`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, login) VALUES (?, ?, ?, 1, 0, 0, ?)`,
);
for (const login of ["luiswirth", "benedict-armstrong", "tristangabl", "dora"])
	user.run(`u-${login}`, login, `${login}@example.com`, login);
const grant = old.prepare(
	`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, agent, person) VALUES (?, ?, ?, 0, 0, ?, ?, ?)`,
);
grant.run("bot", 9e15, "t1", "u-luiswirth", "messagent", 1);
grant.run("laptop", 9e15, "t2", "u-luiswirth", "laptop", null);
const session = old.prepare(
	`INSERT INTO owned_session (id, name, owner, secret, created, open, app_grant) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const at = (n: number) => `2026-11-09T0${n}:00:00Z`;
session.run(
	"s_agents",
	"agents",
	"u-tristangabl",
	"x1",
	at(1),
	"members",
	null,
);
session.run("s_vt", "lwirth-vt", "u-luiswirth", "x2", at(2), "members", null);
session.run("s_tg", "Telegram", "u-luiswirth", "x3", at(3), "members", "bot");
session.run(
	"s_ph",
	"potentialhedge",
	"u-luiswirth",
	"x4",
	at(4),
	"members",
	null,
);
// The same people again share the group; other people get one of their own.
session.run("s_ph2", "hedge-2", "u-luiswirth", "x5", at(5), "link", null);
session.run("s_ben", "ben", "u-luiswirth", "x6", at(6), "members", null);
// An app's session whose grant is gone was already ended.
session.run("s_gone", "gone", "u-luiswirth", "x7", at(7), "members", "revoked");
const member = old.prepare(
	"INSERT INTO session_member (session, user) VALUES (?, ?)",
);
for (const s of ["s_ph", "s_ph2"])
	for (const u of ["u-benedict-armstrong", "u-tristangabl"]) member.run(s, u);
member.run("s_ben", "u-benedict-armstrong");
old.exec(`INSERT INTO friend VALUES ('u-luiswirth', 'u-dora', '${at(1)}')`);

// Who may join each session before: its owner and its members.
const before = new Map<string, string[]>();
for (const row of old
	.prepare(
		`SELECT s.id, s.owner AS user FROM owned_session s UNION SELECT session, user FROM session_member ORDER BY 2`,
	)
	.all() as { id: string; user: string }[])
	before.set(row.id, [...(before.get(row.id) ?? []), row.user]);
old.close();

Object.assign(process.env, {
	ACCOUNTS_URL: "http://localhost:3000",
	ACCOUNTS_DATABASE: database,
	ACCOUNTS_SECRET: "a-secret-for-tests-only-that-is-long-enough",
	GITHUB_CLIENT_ID: "test",
	GITHUB_CLIENT_SECRET: "test",
	AGENTWIRE_RELAY: "http://127.0.0.1:1",
});

test("every session goes into a project of a group of exactly the people who could join it, with its address", async () => {
	const { db, migrate } = await import("../src/db.ts");
	migrate();
	migrate();
	const rows = (sql: string) =>
		db
			.prepare(sql)
			.all()
			.map((r) => ({ ...r }) as Record<string, unknown>);
	type Placed = {
		id: string;
		secret: string;
		project: string;
		projectName: string;
		app: string | null;
		group: string;
		groupName: string;
		person: string | null;
	};
	const placed = rows(
		`SELECT s.id, s.secret, p.id AS project, p.name AS projectName, p.app, g.id AS "group",
		 g.name AS groupName, g.person FROM owned_session s JOIN project p ON p.id = s.project
		 JOIN "group" g ON g.id = p."group" ORDER BY s.created`,
	) as Placed[];
	const by = new Map(placed.map((s) => [s.id, s]));
	assert.deepEqual(
		placed.map((s) => [s.id, s.secret]),
		[
			["s_agents", "x1"],
			["s_vt", "x2"],
			["s_tg", "x3"],
			["s_ph", "x4"],
			["s_ph2", "x5"],
			["s_ben", "x6"],
		],
	);
	// Access stays exactly as it was.
	for (const s of placed) {
		const people = rows(
			`SELECT user FROM group_member WHERE "group" = '${s.group}' ORDER BY user`,
		).map((r) => r.user);
		assert.deepEqual(people, before.get(s.id), s.id);
	}
	const get = (id: string) => by.get(id) as Placed;
	assert.equal(get("s_agents").person, "u-tristangabl");
	assert.equal(get("s_vt").person, "u-luiswirth");
	assert.equal(get("s_vt").projectName, "lwirth-vt");
	assert.equal(get("s_tg").group, get("s_vt").group);
	assert.equal(get("s_tg").app, "messagent");
	assert.equal(get("s_tg").projectName, "messagent");
	assert.equal(get("s_ph").person, null);
	assert.equal(get("s_ph").groupName, "potentialhedge");
	assert.equal(get("s_ph").projectName, "potentialhedge");
	assert.equal(get("s_ph2").group, get("s_ph").group);
	// Its owner becomes its creator.
	assert.deepEqual(
		rows("SELECT DISTINCT creator FROM owned_session WHERE id != 's_agents'"),
		[{ creator: "u-luiswirth" }],
	);
	assert.notEqual(get("s_ph2").project, get("s_ph").project);
	assert.notEqual(get("s_ben").group, get("s_ph").group);
	// Everyone has a group of their own, holding them alone.
	assert.deepEqual(
		rows(
			`SELECT g.name, group_concat(m.user) AS people FROM "group" g JOIN group_member m ON m."group" = g.id
			 WHERE g.person IS NOT NULL GROUP BY g.id ORDER BY g.name`,
		),
		[
			{ name: "benedict-armstrong", people: "u-benedict-armstrong" },
			{ name: "dora", people: "u-dora" },
			{ name: "luiswirth", people: "u-luiswirth" },
			{ name: "tristangabl", people: "u-tristangabl" },
		],
	);
	assert.deepEqual(
		rows(
			"SELECT name FROM sqlite_master WHERE name = 'session_member' OR name = 'owned_session_grouped'",
		),
		[],
	);
	assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
	assert.equal(
		(db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
			.foreign_keys,
		1,
	);
	// The relay's access service lets in exactly those people's agents.
	const { app } = await import("../src/app.ts");
	const join = async (secret: string, login: string) => {
		const grantOf = db
			.prepare(
				`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, agent) VALUES (?, ?, ?, ?, ?, ?, 'test')`,
			)
			.run(
				`g-${secret}-${login}`,
				Date.now() + 60_000,
				`tok-${secret}-${login}`,
				Date.now(),
				Date.now(),
				`u-${login}`,
			);
		assert.ok(grantOf.changes);
		const response = await app.request("/agentwire/join", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				session: secret,
				name: `${login}/claude`,
				token: `tok-${secret}-${login}`,
				owned: true,
			}),
		});
		return response.status;
	};
	assert.equal(await join("x4", "benedict-armstrong"), 200);
	assert.equal(await join("x4", "tristangabl"), 200);
	assert.equal(await join("x4", "luiswirth"), 200);
	assert.equal(await join("x4", "dora"), 403);
	assert.equal(await join("x6", "tristangabl"), 403);
	assert.equal(await join("x3", "luiswirth"), 200);
	assert.equal(await join("x3", "benedict-armstrong"), 403);
	assert.equal(await join("x1", "luiswirth"), 403);
});
