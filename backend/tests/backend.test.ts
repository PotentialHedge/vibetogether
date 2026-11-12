import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serializeSignedCookie } from "better-call";

const url = "http://localhost:3000";
Object.assign(process.env, {
	BACKEND_URL: url,
	BACKEND_DATABASE: join(
		mkdtempSync(join(tmpdir(), "vibetogether-backend-")),
		"backend.db",
	),
	BACKEND_SECRET: "a-secret-for-tests-only-that-is-long-enough",
	GITHUB_CLIENT_ID: "test",
	GITHUB_CLIENT_SECRET: "test",
});

const { app } = await import("../src/app.ts");
const { auth } = await import("../src/auth.ts");

/** How a request is made: by the person's cookie, or a token. */
type By = { cookie: string } | { token: string };

/** A person signed in in the browser, and a machine's token of theirs. */
async function person(
	login: string,
): Promise<{ browser: By; machine: By; userId: string }> {
	const context = await auth.$context;
	const user = await context.internalAdapter.createUser(
		{ email: `${login}@example.com`, name: login, login, emailVerified: true },
		{ method: "admin" },
	);
	const signIn = await context.internalAdapter.createSession(user.id);
	const cookie = await serializeSignedCookie(
		context.authCookies.sessionToken.name,
		signIn.token,
		context.secret,
	);
	const machine = await context.internalAdapter.createSession(user.id, false, {
		machine: `${login}-laptop`,
	});
	return {
		browser: { cookie: cookie.split(";")[0] ?? "" },
		machine: { token: machine.token },
		userId: user.id,
	};
}

async function call(
	by: By | undefined,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
	signal?: AbortSignal,
): Promise<{ status: number; json: any; text: string; headers: Headers }> {
	const all = new Headers(headers);
	if (by && "cookie" in by) {
		all.set("cookie", by.cookie);
		all.set("origin", url);
	}
	if (by && "token" in by) all.set("authorization", `Bearer ${by.token}`);
	let payload: string | Uint8Array<ArrayBuffer> | undefined;
	if (body instanceof Uint8Array || typeof body === "string")
		payload = body as string | Uint8Array<ArrayBuffer>;
	else if (body !== undefined) {
		payload = JSON.stringify(body);
		all.set("content-type", "application/json");
	}
	const response = await app.fetch(
		new Request(`${url}${path}`, {
			method,
			headers: all,
			...(payload !== undefined && { body: payload }),
			...(signal && { signal }),
		}),
	);
	const text = await response.text();
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: response.status, json, text, headers: response.headers };
}

const luis = await person("luis");
const ben = await person("ben");
const eve = await person("eve");

// Friends, a group, a project and a session.
assert.equal((await call(luis.browser, "PUT", "/api/friends/ben")).status, 204);
assert.equal((await call(ben.browser, "PUT", "/api/friends/luis")).status, 204);
const group = (
	await call(luis.browser, "POST", "/api/groups", { name: "Potential Hedge" })
).json;
assert.equal(
	(await call(luis.machine, "PUT", `/api/groups/${group.id}/members/ben`))
		.status,
	200,
);
const project = (
	await call(luis.browser, "POST", "/api/projects", {
		name: "vibetogether",
		group: group.id,
		repos: ["PotentialHedge/vibetogether"],
	})
).json;
const session = (
	await call(ben.machine, "POST", "/api/sessions", {
		name: "build",
		project: project.id,
	})
).json;
const s = `/api/sessions/${session.id}`;

test("a session shows its project, and only to its group", async () => {
	assert.deepEqual(session.project, {
		id: project.id,
		name: "vibetogether",
		repos: ["https://github.com/PotentialHedge/vibetogether"],
	});
	assert.equal((await call(eve.machine, "GET", s)).status, 404);
	assert.equal(
		(await call(eve.machine, "POST", `${s}/participants?agent=claude`)).status,
		404,
	);
});

test("a token names its agent, and a sign-in is the person", async () => {
	assert.equal(
		(await call(luis.machine, "POST", `${s}/participants`)).status,
		400,
	);
	assert.equal(
		(await call(luis.browser, "POST", `${s}/participants?agent=claude`)).status,
		400,
	);
	assert.equal(
		(await call(luis.machine, "POST", `${s}/participants?as=claude`)).status,
		400,
	);
});

test("participants join, send, receive by ping, and leave", async () => {
	const joined = await call(
		luis.machine,
		"POST",
		`${s}/participants?agent=claude`,
	);
	assert.equal(joined.status, 200);
	assert.equal(joined.json.name, "luis/claude");
	assert.equal(joined.json.session.id, session.id);
	const again = await call(
		luis.machine,
		"POST",
		`${s}/participants?agent=claude`,
	);
	assert.equal(again.json.n, joined.json.n);
	assert.equal(
		(await call(ben.browser, "POST", `${s}/participants`)).json.name,
		"ben",
	);

	// An fyi doesn't wake a receive; a ping does, and returns both.
	const waiting = call(luis.machine, "GET", `${s}/entries?agent=claude`);
	await new Promise((r) => setTimeout(r, 50));
	const presence = (await call(ben.browser, "GET", `${s}/participants`)).json;
	assert.equal(presence["luis/claude"].receiving, true);
	await call(ben.browser, "POST", `${s}/entries`, "Just so you know.", {
		"content-type": 'text/plain; ping=""',
	});
	const sent = await call(ben.browser, "POST", `${s}/entries`, "**Hey**", {
		"content-type": 'text/markdown; ping="luis/claude"',
	});
	assert.equal(sent.status, 200);
	const received = await waiting;
	assert.equal(received.status, 200);
	assert.deepEqual(
		received.json.entries
			.filter((e: any) => e.type.startsWith("text/"))
			.map((e: any) => [e.from, e.text, e.ping]),
		[
			["ben", "Just so you know.", false],
			["ben", "**Hey**", true],
		],
	);
	// It moved the read position, which everyone sees.
	const after = (await call(ben.browser, "GET", `${s}/participants`)).json;
	assert.equal(after["luis/claude"].read, sent.json.n);
	assert.equal(after["luis/claude"].receiving, false);

	// Nothing new: wait=0 returns at once, with nothing.
	const none = await call(
		luis.machine,
		"GET",
		`${s}/entries?agent=claude&wait=0`,
	);
	assert.deepEqual(none.json.entries, []);

	// A status says what one does, pings no one, and shows in the presence.
	const status = await call(
		luis.machine,
		"POST",
		`${s}/entries?agent=claude`,
		JSON.stringify({ text: "Writing tests." }),
		{ "content-type": "application/vnd.vibetogether.chat.status+json" },
	);
	assert.equal(status.status, 200);
	assert.equal(
		(await call(ben.browser, "GET", `${s}/participants`)).json["luis/claude"]
			.status,
		"Writing tests.",
	);

	const left = await call(
		luis.machine,
		"DELETE",
		`${s}/participants?agent=claude`,
	);
	assert.equal(left.status, 200);
	assert.equal(
		(await call(luis.machine, "GET", `${s}/entries?agent=claude&wait=0`))
			.status,
		403,
	);
	assert.equal(
		(await call(ben.browser, "GET", `${s}/participants`)).json["luis/claude"],
		undefined,
	);
});

test("a member reads the log without joining, and fetches payloads", async () => {
	const log = await call(luis.browser, "GET", `${s}/log`);
	assert.equal(log.status, 200);
	assert.ok(log.json.entries.some((e: any) => e.text === "**Hey**"));
	assert.equal(log.json.entries[0].type, "application/vnd.vibetogether.join");
	await call(
		ben.browser,
		"POST",
		`${s}/entries?filename=page.html`,
		"<script>alert(1)</script>",
		{
			"content-type": "text/html",
		},
	);
	const last = (await call(luis.browser, "GET", `${s}/log`)).json.entries.at(
		-1,
	);
	const fetched = await call(luis.machine, "GET", `${s}/entries/${last.n}`);
	assert.equal(fetched.text, "<script>alert(1)</script>");
	assert.match(fetched.headers.get("content-disposition") ?? "", /^attachment/);
	assert.match(fetched.headers.get("content-security-policy") ?? "", /sandbox/);
	assert.equal((await call(eve.machine, "GET", `${s}/log`)).status, 404);
});

test("an agent's name is held by one login at a time", async () => {
	const context = await auth.$context;
	const other = await context.internalAdapter.createSession(
		luis.userId,
		false,
		{
			machine: "luis-server",
		},
	);
	const server = { token: other.token };
	assert.equal(
		(await call(luis.machine, "POST", `${s}/participants?agent=codex`)).status,
		200,
	);
	assert.equal(
		(await call(server, "POST", `${s}/participants?agent=codex`)).status,
		409,
	);
	assert.equal(
		(await call(server, "GET", `${s}/entries?agent=codex&wait=0`)).status,
		403,
	);
	// Once its holder left, any login of the person takes it.
	await call(luis.machine, "DELETE", `${s}/participants?agent=codex`);
	assert.equal(
		(await call(server, "POST", `${s}/participants?agent=codex`)).status,
		200,
	);
	await call(server, "DELETE", `${s}/participants?agent=codex`);
});

test("one receive per name and login: a newer one ends the one before", async () => {
	await call(luis.machine, "POST", `${s}/participants?agent=claude`);
	await call(luis.machine, "GET", `${s}/entries?agent=claude&wait=0`);
	const first = call(luis.machine, "GET", `${s}/entries?agent=claude`);
	await new Promise((r) => setTimeout(r, 50));
	const second = call(luis.machine, "GET", `${s}/entries?agent=claude&wait=1`);
	assert.equal((await first).status, 409);
	assert.equal((await second).status, 200);
});

test("revoking a login cuts off its receive already waiting", async () => {
	const context = await auth.$context;
	const extra = await context.internalAdapter.createSession(ben.userId, false, {
		machine: "ben-spare",
	});
	const spare = { token: extra.token };
	await call(spare, "POST", `${s}/participants?agent=spare`);
	await call(spare, "GET", `${s}/entries?agent=spare&wait=0`);
	const waiting = call(spare, "GET", `${s}/entries?agent=spare`);
	await new Promise((r) => setTimeout(r, 50));
	const logins = (await call(ben.browser, "GET", "/api/logins")).json;
	const id = logins.find((l: any) => l.name === "ben-spare").id;
	assert.equal(
		(await call(ben.browser, "DELETE", `/api/logins/${id}`)).status,
		204,
	);
	assert.equal((await waiting).status, 403);
	assert.equal((await call(spare, "GET", "/api/me")).status, 401);
});

test("friends have a DM, which closes when they are no friends", async () => {
	const dms = (await call(luis.machine, "GET", "/api/dms")).json;
	assert.equal(dms.length, 1);
	assert.equal(dms[0].friend, "ben");
	assert.equal(dms[0].project, null);
	const dm = `/api/sessions/${dms[0].id}`;
	assert.equal(
		(await call(ben.machine, "POST", `${dm}/participants?agent=claude`)).status,
		200,
	);
	await call(ben.machine, "POST", `${dm}/entries?agent=claude`, "hi");
	assert.equal((await call(eve.machine, "GET", `${dm}/log`)).status, 404);
	assert.equal(
		(await call(luis.browser, "DELETE", "/api/friends/ben")).status,
		204,
	);
	assert.equal((await call(luis.browser, "GET", `${dm}/log`)).status, 404);
	await call(luis.browser, "PUT", "/api/friends/ben");
	await call(ben.browser, "PUT", "/api/friends/luis");
	const back = (await call(luis.browser, "GET", `${dm}/log`)).json;
	assert.ok(back.entries.some((e: any) => e.text === "hi"));
});

test("deleting a session ends what waits on it, and its log", async () => {
	const doomed = (
		await call(luis.browser, "POST", "/api/sessions", {
			name: "doomed",
			project: project.id,
		})
	).json;
	const d = `/api/sessions/${doomed.id}`;
	await call(ben.machine, "POST", `${d}/participants?agent=claude`);
	const waiting = call(ben.machine, "GET", `${d}/entries?agent=claude`);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal((await call(luis.browser, "DELETE", d)).status, 204);
	assert.equal((await waiting).status, 404);
	assert.equal((await call(luis.browser, "GET", `${d}/log`)).status, 404);
});

test("an agent's changes show in the activity, its sends don't", async () => {
	const activity = (await call(luis.browser, "GET", "/api/activity")).json;
	assert.ok(
		activity.some(
			(a: any) =>
				a.operation === "add_group_member" && a.agent === "luis-laptop",
		),
	);
	assert.ok(
		!activity.some(
			(a: any) => a.operation === "send" || a.operation === "join_session",
		),
	);
});

test("a change by the cookie comes from the site alone", async () => {
	const response = await app.fetch(
		new Request(`${url}/api/groups`, {
			method: "POST",
			headers: {
				cookie: "cookie" in luis.browser ? luis.browser.cookie : "",
				"content-type": "application/json",
				origin: "https://evil.example",
			},
			body: JSON.stringify({ name: "x" }),
		}),
	);
	assert.equal(response.status, 403);
});

test("the document defines every operation, and the reference renders", async () => {
	const document = (await call(undefined, "GET", "/api/openapi.json")).json;
	const ids = Object.values(document.paths).flatMap((item: any) =>
		Object.values(item).map((op: any) => op.operationId),
	);
	for (const id of [
		"join_session",
		"send",
		"receive",
		"read_session",
		"list_logins",
		"redeem_otp",
	])
		assert.ok(ids.includes(id), id);
	const reference = await call(undefined, "GET", "/api/reference.md");
	assert.equal(reference.status, 200);
	assert.match(reference.text, /agent=<agent>/);
});

test("deleting the account takes only the browser", async () => {
	assert.equal((await call(eve.machine, "DELETE", "/api/me")).status, 403);
	assert.equal((await call(eve.browser, "DELETE", "/api/me")).status, 204);
});

test("two pages that wake for any change don't wake each other forever", async () => {
	const context = await auth.$context;
	const other = await context.internalAdapter.createSession(luis.userId);
	const cookie = await serializeSignedCookie(
		context.authCookies.sessionToken.name,
		other.token,
		context.secret,
	);
	const pages: By[] = [luis.browser, { cookie: cookie.split(";")[0] ?? "" }];
	await call(luis.browser, "POST", `${s}/participants`);
	let wakes = 0;
	const stop = new AbortController();
	const loops = pages.map(async (page) => {
		let after =
			(await call(page, "GET", `${s}/entries?wait=0&own=1`)).json.entries.at(-1)
				?.n ?? 0;
		while (!stop.signal.aborted) {
			const answer = await call(
				page,
				"GET",
				`${s}/entries?wake=change&own=1&after=${after}`,
				undefined,
				{},
				stop.signal,
			).catch(() => undefined);
			if (answer?.status !== 200) return;
			wakes += 1;
			after = answer.json.entries.at(-1)?.n ?? after;
		}
	});
	await new Promise((r) => setTimeout(r, 100));
	await call(ben.browser, "POST", `${s}/entries`, "to both pages");
	await new Promise((r) => setTimeout(r, 300));
	stop.abort();
	await Promise.all(loops);
	assert.ok(wakes >= 2 && wakes < 10, `woken ${wakes} times`);
});

test("the MCP server's tools are the document's operations", async () => {
	const rpc = async (by: By | undefined, body: unknown) => {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
		};
		if (by && "token" in by) headers.authorization = `Bearer ${by.token}`;
		const response = await app.fetch(
			new Request(`${url}/mcp`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			}),
		);
		const text = await response.text();
		const data = text.split("\n").find((line) => line.startsWith("data: "));
		return {
			status: response.status,
			headers: response.headers,
			json: data ? JSON.parse(data.slice(6)) : undefined,
		};
	};
	const challenged = await rpc(undefined, {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/list",
	});
	assert.equal(challenged.status, 401);
	assert.match(
		challenged.headers.get("www-authenticate") ?? "",
		/resource_metadata=/,
	);
	const list = await rpc(ben.machine, {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/list",
	});
	const tools = list.json.result.tools.map((t: any) => t.name);
	for (const name of ["join_session", "send", "receive", "overview"])
		assert.ok(tools.includes(name), name);
	assert.ok(!tools.includes("delete_account") && !tools.includes("redeem_otp"));
	await call(ben.machine, "POST", `${s}/participants?agent=claude`);
	const sent = await rpc(ben.machine, {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: {
			name: "send",
			arguments: {
				id: session.id,
				agent: "claude",
				content: "via MCP",
				type: "text/markdown",
			},
		},
	});
	assert.equal(sent.json.result.isError, undefined, JSON.stringify(sent.json));
	const log = (await call(luis.browser, "GET", `${s}/log`)).json;
	assert.equal(log.entries.at(-1).text, "via MCP");
	assert.equal(log.entries.at(-1).from, "ben/claude");
});

test("an overview with its version waits until it changes", async () => {
	const first = (await call(ben.machine, "GET", "/api/overview")).json;
	assert.equal(typeof first.version, "string");
	// A write that changes nothing of Ben's doesn't wake him.
	const unchanged = call(
		ben.machine,
		"GET",
		`/api/overview?version=${first.version}&wait=1`,
	);
	await call(eve.browser, "POST", "/api/groups", { name: "elsewhere" });
	assert.equal((await unchanged).json.version, first.version);
	// A change to his group by Luis's agent does.
	const woken = call(
		ben.machine,
		"GET",
		`/api/overview?version=${first.version}&wait=10`,
	);
	await call(luis.machine, "POST", "/api/projects", {
		name: "proofmarket",
		group: group.id,
	});
	const next = (await woken).json;
	assert.notEqual(next.version, first.version);
	assert.ok(
		next.groups
			.find((g: any) => g.id === group.id)
			.projects.some((p: any) => p.name === "proofmarket"),
	);
	// An old version returns at once.
	const again = await call(
		ben.machine,
		"GET",
		`/api/overview?version=${first.version}`,
	);
	assert.equal(again.json.version, next.version);
});

test("accepting an invite makes friends with a DM, joins its group, and lands in its session", async () => {
	const tristan = await person("tristan");
	const invite = (
		await call(luis.machine, "POST", "/api/invites", { session: session.id })
	).json;
	assert.deepEqual(invite.group, { id: group.id, name: "Potential Hedge" });
	assert.equal(invite.session.id, session.id);
	const shown = (await call(undefined, "GET", `/api/invites/${invite.code}`))
		.json;
	assert.equal(shown.session, "build");
	const accepted = await call(
		tristan.browser,
		"POST",
		`/api/invites/${invite.code}/accept`,
	);
	assert.equal(accepted.status, 200, accepted.text);
	assert.equal(accepted.json.land.id, session.id);
	const overview = (await call(tristan.machine, "GET", "/api/overview")).json;
	assert.ok(overview.friends.some((f: any) => f.name === "luis"));
	assert.ok(overview.dms.some((d: any) => d.id === accepted.json.dm));
	assert.ok(overview.groups.some((g: any) => g.id === group.id));

	// Friends already: an invite to a group lands in its general; one to friends alone, in the DM.
	const toGroup = (
		await call(luis.machine, "POST", "/api/invites", { group: group.id })
	).json;
	const again = await call(
		tristan.browser,
		"POST",
		`/api/invites/${toGroup.code}/accept`,
	);
	assert.equal(again.status, 200, again.text);
	assert.equal(again.json.land.general, true);
	assert.equal(again.json.land.group.id, group.id);
	const plain = (await call(luis.machine, "POST", "/api/invites", {})).json;
	assert.equal(plain.group, null);
	const dm = await call(
		tristan.browser,
		"POST",
		`/api/invites/${plain.code}/accept`,
	);
	assert.equal(dm.json.land.id, dm.json.dm);

	// Not to one's own group, nor to a group or session the inviter isn't in.
	const own = (
		await call(luis.browser, "GET", "/api/overview")
	).json.groups.find((g: any) => g.own);
	assert.equal(
		(await call(luis.machine, "POST", "/api/invites", { group: own.id }))
			.status,
		403,
	);
	assert.equal(
		(
			await call(luis.machine, "POST", "/api/invites", {
				session: own.sessions[0].id,
			})
		).status,
		403,
	);
	const stranger = await person("stranger");
	assert.equal(
		(await call(stranger.machine, "POST", "/api/invites", { group: group.id }))
			.status,
		404,
	);
	assert.equal(
		(
			await call(stranger.machine, "POST", "/api/invites", {
				session: session.id,
			})
		).status,
		404,
	);
});

test("every group has its general, which stays as long as the group", async () => {
	const zoe = await person("zoe");
	const overview = (await call(luis.browser, "GET", "/api/overview")).json;
	for (const g of overview.groups) {
		assert.equal(g.sessions[0].name, "general");
		assert.equal(g.sessions[0].general, true);
		assert.equal(g.sessions[0].project, null);
		assert.equal(g.sessions[0].group.id, g.id);
	}
	const general = overview.groups.find((g: any) => g.id === group.id)
		.sessions[0];
	const at = `/api/sessions/${general.id}`;
	assert.equal(
		(await call(luis.browser, "PATCH", at, { name: "random" })).status,
		403,
	);
	assert.equal((await call(luis.browser, "DELETE", at)).status, 403);
	assert.equal((await call(zoe.browser, "GET", at)).status, 404);

	// A session of the group's own, in no project.
	const own = await call(ben.machine, "POST", "/api/sessions", {
		name: "lounge",
		group: group.id,
	});
	assert.equal(own.status, 201);
	assert.equal(own.json.project, null);
	assert.equal(own.json.group.id, group.id);
	assert.equal(own.json.general, false);
	assert.equal(
		(
			await call(ben.machine, "POST", "/api/sessions", {
				name: "both",
				group: group.id,
				project: project.id,
			})
		).status,
		400,
	);

	// What happened in the group is in its general, from vibetogether, pinging no one.
	const log = (await call(luis.browser, "GET", `${at}/log`)).json.entries;
	const said = log.map((e: any) => [e.from, e.text]);
	assert.ok(
		said.some(
			([from, text]: string[]) =>
				from === "vibetogether" &&
				text === "ben created the session **lounge**.",
		),
	);
	assert.ok(log.every((e: any) => /ping=""/.test(e.type)));
	assert.equal(
		(await call(ben.machine, "DELETE", `/api/sessions/${own.json.id}`)).status,
		204,
	);

	// A group deleted takes its general with it, and tells its other members in their inbox.
	const doomed = (
		await call(luis.browser, "POST", "/api/groups", { name: "doomed" })
	).json;
	await call(luis.browser, "PUT", `/api/groups/${doomed.id}/members/ben`);
	const doomedGeneral = (
		await call(luis.browser, "GET", "/api/overview")
	).json.groups.find((g: any) => g.id === doomed.id).sessions[0].id;
	assert.equal(
		(await call(ben.browser, "DELETE", `/api/groups/${doomed.id}`)).status,
		204,
	);
	assert.equal(
		(await call(luis.browser, "GET", `/api/sessions/${doomedGeneral}`)).status,
		404,
	);
	const inbox = (
		await call(luis.browser, "GET", "/api/overview")
	).json.groups.find((g: any) => g.own).sessions[0];
	const mail = (
		await call(luis.browser, "GET", `/api/sessions/${inbox.id}/log`)
	).json.entries;
	assert.equal(mail.at(-1).text, "ben deleted the group **doomed**.");
});

test("a ping or an fyi reaches a name in any session it receives in", async () => {
	const overview = (await call(ben.browser, "GET", "/api/overview")).json;
	const general = overview.groups.find((g: any) => g.id === group.id)
		.sessions[0];
	const g = `/api/sessions/${general.id}`;
	// ben/claude takes part in general only; luis/claude in the project's session only.
	await call(ben.machine, "POST", `${g}/participants?agent=claude`);
	await call(luis.machine, "POST", `${s}/participants?agent=claude`);
	await call(luis.machine, "GET", `${s}/entries?agent=claude&wait=0`);

	// An fyi from general waits quietly, and comes with the ping that wakes it.
	const fyi = await call(
		ben.machine,
		"POST",
		`${g}/entries?agent=claude`,
		"FYI.",
		{
			"content-type": 'text/plain; ping=""; fyi="luis/claude"',
		},
	);
	assert.equal(fyi.status, 200);
	const waiting = call(luis.machine, "GET", `${s}/entries?agent=claude&wait=5`);
	await new Promise((r) => setTimeout(r, 50));
	const ping = await call(
		ben.machine,
		"POST",
		`${g}/entries?agent=claude`,
		"Hey, from general.",
		{
			"content-type": 'text/plain; ping="luis/claude zoe nobody/x"',
		},
	);
	assert.deepEqual(ping.json.unreached, ["zoe", "nobody/x"]);
	const received = await waiting;
	assert.equal(received.status, 200);
	assert.deepEqual(
		received.json.entries.map((e: any) => [e.text, e.ping, e.session?.id]),
		[
			["FYI.", false, general.id],
			["Hey, from general.", true, general.id],
		],
	);
	// Received once: it doesn't come again.
	assert.deepEqual(
		(await call(luis.machine, "GET", `${s}/entries?agent=claude&wait=0`)).json
			.entries,
		[],
	);

	// The answer in general wakes ben/claude there as usual.
	const answer = call(ben.machine, "GET", `${g}/entries?agent=claude&wait=5`);
	await new Promise((r) => setTimeout(r, 50));
	await call(luis.machine, "POST", `${g}/participants?agent=claude`);
	await call(luis.machine, "POST", `${g}/entries?agent=claude`, "Got it.", {
		"content-type": 'text/plain; ping="ben/claude"',
	});
	const got = (await answer).json.entries.filter(
		(e: any) => e.type.startsWith("text/") && e.from !== "vibetogether",
	);
	assert.deepEqual(
		got.map((e: any) => [e.from, e.text, e.ping, e.session]),
		[["luis/claude", "Got it.", true, undefined]],
	);
	// luis/claude, now in general too, gets general's messages there, without the ones it already got.
	const there = (
		await call(luis.machine, "GET", `${g}/entries?agent=claude&wait=0&after=0`)
	).json.entries;
	assert.ok(there.every((e: any) => e.session === undefined));

	// `*` stays inside the session: no one outside it is reached.
	await call(ben.machine, "POST", `${g}/entries?agent=claude`, "All here.", {
		"content-type": 'text/plain; ping="*"',
	});
	await call(luis.machine, "DELETE", `${g}/participants?agent=claude`);
	await call(ben.machine, "POST", `${g}/entries?agent=claude`, "Everyone.", {
		"content-type": 'text/plain; ping="*"',
	});
	assert.deepEqual(
		(await call(luis.machine, "GET", `${s}/entries?agent=claude&wait=0`)).json
			.entries,
		[],
	);
	await call(luis.machine, "DELETE", `${s}/participants?agent=claude`);

	// A session that pinged the person shows so, until they received there.
	const pinged = async () =>
		(await call(luis.browser, "GET", "/api/overview")).json.groups
			.find((x: any) => x.id === group.id)
			.sessions.find((x: any) => x.id === general.id).pinged;
	assert.equal(await pinged(), false);
	await call(ben.machine, "POST", `${g}/entries?agent=claude`, "Luis?", {
		"content-type": 'text/plain; ping="luis"',
	});
	assert.equal(await pinged(), true);
	await call(luis.browser, "POST", `${g}/participants`);
	await call(luis.browser, "GET", `${g}/entries?wait=0`);
	assert.equal(await pinged(), false);
	await call(luis.browser, "DELETE", `${g}/participants`);
	await call(ben.machine, "DELETE", `${g}/participants?agent=claude`);
});

test("no account takes the name system messages are sent under", async () => {
	await assert.rejects(person("vibetogether"));
});
