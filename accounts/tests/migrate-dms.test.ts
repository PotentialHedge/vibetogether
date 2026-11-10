import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

// A database in production's schema from before DMs (`production-schema-before-dms.sql`, copied
// from lwirth-cloud on 2026-11-10), with friends and a group's session as production has them.
const database = join(
	mkdtempSync(join(tmpdir(), "vibetogether-accounts-")),
	"accounts.db",
);
const old = new DatabaseSync(database);
old.exec("PRAGMA foreign_keys = ON");
old.exec(
	readFileSync(
		new URL("production-schema-before-dms.sql", import.meta.url),
		"utf8",
	),
);
const user = old.prepare(
	`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, login) VALUES (?, ?, ?, 1, 0, 0, ?)`,
);
for (const login of ["luiswirth", "benedict-armstrong", "tristangabl", "dora"])
	user.run(`u-${login}`, login, `${login}@example.com`, login);
const token = old.prepare(
	`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, agent) VALUES (?, ?, ?, 0, 0, ?, 'laptop')`,
);
for (const login of ["luiswirth", "benedict-armstrong", "tristangabl", "dora"])
	token.run(`t-${login}`, 9e15, `tok-${login}`, `u-${login}`);
const friend = old.prepare(
	`INSERT INTO friend VALUES (?, ?, '2026-11-09T00:00:00Z')`,
);
// Luis and Ben, and Luis and Tristan, are friends; Dora only asked Luis.
for (const [a, b] of [
	["luiswirth", "benedict-armstrong"],
	["benedict-armstrong", "luiswirth"],
	["luiswirth", "tristangabl"],
	["tristangabl", "luiswirth"],
	["dora", "luiswirth"],
])
	friend.run(`u-${a}`, `u-${b}`);
old.exec(`
	INSERT INTO "group" VALUES ('g_ph', 'Potential Hedge', 'u-luiswirth', 0, '2026-11-09T00:00:00Z');
	INSERT INTO group_member VALUES ('g_ph', 'u-luiswirth'), ('g_ph', 'u-benedict-armstrong');
	INSERT INTO project VALUES ('p_vt', 'vibetogether', 'g_ph', NULL, '2026-11-09T00:00:00Z');
	INSERT INTO owned_session VALUES ('s_agents', 'agents', 'p_vt', 'u-luiswirth', 'x1', '2026-11-09T00:00:00Z', 'members', NULL);
`);
old.close();

// A relay that only creates sessions, which is all the service asks of it.
let created = 0;
const relay = createServer((request, response) => {
	if (request.method === "POST" && request.url === "/v2/s?owned") {
		created += 1;
		response.end(`http://${request.headers.host}/v2/s/dm-${created}\n`);
	} else {
		response.statusCode = 404;
		response.end();
	}
});
await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
after(() => relay.close());

Object.assign(process.env, {
	ACCOUNTS_URL: "http://localhost:3000",
	ACCOUNTS_DATABASE: database,
	ACCOUNTS_SECRET: "a-secret-for-tests-only-that-is-long-enough",
	GITHUB_CLIENT_ID: "test",
	GITHUB_CLIENT_SECRET: "test",
	AGENTWIRE_RELAY: `http://127.0.0.1:${(relay.address() as AddressInfo).port}`,
});

test("every pair of friends gets its DM, which only the two of them join, and the rest stays", async () => {
	const { db, migrate } = await import("../src/db.ts");
	migrate();
	migrate();
	const rows = (sql: string) =>
		db
			.prepare(sql)
			.all()
			.map((r) => ({ ...r }) as Record<string, unknown>);
	assert.deepEqual(
		rows(
			`SELECT ua.login AS a, ub.login AS b FROM dm JOIN user ua ON ua.id = dm.a JOIN user ub ON ub.id = dm.b
			 ORDER BY a, b`,
		),
		[
			{ a: "benedict-armstrong", b: "luiswirth" },
			{ a: "luiswirth", b: "tristangabl" },
		],
	);
	assert.deepEqual(rows("SELECT id, project, secret FROM owned_session"), [
		{ id: "s_agents", project: "p_vt", secret: "x1" },
	]);
	assert.deepEqual(rows("PRAGMA foreign_key_check"), []);

	const { app } = await import("../src/app.ts");
	const dms = async (login: string) =>
		(await (
			await app.request("/api/dms", {
				headers: { authorization: `Bearer tok-${login}` },
			})
		).json()) as { id: string; friend: string; address: string }[];
	const luis = await dms("luiswirth");
	assert.deepEqual(
		luis.map((d) => d.friend),
		["benedict-armstrong", "tristangabl"],
	);
	assert.deepEqual(await dms("dora"), []);
	const address = luis[0]?.address as string;
	const withBen = address.split("/").pop() as string;
	assert.equal((await dms("benedict-armstrong"))[0]?.address, address);
	const joins = async (secret: string, login: string) =>
		(
			await app.request("/agentwire/join", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					session: secret,
					name: `${login}/claude`,
					token: `tok-${login}`,
					owned: true,
				}),
			})
		).status;
	assert.equal(await joins(withBen, "luiswirth"), 200);
	assert.equal(await joins(withBen, "benedict-armstrong"), 200);
	assert.equal(await joins(withBen, "tristangabl"), 403);
	assert.equal(await joins(withBen, "dora"), 403);
	assert.equal(await joins("x1", "benedict-armstrong"), 200);
});
