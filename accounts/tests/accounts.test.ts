import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
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
	ACCOUNTS_BRIDGES:
		"messagent 6ab53bae0eef33d30015a3069604e5f1ca5f9a5d71b53554cc0e2c8b164a4ce2 telegram\n",
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

/** An agent getting a token by an OTP, which its person approves. */
async function connect(personToken: string, agent: string): Promise<string> {
	const code = await call(null, "POST", "/api/auth/device/code", {
		client_id: agent,
	});
	assert.equal(code.status, 200, code.text);
	const claim = await call(
		personToken,
		"GET",
		`/api/auth/device?user_code=${code.json.user_code}`,
	);
	assert.equal(claim.status, 200, claim.text);
	const approve = await call(personToken, "POST", "/api/auth/device/approve", {
		userCode: code.json.user_code,
	});
	assert.equal(approve.status, 200, approve.text);
	const token = await call(null, "POST", "/api/auth/device/token", {
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		device_code: code.json.device_code,
		client_id: agent,
	});
	assert.equal(token.status, 200, token.text);
	return token.json.access_token;
}

let luis: string;
let ben: string;
let luisToken: string;
let benToken: string;
/** The project each has in their own group, with the session "agents" in it. */
let luisProject: string;
let benProject: string;

/** A new project of `someone`'s, in their own group or in `group`, by its id. */
async function project(
	someone: string,
	name: string,
	group?: string,
): Promise<string> {
	const created = await call(someone, "POST", "/api/projects", {
		name,
		...(group && { group }),
	});
	assert.equal(created.status, 201, created.text);
	return created.json.id;
}

/** A new session in `inProject`, as the API returns it. */
async function session(someone: string, name: string, inProject: string) {
	const created = await call(someone, "POST", "/api/sessions", {
		name,
		project: inProject,
	});
	assert.equal(created.status, 201, created.text);
	return created.json;
}

before(async () => {
	({ cookie: luis, token: luisToken } = await person("luis"));
	({ cookie: ben, token: benToken } = await person("ben"));
	luisProject = await project(luis, "vibetogether");
	benProject = await project(ben, "vibetogether");
	await session(luis, "agents", luisProject);
	await session(ben, "agents", benProject);
});

test("a person signs in with GitHub, and is named by their login", async () => {
	// GitHub's side of the sign-in, as Better Auth's provider calls it.
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input instanceof Request ? input.url : input);
		const json = (body: unknown) => Response.json(body);
		if (url.startsWith("https://github.com/login/oauth/access_token"))
			return json({
				access_token: "gho_test",
				token_type: "bearer",
				scope: "read:user,user:email",
			});
		if (url === "https://api.github.com/user")
			return json({
				id: 4242,
				login: "OctoCat",
				name: null,
				email: null,
				avatar_url: "https://avatars.example/4242",
			});
		if (url === "https://api.github.com/user/emails")
			return json([
				{ email: "octocat@example.com", primary: true, verified: true },
			]);
		return realFetch(input, init);
	}) as typeof fetch;
	try {
		const started = await app.request("/api/auth/sign-in/social", {
			method: "POST",
			headers: {
				origin: "http://localhost:3000",
				"content-type": "application/json",
			},
			body: JSON.stringify({ provider: "github", callbackURL: "/account/" }),
		});
		assert.equal(started.status, 200, await started.clone().text());
		const state = new URL(((await started.json()) as any).url).searchParams.get(
			"state",
		);
		const cookie = started.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");
		const back = await app.request(
			`/api/auth/callback/github?code=test&state=${state}`,
			{ headers: { cookie } },
		);
		const location = back.headers.get("location") ?? "";
		assert.equal(back.status, 302, location);
		assert.equal(location, "/account/");
		const session = back.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");
		assert.equal(
			(await call(`cookie:${session}`, "GET", "/api/me")).json.name,
			"octocat",
		);
		// The login is input to Better Auth, so no request may change it afterwards.
		assert.equal(
			(
				await call(`cookie:${session}`, "POST", "/api/auth/update-user", {
					login: "luis",
				})
			).status,
			404,
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a request without a token is refused", async () => {
	assert.equal((await call(null, "GET", "/api/me")).status, 401);
});

test("me", async () => {
	assert.deepEqual((await call(luis, "GET", "/api/me")).json, {
		name: "luis",
		displayName: "luis",
		image: null,
	});
});

test("an account starts with its own group and no session", async () => {
	const { cookie: erin } = await person("erin");
	assert.deepEqual((await call(erin, "GET", "/api/sessions")).json, []);
	assert.deepEqual((await call(erin, "GET", "/api/projects")).json, []);
	const [own, ...rest] = (await call(erin, "GET", "/api/groups")).json;
	assert.deepEqual(rest, []);
	assert.deepEqual(
		{ ...own, id: undefined },
		{ id: undefined, name: "erin", own: true, members: ["erin"] },
	);
	const sessions = (await call(luis, "GET", "/api/sessions")).json;
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].name, "agents");
	assert.deepEqual(sessions[0].project, {
		id: luisProject,
		name: "vibetogether",
	});
	assert.equal(sessions[0].group.name, "luis");
	assert.match(sessions[0].id, /^s_/);
	assert.match(sessions[0].address, /\/v2\/s\/session-\d+$/);
	// A session goes into a project, of a group of the caller's.
	assert.equal(
		(await call(luis, "POST", "/api/sessions", { name: "nowhere" })).status,
		400,
	);
	assert.equal(
		(
			await call(luis, "POST", "/api/sessions", {
				name: "theirs",
				project: benProject,
			})
		).status,
		404,
	);
});

test("an agent gets a token by an OTP, joins its session, and is cut off once the token is revoked", async () => {
	const token = await connect(luis, "claude");
	assert.equal((await call(token, "GET", "/api/me")).json.name, "luis");
	const tokens = (await call(luis, "GET", "/api/tokens")).json;
	assert.equal(tokens.length, 1);
	assert.deepEqual(Object.keys(tokens[0]).sort(), [
		"created",
		"id",
		"kind",
		"name",
	]);
	assert.equal(tokens[0].name, "claude");
	assert.equal(tokens[0].kind, "machine");

	const [owned] = (await call(token, "GET", "/api/sessions")).json;
	const session = owned.address.split("/").pop();
	const join = (name: string, as: string | null) =>
		call(null, "POST", "/agentwire/join", {
			session,
			name,
			token: as,
			owned: true,
		});
	assert.equal((await join("luis/claude", token)).json.account, "luis");
	assert.equal((await join("ben/claude", token)).status, 403);
	assert.equal((await join("luis/claude", null)).status, 403);
	assert.equal((await join("ben", benToken)).status, 403);
	assert.deepEqual(
		(await call(null, "GET", `/agentwire/sessions/${session}`)).json,
		{},
	);

	assert.equal(
		(await call(luis, "DELETE", `/api/tokens/${tokens[0].id}`)).status,
		204,
	);
	assert.equal((await join("luis/claude", token)).status, 403);
	assert.equal((await call(token, "GET", "/api/me")).status, 401);
});

test("a machine's token is minted by the person or an agent, and goes with the token that minted it", async () => {
	const minted = await call(ben, "POST", "/api/tokens", {
		name: "ben-laptop",
	});
	assert.equal(minted.status, 201, minted.text);
	assert.equal(minted.json.name, "ben-laptop");
	assert.equal(minted.json.kind, "machine");
	const token: string = minted.json.token;
	assert.equal((await call(token, "GET", "/api/me")).json.name, "ben");
	const tokens = (await call(ben, "GET", "/api/tokens")).json;
	const listed = tokens.find((t: { id: string }) => t.id === minted.json.id);
	assert.equal(listed.name, "ben-laptop");
	assert.equal(listed.token, undefined);

	// An agent mints one too, which goes with the token that minted it.
	const more = await call(token, "POST", "/api/tokens", { name: "more" });
	assert.equal(more.status, 201, more.text);
	const copy = await call(more.json.token, "POST", "/api/tokens", {
		name: "copy",
	});
	assert.equal(copy.status, 201, copy.text);
	assert.equal((await call(token, "DELETE", "/api/tokens/self")).status, 204);
	assert.equal((await call(more.json.token, "GET", "/api/me")).status, 401);
	assert.equal((await call(copy.json.token, "GET", "/api/me")).status, 401);
	const elsewhere = await app.request("/api/tokens", {
		method: "POST",
		headers: {
			origin: "https://elsewhere.lwirth.com",
			cookie: ben.slice("cookie:".length),
			"content-type": "application/json",
		},
		body: JSON.stringify({ name: "stolen" }),
	});
	assert.equal(elsewhere.status, 403);
	assert.equal(
		(await call(ben, "POST", "/api/tokens", { name: "Not A Name" })).status,
		400,
	);
	assert.equal(
		(await call(ben, "DELETE", `/api/tokens/${minted.json.id}`)).status,
		404,
	);
	assert.equal((await call(token, "GET", "/api/me")).status, 401);
});

test("the relay keeps a grant in place of the token, which works for that participant alone, and as long as the token", async () => {
	from = "192.0.2.51";
	const token = await connect(luis, "granted");
	from = undefined;
	const owned = await session(luis, "granted", luisProject);
	const address = owned.address.split("/").pop();
	const ask = (body: Record<string, unknown>) =>
		call(null, "POST", "/agentwire/join", {
			session: address,
			name: "luis/claude",
			token: null,
			owned: true,
			...body,
		});
	const joined = await ask({ token });
	assert.equal(joined.json.account, "luis");
	const grant: string = joined.json.grant;
	assert.match(grant, /^g1\./);
	assert.ok(!grant.includes(token));
	const byGrant = await ask({ grant });
	assert.equal(byGrant.status, 200, byGrant.text);
	assert.equal(byGrant.json.account, "luis");
	// For that participant alone: not another name, not another session, not altered.
	assert.equal((await ask({ grant, name: "luis/other" })).status, 403);
	assert.equal((await ask({ grant, session: "elsewhere" })).status, 403);
	assert.equal((await ask({ grant: `${grant.slice(0, -2)}xx` })).status, 403);
	assert.equal((await ask({ grant, token })).status, 400);
	// It acts for the token, and no longer than it.
	const [listed] = (await call(luis, "GET", "/api/tokens")).json.filter(
		(t: any) => t.name === "granted",
	);
	assert.equal(
		(await call(luis, "DELETE", `/api/tokens/${listed.id}`)).status,
		204,
	);
	assert.equal((await ask({ grant })).status, 403);
	// A person's own sign-in, which a page joins with, gets one too, in their own group alone.
	const own = await ask({ token: luisToken, name: "luis/reader" });
	assert.equal(own.status, 200, own.text);
	assert.equal(
		(await ask({ grant: own.json.grant, name: "luis/reader" })).json.account,
		"luis",
	);
	await call(luis, "DELETE", `/api/sessions/${owned.id}`);
});

test("a session no account owns is open to anyone, and a token verifies the name", async () => {
	const join = (name: string, token: string | null) =>
		call(null, "POST", "/agentwire/join", {
			session: "throwaway",
			name,
			token,
		});
	assert.equal((await join("anyone/claude", null)).json.account, null);
	assert.equal((await join("luis/claude", luisToken)).json.account, "luis");
	// A token is an agent's: never the person's own name.
	assert.equal((await join("luis", luisToken)).status, 403);
	assert.equal((await join("ben", luisToken)).status, 403);
	assert.equal((await join("luis", "no-such-token")).status, 403);
	assert.equal(
		(await call(null, "GET", "/agentwire/sessions/throwaway")).status,
		404,
	);
	// An owned session the service doesn't know is one that was deleted.
	const owned = await call(null, "POST", "/agentwire/join", {
		session: "throwaway",
		name: "luis/claude",
		token: luisToken,
		owned: true,
	});
	assert.equal(owned.status, 403);
});

test("friends are mutual, members are equal, and leaving a group ends access", async () => {
	const created = await call(luis, "POST", "/api/groups", {
		name: "Potential Hedge",
	});
	assert.equal(created.status, 201, created.text);
	const group = created.json.id;
	assert.deepEqual(created.json.members, ["luis"]);
	assert.equal(
		(await call(luis, "PUT", `/api/groups/${group}/members/ben`)).status,
		403,
	);

	assert.equal((await call(luis, "PUT", "/api/friends/ben")).status, 204);
	assert.equal(
		(await call(luis, "GET", "/api/friends")).json[0].state,
		"asked",
	);
	assert.equal(
		(await call(ben, "GET", "/api/friends")).json[0].state,
		"asking",
	);
	assert.equal((await call(ben, "PUT", "/api/friends/luis")).status, 204);
	assert.deepEqual(
		(await call(ben, "GET", "/api/friends")).json.map((f: any) => [
			f.name,
			f.state,
		]),
		[["luis", "friends"]],
	);
	// Nobody joins a person's own group.
	const [own] = (await call(luis, "GET", "/api/groups")).json;
	assert.equal(own.own, true);
	assert.equal(
		(await call(luis, "PUT", `/api/groups/${own.id}/members/ben`)).status,
		403,
	);
	// A group shows to its members only.
	assert.equal(
		(await call(ben, "PUT", `/api/groups/${group}/members/ben`)).status,
		404,
	);
	const added = await call(luis, "PUT", `/api/groups/${group}/members/ben`);
	assert.deepEqual(added.json.members, ["ben", "luis"]);

	// A member creates projects and sessions in it, and every member joins them.
	const shared = await project(ben, "collective", group);
	const owned = await session(ben, "hedge", shared);
	assert.deepEqual(owned.group, { id: group, name: "Potential Hedge" });
	const address = owned.address.split("/").pop();
	const join = (name: string, token: string) =>
		call(null, "POST", "/agentwire/join", {
			session: address,
			name,
			token,
			owned: true,
		});
	assert.equal((await join("luis/claude", luisToken)).json.account, "luis");
	assert.equal((await join("ben/claude", benToken)).json.account, "ben");
	assert.equal((await call(ben, "GET", "/api/sessions")).json.length, 2);
	// Members are equal, and so are their agents: any of them renames and deletes.
	assert.equal(
		(await call(ben, "PATCH", `/api/sessions/${owned.id}`, { name: "hedging" }))
			.json.name,
		"hedging",
	);
	assert.equal(owned.creator, "ben");
	const luiss = await session(luis, "luis-made", shared);
	assert.equal(
		(await call(benToken, "DELETE", `/api/sessions/${luiss.id}`)).status,
		204,
	);

	// Leaving the group ends access at once, to the session and its project.
	assert.equal(
		(await call(ben, "DELETE", `/api/groups/${group}/members/ben`)).status,
		204,
	);
	assert.equal((await join("ben/claude", benToken)).status, 403);
	assert.equal((await join("luis/claude", luisToken)).json.account, "luis");
	assert.equal(
		(await call(ben, "PATCH", `/api/projects/${shared}`, { name: "back" }))
			.status,
		404,
	);
	assert.equal(
		(await call(ben, "PATCH", `/api/sessions/${owned.id}`, { name: "back" }))
			.status,
		404,
	);
	assert.equal((await call(ben, "GET", "/api/sessions")).json.length, 1);

	// Deleting the group deletes its projects and sessions; one's own group stays.
	assert.equal(
		(await call(luis, "DELETE", `/api/groups/${own.id}`)).status,
		403,
	);
	assert.equal(
		(await call(luisToken, "DELETE", `/api/groups/${group}`)).status,
		204,
	);
	assert.equal((await join("luis/claude", luisToken)).status, 403);
	assert.equal(
		(await call(luis, "GET", "/api/projects")).json.some(
			(p: any) => p.id === shared,
		),
		false,
	);
});

test("sessions are created and renamed by their group's members, and deleted by their creator", async () => {
	const created = await call(luis, "POST", "/api/sessions", {
		name: "formoniq",
		project: luisProject,
	});
	assert.equal(created.status, 201);
	assert.equal(
		(
			await call(ben, "PATCH", `/api/sessions/${created.json.id}`, {
				name: "mine",
			})
		).status,
		404,
	);
	assert.equal(
		(
			await call(luis, "PATCH", `/api/sessions/${created.json.id}`, {
				name: "feec",
			})
		).json.name,
		"feec",
	);
	assert.equal(
		(
			await call(luis, "POST", "/api/sessions", {
				name: " ",
				project: luisProject,
			})
		).status,
		400,
	);
	assert.equal(
		(await call(luis, "DELETE", `/api/sessions/${created.json.id}`)).status,
		204,
	);
	const session = created.json.address.split("/").pop();
	assert.equal(
		(await call(null, "GET", `/agentwire/sessions/${session}`)).status,
		404,
	);
	assert.equal(
		(
			await call(null, "POST", "/agentwire/join", {
				session,
				name: "luis/claude",
				token: luisToken,
				owned: true,
			})
		).status,
		403,
	);
});

test("a project points at GitHub repos, which a join into its sessions tells", async () => {
	const created = await call(luis, "POST", "/api/projects", {
		name: "formoniq",
		repos: [
			"luiswirth/formoniq",
			"https://github.com/luiswirth/formoniq-studio.git",
		],
	});
	assert.equal(created.status, 201, created.text);
	assert.deepEqual(created.json.repos, [
		"https://github.com/luiswirth/formoniq",
		"https://github.com/luiswirth/formoniq-studio",
	]);
	const id = created.json.id;
	for (const repos of [
		["luiswirth"],
		["https://gitlab.com/a/b"],
		["a/b/c"],
		["-a/b"],
		["a/.."],
		"a/b",
		[1],
		Array.from({ length: 21 }, (_, i) => `a/r${i}`),
	])
		assert.equal(
			(await call(luis, "PATCH", `/api/projects/${id}`, { repos })).status,
			400,
			JSON.stringify(repos),
		);
	const changed = await call(luis, "PATCH", `/api/projects/${id}`, {
		repos: [
			"luiswirth/formoniq-studio",
			"LuisWirth/Formoniq-Studio",
			"luiswirth/formoniq",
		],
	});
	assert.equal(changed.status, 200, changed.text);
	assert.equal(changed.json.name, "formoniq");
	assert.deepEqual(changed.json.repos, [
		"https://github.com/luiswirth/formoniq-studio",
		"https://github.com/luiswirth/formoniq",
	]);
	assert.deepEqual(
		(await call(luisToken, "GET", "/api/projects")).json.find(
			(p: { id: string }) => p.id === id,
		).repos,
		changed.json.repos,
	);
	// Someone outside the group neither sees nor changes them.
	assert.equal(
		(await call(ben, "PATCH", `/api/projects/${id}`, { repos: [] })).status,
		404,
	);
	const { address } = await session(luis, "agents", id);
	const joined = await call(null, "POST", "/agentwire/join", {
		session: address.split("/").pop(),
		name: "luis/claude",
		token: luisToken,
		owned: true,
	});
	assert.equal(joined.status, 200, joined.text);
	assert.deepEqual(joined.json.about, {
		project: "formoniq",
		repos: changed.json.repos,
		bridges: [],
	});
	// Someone outside the group is refused, and learns nothing of the project.
	const outsider = await call(null, "POST", "/agentwire/join", {
		session: address.split("/").pop(),
		name: "ben/claude",
		token: benToken,
		owned: true,
	});
	assert.equal(outsider.status, 403, outsider.text);
	assert.equal(outsider.text.includes("formoniq"), false);
	// Reading without joining takes the same: a member's token.
	const read = (token: string | null) =>
		call(null, "POST", "/agentwire/read", {
			session: address.split("/").pop(),
			token,
			owned: true,
		});
	assert.equal((await read(luisToken)).json.account, "luis");
	assert.equal((await read(benToken)).status, 403);
	assert.equal((await read(null)).status, 403);
	// A session no account owns says nothing about itself.
	const unowned = await call(null, "POST", "/agentwire/join", {
		session: "unknown",
		name: "luis/claude",
		token: luisToken,
		owned: false,
	});
	assert.equal(unowned.json.about, undefined);
	assert.equal(
		(await call(luis, "PATCH", `/api/projects/${id}`, { repos: [] })).json.repos
			.length,
		0,
	);
});

test("an agent through MCP signs in by OAuth, and is cut off once revoked", async () => {
	const { createHash, randomBytes } = await import("node:crypto");
	const redirect = "http://127.0.0.1:9999/callback";
	const registered = await call(null, "POST", "/api/auth/oauth2/register", {
		client_name: "Claude Code",
		redirect_uris: [redirect],
		token_endpoint_auth_method: "none",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
	});
	assert.equal(registered.status, 201, registered.text);
	const clientId = registered.json.client_id;

	/** One authorization of the client, which asks for consent only the first time. */
	let consentAsked = false;
	async function authorizeOnce(): Promise<string> {
		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const query = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirect,
			scope: "openid offline_access",
			state: "s",
			code_challenge: challenge,
			code_challenge_method: "S256",
			resource: "http://localhost:3000/mcp",
		});
		const authorize = await app.request(`/api/auth/oauth2/authorize?${query}`, {
			headers: { cookie: luis.slice("cookie:".length) },
		});
		let next = new URL(
			authorize.headers.get("location") ?? "",
			"http://localhost:3000",
		);
		consentAsked = next.pathname === "/account/consent/";
		if (consentAsked) {
			const consent = await call(luis, "POST", "/api/auth/oauth2/consent", {
				accept: true,
				oauth_query: next.search.slice(1),
			});
			assert.equal(consent.status, 200, consent.text);
			next = new URL(consent.json.url);
		}
		const code = next.searchParams.get("code");
		assert.ok(code, next.toString());
		const response = await app.request("/api/auth/oauth2/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirect,
				client_id: clientId,
				code_verifier: verifier,
				resource: "http://localhost:3000/mcp",
			}),
		});
		const tokens = (await response.json()) as any;
		assert.equal(response.status, 200, JSON.stringify(tokens));
		assert.match(tokens.access_token, /^vt_at_/);
		return tokens.access_token;
	}

	const first = await authorizeOnce();
	const second = await authorizeOnce();
	assert.equal((await call(first, "GET", "/api/me")).json.name, "luis");

	const join = (token: string) =>
		call(null, "POST", "/agentwire/join", {
			session: "throwaway",
			name: "luis/claude",
			token,
		});
	assert.equal((await join(first)).json.account, "luis");

	const agents = (await call(luis, "GET", "/api/tokens")).json.filter(
		(a: any) => a.name === "Claude Code",
	);
	assert.equal(agents.length, 2);
	assert.equal(agents[0].name, "Claude Code");
	assert.equal(agents[0].kind, "mcp");
	assert.match(agents[0].id, /^[A-Za-z0-9_-]+$/);
	assert.equal(
		(await call(luis, "DELETE", `/api/tokens/${agents[0].id}`)).status,
		204,
	);
	// Both sign-ins can share a second, so either may be listed first: exactly one is cut off.
	const cut = (await join(first)).status === 403 ? first : second;
	const kept = cut === first ? second : first;
	assert.equal((await join(cut)).status, 403);
	assert.equal((await call(cut, "GET", "/api/me")).status, 401);
	assert.equal((await join(kept)).json.account, "luis");
	// Revoking took the consent too, so the client asks the person again.
	await authorizeOnce();
	assert.ok(consentAsked);
});

test("the OAuth server and the MCP resource are discoverable", async () => {
	const server = await call(
		null,
		"GET",
		"/.well-known/oauth-authorization-server/api/auth",
	);
	assert.equal(server.status, 200, server.text);
	assert.equal(server.json.issuer, "http://localhost:3000/api/auth");
	const resource = await call(
		null,
		"GET",
		"/.well-known/oauth-protected-resource/mcp",
	);
	assert.equal(resource.status, 200, resource.text);
	assert.equal(resource.json.resource, "http://localhost:3000/mcp");
});

test("a token reaches none of Better Auth's endpoints for sessions, the user, consent or approval", async () => {
	const token = await connect(luis, "walker");
	const routes: [string, string, unknown?][] = [
		["GET", "/api/auth/get-session"],
		["GET", "/api/auth/list-sessions"],
		["POST", "/api/auth/revoke-session", { token: luisToken }],
		["POST", "/api/auth/revoke-sessions", {}],
		["POST", "/api/auth/revoke-other-sessions", {}],
		["POST", "/api/auth/update-user", { name: "someone else" }],
		["POST", "/api/auth/delete-user", {}],
		["GET", "/api/auth/list-accounts"],
		["POST", "/api/auth/unlink-account", { providerId: "github" }],
		["POST", "/api/auth/sign-out", {}],
		["GET", "/api/auth/device?user_code=ABCDEFGH"],
		["POST", "/api/auth/device/approve", { userCode: "ABCDEFGH" }],
		["POST", "/api/auth/device/deny", { userCode: "ABCDEFGH" }],
		["POST", "/api/auth/oauth2/consent", { accept: true, oauth_query: "" }],
		["POST", "/api/auth/oauth2/continue", { postLogin: true }],
		["GET", "/api/auth/oauth2/get-consents"],
		[
			"POST",
			"/api/auth/oauth2/create-client",
			{ redirect_uris: ["https://evil.example/cb"] },
		],
	];
	for (const [method, path, body] of routes)
		assert.equal(
			(await call(token, method, path, body)).status,
			403,
			`${method} ${path}`,
		);
	assert.equal(
		(await call(luis, "GET", "/api/auth/list-sessions")).status,
		200,
	);
	assert.equal((await call(token, "GET", "/api/me")).status, 200);
});

test("an agent adds friends and members, which its person sees, and which are limited per hour", async () => {
	const token = await connect(ben, "helper");
	const { cookie: dora } = await person("dot");
	await call(dora, "PUT", "/api/friends/ben");
	assert.equal((await call(token, "PUT", "/api/friends/dot")).status, 204);
	const group = (await call(token, "POST", "/api/groups", { name: "helpers" }))
		.json.id;
	assert.equal(
		(await call(token, "PUT", `/api/groups/${group}/members/dot`)).status,
		200,
	);
	const activity = (await call(ben, "GET", "/api/activity")).json;
	assert.deepEqual(
		activity.slice(0, 3).map((a: any) => [a.agent, a.operation, a.arguments]),
		[
			["helper", "add_group_member", { id: group, name: "dot" }],
			["helper", "create_group", { name: "helpers" }],
			["helper", "add_friend", { name: "dot" }],
		],
	);
	// A sign-in's own token as a bearer is recorded too, and mints no token.
	await call(benToken, "PATCH", `/api/groups/${group}`, { name: "helpers" });
	assert.equal(
		(await call(ben, "GET", "/api/activity")).json[0].agent,
		"a sign-in",
	);
	assert.equal(
		(await call(benToken, "POST", "/api/tokens", { name: "sneaky" })).status,
		403,
	);
	const recorded = (await call(ben, "GET", "/api/activity")).json.length;
	// The person in the browser is not recorded.
	await call(ben, "PATCH", `/api/groups/${group}`, { name: "helping" });
	assert.equal((await call(ben, "GET", "/api/activity")).json.length, recorded);
	for (let i = 0; i < 19; i++)
		assert.equal((await call(token, "PUT", "/api/friends/dot")).status, 204);
	assert.equal((await call(token, "PUT", "/api/friends/dot")).status, 429);
	assert.equal((await call(ben, "PUT", "/api/friends/dot")).status, 204);
	// Members are friends of whoever added them, and stay when the friendship ends.
	assert.equal((await call(dora, "DELETE", "/api/friends/ben")).status, 204);
	assert.deepEqual(
		(await call(ben, "GET", "/api/groups")).json.find(
			(g: any) => g.id === group,
		).members,
		["ben", "dot"],
	);
	assert.equal(
		(await call(dora, "DELETE", `/api/groups/${group}/members/dot`)).status,
		204,
	);
	// The last member leaves only by deleting the group.
	assert.equal(
		(await call(ben, "DELETE", `/api/groups/${group}/members/ben`)).status,
		409,
	);
	assert.equal(
		(await call(token, "DELETE", `/api/groups/${group}`)).status,
		204,
	);
	assert.equal(
		(await call(ben, "GET", `/api/groups`)).json.some(
			(g: any) => g.id === group,
		),
		false,
	);
});

test("the account is deleted by the person alone, in the browser, with what is only theirs", async () => {
	const { cookie: fay, token: fayToken } = await person("fay");
	const group = (await call(fay, "POST", "/api/groups", { name: "fay's" })).json
		.id;
	await call(fay, "PUT", "/api/friends/luis");
	await call(luis, "PUT", "/api/friends/fay");
	const shared = (await call(fay, "POST", "/api/groups", { name: "shared" }))
		.json.id;
	assert.equal(
		(await call(fay, "PUT", `/api/groups/${shared}/members/luis`)).status,
		200,
	);
	assert.equal((await call(fayToken, "DELETE", "/api/me")).status, 403);
	assert.equal((await call(fay, "DELETE", "/api/me")).status, 204);
	assert.equal((await call(fay, "GET", "/api/me")).status, 401);
	assert.equal((await call(fayToken, "GET", "/api/me")).status, 401);
	assert.equal(
		(await call(luis, "PUT", `/api/groups/${group}/members/luis`)).status,
		404,
	);
	// A group with others in it outlives the account.
	assert.deepEqual(
		(await call(luis, "GET", "/api/groups")).json.find(
			(g: any) => g.id === shared,
		)?.members,
		["luis"],
	);
});

test("the overview holds the account, its groups with projects and sessions, DMs and friends", async () => {
	const overview = (await call(luisToken, "GET", "/api/overview")).json;
	assert.equal(overview.account.name, "luis");
	const own = overview.groups[0];
	assert.equal(own.own, true);
	const sessions = (await call(luis, "GET", "/api/sessions")).json;
	assert.deepEqual(
		overview.groups.flatMap((g: any) =>
			g.projects.flatMap((p: any) => p.sessions),
		),
		sessions,
	);
	assert.deepEqual(
		overview.friends,
		(await call(luis, "GET", "/api/friends")).json,
	);
	assert.deepEqual(overview.dms, (await call(luis, "GET", "/api/dms")).json);
});

test("every operation is in the document, which anyone reads", async () => {
	const response = await call(null, "GET", "/api/openapi.json");
	assert.equal(response.status, 200);
	const ids = Object.values(response.json.paths).flatMap((path: any) =>
		Object.values(path).map((op: any) => op.operationId),
	);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(ids.includes("overview") && ids.includes("delete_account"));
	assert.deepEqual(response.json.paths["/me"].delete.security, [
		{ browser: [] },
	]);
	// The reference is rendered from it, word for word.
	const reference = await call(null, "GET", "/api/reference.md");
	assert.equal(reference.status, 200);
	assert.ok(
		reference.text.includes(response.json.paths["/groups"].post.description),
	);
	assert.ok(
		reference.text.includes("`POST /api/auth/device/code` (`request_otp`)"),
	);
	// A body that isn't what the operation takes is refused with what is wrong.
	const bad = await call(luisToken, "POST", "/api/groups", { name: 7 });
	assert.equal(bad.status, 400);
	assert.match(bad.text, /name/);
});

test("two friends have a DM, which only they and their agents join, and only while they are friends", async () => {
	const { cookie: gwen, token: gwenToken } = await person("gwen");
	const { cookie: hana } = await person("hana");
	const { token: ivanToken } = await person("ivan");
	await call(gwen, "PUT", "/api/friends/hana");
	// Asking is no friendship yet.
	assert.deepEqual((await call(gwen, "GET", "/api/dms")).json, []);
	await call(hana, "PUT", "/api/friends/gwen");
	const [dm] = (await call(gwen, "GET", "/api/dms")).json;
	assert.equal(dm.friend, "hana");
	assert.deepEqual(
		(await call(hana, "GET", "/api/dms")).json.map((d: any) => [
			d.id,
			d.friend,
			d.address,
		]),
		[[dm.id, "gwen", dm.address]],
	);
	// A DM is in no group, so no session list shows it, and nobody renames or deletes it.
	assert.ok(
		!(await call(gwen, "GET", "/api/sessions")).json.some(
			(s: any) => s.id === dm.id,
		),
	);
	assert.equal(
		(await call(gwen, "DELETE", `/api/sessions/${dm.id}`)).status,
		404,
	);
	const address = dm.address.split("/").pop();
	assert.equal(
		(await call(null, "GET", `/agentwire/sessions/${address}`)).status,
		200,
	);
	const join = (name: string, token: string | null) =>
		call(null, "POST", "/agentwire/join", {
			session: address,
			name,
			token,
			owned: true,
		});
	assert.equal((await join("gwen/claude", gwenToken)).json.account, "gwen");
	assert.equal((await join("gwen", gwenToken)).status, 403);
	assert.equal((await join("ivan/claude", ivanToken)).status, 403);
	assert.equal((await join("anyone", null)).status, 403);
	// Unfriending ends access; becoming friends again brings the same DM back.
	await call(hana, "DELETE", "/api/friends/gwen");
	assert.deepEqual((await call(gwen, "GET", "/api/dms")).json, []);
	assert.equal((await join("gwen/claude", gwenToken)).status, 403);
	await call(hana, "PUT", "/api/friends/gwen");
	await call(gwen, "PUT", "/api/friends/hana");
	assert.equal((await call(gwen, "GET", "/api/dms")).json[0].id, dm.id);
	assert.equal((await join("gwen/claude", gwenToken)).status, 200);
});

test("a project holds at most 20 sessions", async () => {
	const { cookie: dora } = await person("dora");
	const doras = await project(dora, "many");
	for (let i = 1; i <= 20; i++) await session(dora, `r${i}`, doras);
	assert.equal(
		(
			await call(dora, "POST", "/api/sessions", {
				name: "one too many",
				project: doras,
			})
		).status,
		403,
	);
});

test("an OTP's page says when and from where it was asked for", async () => {
	const response = await app.request("/api/auth/device/code", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-forwarded-for": "203.0.113.7",
		},
		body: JSON.stringify({ client_id: "stranger" }),
	});
	const code = (await response.json()) as any;
	const page = await call(
		luis,
		"GET",
		`/api/auth/device?user_code=${code.user_code}`,
	);
	assert.equal(page.json.client_id, "stranger");
	assert.equal(page.json.from, "203.0.113.7");
	assert.ok(Date.now() - Date.parse(page.json.requested) < 10_000);
});

test("asking for OTPs is rate limited", async () => {
	const ask = () =>
		app.request("/api/auth/device/code", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": "198.51.100.9",
			},
			body: JSON.stringify({ client_id: "flood" }),
		});
	const statuses = [];
	for (let i = 0; i < 12; i++) statuses.push((await ask()).status);
	assert.ok(statuses.includes(429), statuses.join(" "));
});

test("a bridge asks for OTPs and polls them apart from its address's limit, and only with its secret", async () => {
	const ask = (body: Record<string, string>, headers = {}) =>
		app.request("/api/auth/device/code", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": "198.51.100.10",
				...headers,
			},
			body: JSON.stringify({
				client_id: "messagent",
				scope: "bridge",
				...body,
			}),
		});
	const codes = [];
	for (let i = 0; i < 15; i++) {
		const response = await ask({ client_secret: "a-secret-of-the-bot" });
		assert.equal(response.status, 200, await response.clone().text());
		codes.push(((await response.json()) as any).device_code);
	}
	for (let i = 0; i < 110; i++) {
		const response = await app.request("/api/auth/device/token", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": "198.51.100.10",
			},
			body: JSON.stringify({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: codes[i % codes.length],
				client_id: "messagent",
				client_secret: "a-secret-of-the-bot",
			}),
		});
		assert.notEqual(response.status, 429, `poll ${i}`);
	}
	// A request can't claim to be a checked bridge: the mark is the service's own.
	const statuses = [];
	for (let i = 0; i < 12; i++)
		statuses.push(
			(
				await app.request("/api/auth/device/code", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-forwarded-for": "198.51.100.11",
						"x-vibetogether-bridge": "a-guess",
					},
					body: JSON.stringify({ client_id: "flood" }),
				})
			).status,
		);
	assert.ok(statuses.includes(429), statuses.join(" "));
});

/** A bridge's OTP, asked for with its secret. */
async function askAsBridge(body: Record<string, string> = {}) {
	const code = await call(null, "POST", "/api/auth/device/code", {
		client_id: "messagent",
		client_secret: "a-secret-of-the-bot",
		scope: "bridge",
		...body,
	});
	assert.equal(code.status, 200, code.text);
	return code.json as { user_code: string; device_code: string };
}

/** The bridge's grant for an OTP approved, by its secret. */
async function redeemAsBridge(deviceCode: string, secret?: string) {
	return call(null, "POST", "/api/auth/device/token", {
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		device_code: deviceCode,
		client_id: "messagent",
		...(secret && { client_secret: secret }),
	});
}

/** `someone`'s grant to messagent, which they approve. */
async function grantOf(someone: string): Promise<string> {
	const code = await askAsBridge();
	await call(someone, "GET", `/api/auth/device?user_code=${code.user_code}`);
	const approved = await call(someone, "POST", "/api/auth/device/approve", {
		userCode: code.user_code,
	});
	assert.equal(approved.status, 200, approved.text);
	const redeemed = await redeemAsBridge(
		code.device_code,
		"a-secret-of-the-bot",
	);
	assert.equal(redeemed.status, 200, redeemed.text);
	return redeemed.json.access_token;
}

test("a person grants a bridge to speak as them, and it mirrors rooms onto their sessions by it", async () => {
	from = "192.0.2.44";
	const ask = (body: Record<string, string>) =>
		call(null, "POST", "/api/auth/device/code", {
			client_id: "messagent",
			scope: "bridge",
			...body,
		});
	// The client_id alone is public, so it is no proof of the bridge.
	assert.equal((await ask({})).status, 401);
	assert.equal((await ask({ client_secret: "a-guess" })).status, 401);
	assert.equal(
		(
			await call(null, "POST", "/api/auth/device/code", {
				client_id: "laptop",
				client_secret: "a-secret-of-the-bot",
				scope: "bridge",
			})
		).status,
		401,
	);

	const group = (await call(luis, "POST", "/api/groups", { name: "Bridged" }))
		.json.id;
	assert.equal(
		(await call(luis, "PUT", `/api/groups/${group}/members/ben`)).status,
		200,
	);
	const shared = await project(luis, "telegram", group);
	const chat = await session(luis, "chat", shared);
	const elsewhere = await session(luis, "elsewhere", luisProject);
	const [benOwn] = (await call(ben, "GET", "/api/sessions")).json.filter(
		(s: any) => s.group.name === "ben",
	);

	// The OTP asks only to speak as the person: nothing of the messenger is kept but its words.
	const code = await askAsBridge({
		for: "Telegram user 123 @luiswirth",
		identity: "123",
	});
	const page = await call(
		luis,
		"GET",
		`/api/auth/device?user_code=${code.user_code}`,
	);
	assert.equal(page.status, 200, page.text);
	assert.equal(page.json.client_id, "messagent");
	assert.equal(page.json.bridge, true);
	assert.equal(page.json.for, "Telegram user 123 @luiswirth");
	assert.equal(page.json.identity, undefined);
	assert.equal(
		(
			await call(luis, "POST", "/api/auth/device/approve", {
				userCode: code.user_code,
			})
		).status,
		200,
	);
	assert.equal((await redeemAsBridge(code.device_code)).status, 401);
	const redeemed = await redeemAsBridge(
		code.device_code,
		"a-secret-of-the-bot",
	);
	assert.equal(redeemed.status, 200, redeemed.text);
	const grant = redeemed.json.access_token;

	// A grant is no token, and reaches nothing but the bridge's own operations.
	assert.equal(
		(await call(luis, "GET", "/api/tokens")).json.some(
			(t: any) => t.name === "messagent",
		),
		false,
	);
	for (const [method, path] of [
		["GET", "/api/me"],
		["GET", "/api/sessions"],
		["POST", "/api/groups"],
		["DELETE", "/api/tokens/self"],
	] as const)
		assert.equal(
			(
				await call(
					grant,
					method,
					path,
					method === "GET" ? undefined : { name: "x" },
				)
			).status,
			403,
			path,
		);
	assert.equal((await call(luisToken, "GET", "/api/bridges/self")).status, 404);
	const self = await call(grant, "GET", "/api/bridges/self");
	assert.equal(self.status, 200, self.text);
	assert.equal(self.json.bridge, "messagent");
	assert.equal(self.json.account, "luis");
	assert.match(self.json.id, /^b_/);
	assert.deepEqual(self.json.rooms, []);
	const listed = (await call(luis, "GET", "/api/bridges")).json;
	assert.deepEqual(
		listed.map((b: any) => [b.id, b.bridge, b.for]),
		[[self.json.id, "messagent", "Telegram user 123 @luiswirth"]],
	);

	// The bridge lists the person's sessions, and mirrors a room onto one they pick.
	const choices = (await call(grant, "GET", "/api/bridges/self/sessions")).json;
	assert.ok(choices.some((s: any) => s.id === chat.id));
	assert.ok(!choices.some((s: any) => s.id === benOwn.id));
	const add = (session: string, as = grant) =>
		call(as, "POST", "/api/bridges/self/rooms", {
			session,
			about: 'the Telegram group "Team" (3 people)',
		});
	assert.equal((await add(benOwn.id)).status, 404);
	assert.equal((await add(chat.id, luisToken)).status, 404);
	const room = await add(chat.id);
	assert.equal(room.status, 201, room.text);
	assert.match(room.json.id, /^r_/);
	assert.equal(room.json.session.address, chat.address);
	assert.equal(
		(await call(grant, "GET", `/api/bridges/self/rooms/${room.json.id}`))
			.status,
		200,
	);

	const secretOf = (s: any) => s.address.split("/").pop();
	const join = (name: string, as: string, into = chat) =>
		call(null, "POST", "/agentwire/join", {
			session: secretOf(into),
			name,
			token: as,
			owned: true,
		});
	const read = (as: string, into = chat) =>
		call(null, "POST", "/agentwire/read", {
			session: secretOf(into),
			token: as,
			owned: true,
		});
	// A bridge is no participant: it reads the session apart, and joins only as its grant's person
	// or as anyone unverified under its messenger's name.
	assert.equal((await read(grant)).status, 200);
	assert.equal((await read(grant, elsewhere)).status, 403);
	const asLuis = await join("luis", grant);
	assert.equal(asLuis.status, 200, asLuis.text);
	assert.equal(asLuis.json.account, "luis");
	for (const name of ["luis/messagent", "luis/claude", "ben"])
		assert.equal((await join(name, grant)).status, 403, name);
	const stranger = await join("telegram/eve", grant);
	assert.equal(stranger.status, 200, stranger.text);
	assert.equal(stranger.json.account, null);
	assert.equal(stranger.json.about.project, "telegram");
	assert.match(stranger.json.grant, /^g1\./);
	assert.equal((await join("telegram/eve", grant, elsewhere)).status, 403);
	for (const name of [
		"telegram/Eve",
		"telegram/eve/x",
		"telegram",
		"discord/eve",
	])
		assert.equal((await join(name, grant)).status, 403, name);
	// The grant the relay keeps works as the credential does.
	const byGrant = await call(null, "POST", "/agentwire/join", {
		session: secretOf(chat),
		name: "luis",
		grant: asLuis.json.grant,
		owned: true,
	});
	assert.equal(byGrant.status, 200, byGrant.text);
	// No one else joins under the messenger's name, so that no account passes as a carried person.
	for (const as of [luisToken, null])
		assert.equal(
			(
				await call(null, "POST", "/agentwire/join", {
					session: secretOf(chat),
					name: "telegram/eve",
					token: as,
					owned: true,
				})
			).status,
			403,
		);
	// What the bridge says of its room is the session's info, which an agent learns as it joins.
	assert.equal(
		(
			await call(grant, "PATCH", `/api/bridges/self/rooms/${room.json.id}`, {
				about: 'the Telegram group "Team" (4 people)',
			})
		).status,
		204,
	);
	const info = (await call(ben, "GET", "/api/sessions")).json.find(
		(s: any) => s.id === chat.id,
	);
	assert.deepEqual(info.bridges, [
		{
			bridge: "messagent",
			by: "luis",
			about: 'the Telegram group "Team" (4 people)',
		},
	]);
	const agentJoins = await call(null, "POST", "/agentwire/join", {
		session: secretOf(chat),
		name: "ben/claude",
		token: benToken,
		owned: true,
	});
	assert.equal(agentJoins.status, 200, agentJoins.text);
	assert.deepEqual(agentJoins.json.about.bridges, info.bridges);

	// Ben, linked too, speaks as himself in Luis's room, and only while he is in its group.
	const bens = await grantOf(ben);
	assert.equal((await join("ben", bens)).status, 200);
	assert.equal((await read(bens)).status, 200);
	// Every member sees the session's rooms; Ben's grant reaches no room of Luis's.
	const rooms = await call(ben, "GET", `/api/sessions/${chat.id}/bridges`);
	assert.deepEqual(
		rooms.json.map((r: any) => [r.id, r.bridge, r.by]),
		[[room.json.id, "messagent", "luis"]],
	);
	assert.equal(
		(await call(bens, "GET", `/api/bridges/self/rooms/${room.json.id}`)).status,
		404,
	);
	const bensRoom = await add(chat.id, bens);
	assert.equal(bensRoom.status, 201);
	assert.equal(
		(await call(ben, "DELETE", `/api/groups/${group}/members/ben`)).status,
		204,
	);
	assert.equal((await join("ben", bens)).status, 403);
	assert.equal(
		(await call(bens, "GET", `/api/bridges/self/rooms/${bensRoom.json.id}`))
			.status,
		404,
	);

	// Linking again replaces the grant and keeps the rooms.
	const again = await grantOf(luis);
	assert.equal((await call(grant, "GET", "/api/bridges/self")).status, 401);
	assert.equal(
		(await call(again, "GET", `/api/bridges/self/rooms/${room.json.id}`))
			.status,
		200,
	);
	assert.equal((await call(luis, "GET", "/api/bridges")).json.length, 1);

	// Any member removes a room; the bridge removes its own; a session takes its rooms with it.
	assert.equal(
		(
			await call(
				luisToken,
				"DELETE",
				`/api/sessions/${chat.id}/bridges/${room.json.id}`,
			)
		).status,
		204,
	);
	assert.equal((await read(again)).status, 403);
	assert.equal((await join("telegram/eve", again)).status, 403);
	const second = (await add(chat.id, again)).json.id;
	assert.equal(
		(await call(again, "DELETE", `/api/bridges/self/rooms/${second}`)).status,
		204,
	);
	assert.equal((await add(chat.id, again)).status, 201);
	assert.equal(
		(await call(luis, "DELETE", `/api/sessions/${chat.id}`)).status,
		204,
	);
	assert.deepEqual(
		(await call(again, "GET", "/api/bridges/self")).json.rooms,
		[],
	);

	// Revoking the grant on the account page ends it and its rooms at once.
	const kept = await add(elsewhere.id, again);
	assert.equal(kept.status, 201);
	assert.equal((await join("luis", again, elsewhere)).status, 200);
	const [mine] = (await call(luis, "GET", "/api/bridges")).json;
	assert.deepEqual(
		mine.rooms.map((r: any) => r.id),
		[kept.json.id],
	);
	assert.equal(
		(await call(luis, "DELETE", `/api/bridges/${mine.id}`)).status,
		204,
	);
	assert.equal((await call(again, "GET", "/api/bridges/self")).status, 401);
	assert.deepEqual(
		(await call(luis, "GET", `/api/sessions/${elsewhere.id}/bridges`)).json,
		[],
	);
	// The bridge revokes its own grant, as when its person unlinks there.
	const last = await grantOf(luis);
	assert.equal((await call(last, "DELETE", "/api/bridges/self")).status, 204);
	assert.deepEqual((await call(luis, "GET", "/api/bridges")).json, []);

	// What only the person does stays theirs.
	const held = await grantOf(luis);
	const other = await askAsBridge();
	for (const [path, body] of [
		["/api/auth/device/approve", { userCode: other.user_code }],
		["/api/auth/device/deny", { userCode: other.user_code }],
		["/api/auth/update-user", { name: "x" }],
	] as const)
		assert.equal((await call(held, "POST", path, body)).status, 403, path);
	// No variant of a path gets past the checks that match it exactly.
	for (const path of [
		"/api/auth/device/code/",
		"/api/auth//device/code",
		"/api/auth/device/token/",
		"/api/auth/device/approve/",
	])
		assert.equal(
			(
				await call(null, "POST", path, {
					client_id: "messagent",
					scope: "bridge",
				})
			).status,
			404,
			path,
		);
});
