import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { serializeSignedCookie } from "better-call";

// A relay that only creates sessions, which is all the service asks of it.
let sessions = 0;
const relay = createServer((request, response) => {
	if (request.method === "POST" && request.url === "/v2/s?owned") {
		sessions += 1;
		response.end(`http://${request.headers.host}/v2/s/session-${sessions}\n`);
	} else {
		response.statusCode = 404;
		response.end();
	}
});
await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;

Object.assign(process.env, {
	ACCOUNTS_URL: "http://localhost:3000",
	ACCOUNTS_DATABASE: join(
		mkdtempSync(join(tmpdir(), "vibetogether-accounts-")),
		"accounts.db",
	),
	ACCOUNTS_SECRET: "a-secret-for-tests-only-that-is-long-enough",
	GITHUB_CLIENT_ID: "test",
	GITHUB_CLIENT_SECRET: "test",
	AGENTWIRE_RELAY: relayUrl,
	// messagent's secret is "a-secret-of-the-bot".
	ACCOUNTS_APPS:
		"messagent 6ab53bae0eef33d30015a3069604e5f1ca5f9a5d71b53554cc0e2c8b164a4ce2\n",
});

const { app } = await import("../src/app.ts");
const { auth } = await import("../src/auth.ts");

after(() => relay.close());

/** A person signed in in the browser, by the cookie of a session of theirs, and that session's token. */
async function person(
	login: string,
): Promise<{ cookie: string; token: string }> {
	const context = await auth.$context;
	const user = await context.internalAdapter.createUser(
		{ email: `${login}@example.com`, name: login, login, emailVerified: true },
		{ method: "admin" },
	);
	const session = await context.internalAdapter.createSession(user.id);
	const cookie = await serializeSignedCookie(
		context.authCookies.sessionToken.name,
		session.token,
		context.secret,
	);
	return { cookie: `cookie:${cookie.split(";")[0]}`, token: session.token };
}

/** The address requests come from, which the rate limits count by: a test of its own sets one. */
let from: string | undefined;

async function call(
	/** A bearer token, or a person's cookie as `cookie:…`. */
	token: string | null,
	method: string,
	path: string,
	body?: unknown,
) {
	const headers = new Headers({ origin: "http://localhost:3000" });
	if (from) headers.set("x-forwarded-for", from);
	if (token?.startsWith("cookie:"))
		headers.set("cookie", token.slice("cookie:".length));
	else if (token) headers.set("authorization", `Bearer ${token}`);
	if (body !== undefined) headers.set("content-type", "application/json");
	const response = await app.request(path, {
		method,
		headers,
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: response.status, text, json: json as any };
}

test("an invite to be friends: shown, accepted once, and then gone", async () => {
	const luis = await person("inv-luis");
	const ben = await person("inv-ben");
	const eve = await person("inv-eve");
	// An agent makes it with its token.
	const made = await call(luis.token, "POST", "/api/invites", {});
	assert.equal(made.status, 201, made.text);
	assert.equal(made.json.to, "friend");
	assert.match(made.json.link, /\/i\/[a-z2-9]{10}$/);
	const code = made.json.code;
	const listed = await call(luis.token, "GET", "/api/invites");
	assert.deepEqual(
		listed.json.map((i: { code: string }) => i.code),
		[code],
	);
	// Anyone with the link sees who invites.
	const shown = await call(null, "GET", `/api/invites/${code}`);
	assert.equal(shown.status, 200, shown.text);
	assert.equal(shown.json.inviter.name, "inv-luis");
	// Accepting is the person's, in the browser.
	assert.equal(
		(await call(ben.token, "POST", `/api/invites/${code}/accept`)).status,
		403,
	);
	assert.equal(
		(await call(luis.cookie, "POST", `/api/invites/${code}/accept`)).status,
		400,
	);
	const accepted = await call(
		ben.cookie,
		"POST",
		`/api/invites/${code}/accept`,
	);
	assert.equal(accepted.status, 200, accepted.text);
	assert.equal(accepted.json.inviter.name, "inv-luis");
	assert.equal(accepted.json.project, null);
	const friends = await call(ben.token, "GET", "/api/friends");
	assert.deepEqual(
		friends.json.map((f: { name: string; state: string }) => [f.name, f.state]),
		[["inv-luis", "friends"]],
	);
	const dms = await call(ben.token, "GET", "/api/dms");
	assert.equal(dms.json[0].id, accepted.json.dm);
	// Single-use: the one who accepted sees it again, no one else.
	assert.equal(
		(await call(ben.cookie, "POST", `/api/invites/${code}/accept`)).status,
		200,
	);
	assert.equal(
		(await call(ben.cookie, "GET", `/api/invites/${code}`)).status,
		200,
	);
	assert.equal((await call(null, "GET", `/api/invites/${code}`)).status, 404);
	assert.equal(
		(await call(eve.cookie, "POST", `/api/invites/${code}/accept`)).status,
		410,
	);
	assert.deepEqual((await call(luis.token, "GET", "/api/invites")).json, []);
});

test("an invite is revoked by its maker alone", async () => {
	const luis = await person("rev-luis");
	const ben = await person("rev-ben");
	const { code } = (await call(luis.token, "POST", "/api/invites")).json;
	assert.equal(
		(await call(ben.token, "DELETE", `/api/invites/${code}`)).status,
		404,
	);
	assert.equal(
		(await call(luis.token, "DELETE", `/api/invites/${code}`)).status,
		204,
	);
	assert.equal((await call(null, "GET", `/api/invites/${code}`)).status, 404);
	assert.equal(
		(await call(ben.cookie, "POST", `/api/invites/${code}/accept`)).status,
		410,
	);
});

test("an invite to a project makes a member of its group, and only its owner makes one", async () => {
	const luis = await person("proj-luis");
	const ben = await person("proj-ben");
	const tristan = await person("proj-tristan");
	const group = (
		await call(luis.token, "POST", "/api/groups", { name: "Hedge" })
	).json.id;
	const project = (
		await call(luis.token, "POST", "/api/projects", { name: "vt", group })
	).json.id;
	const made = await call(luis.token, "POST", "/api/invites", { project });
	assert.equal(made.status, 201, made.text);
	assert.equal(made.json.project.group.name, "Hedge");
	const shown = await call(null, "GET", `/api/invites/${made.json.code}`);
	assert.deepEqual(shown.json.project, { name: "vt", group: "Hedge" });
	const accepted = await call(
		ben.cookie,
		"POST",
		`/api/invites/${made.json.code}/accept`,
	);
	assert.equal(accepted.status, 200, accepted.text);
	assert.equal(accepted.json.project.id, project);
	const groups = await call(ben.token, "GET", "/api/groups");
	assert.ok(groups.json.some((g: { id: string }) => g.id === group));
	// A member who isn't the owner invites to no project of the group.
	assert.equal(
		(await call(ben.token, "POST", "/api/invites", { project })).status,
		403,
	);
	// Nobody outside the group learns of it.
	assert.equal(
		(await call(tristan.token, "POST", "/api/invites", { project })).status,
		404,
	);
});

test("an OTP the person makes is traded once for a machine's token", async () => {
	const luis = await person("otp-luis");
	assert.equal((await call(luis.token, "POST", "/api/otp")).status, 403);
	const otp = await call(luis.cookie, "POST", "/api/otp");
	assert.equal(otp.status, 201, otp.text);
	assert.match(otp.json.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
	assert.equal(
		(
			await call(null, "POST", `/api/otp/${otp.json.code}/token`, {
				name: "Not A Name",
			})
		).status,
		400,
	);
	const traded = await call(
		null,
		"POST",
		`/api/otp/${otp.json.code.toLowerCase()}/token`,
		{ name: "luis-laptop" },
	);
	assert.equal(traded.status, 201, traded.text);
	assert.equal(traded.json.account, "otp-luis");
	const me = await call(traded.json.token, "GET", "/api/me");
	assert.equal(me.json.name, "otp-luis");
	const tokens = await call(luis.token, "GET", "/api/tokens");
	assert.ok(
		tokens.json.some((t: { name: string }) => t.name === "luis-laptop"),
	);
	assert.equal(
		(
			await call(null, "POST", `/api/otp/${otp.json.code}/token`, {
				name: "luis-laptop",
			})
		).status,
		410,
	);
});
