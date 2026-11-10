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

test("an account starts with its own group and no session, and a session is open to its group's members by default", async () => {
	const { cookie: erin } = await person("erin");
	assert.deepEqual((await call(erin, "GET", "/api/sessions")).json, []);
	assert.deepEqual((await call(erin, "GET", "/api/projects")).json, []);
	const [own, ...rest] = (await call(erin, "GET", "/api/groups")).json;
	assert.deepEqual(rest, []);
	assert.deepEqual(
		{ ...own, id: undefined },
		{ id: undefined, name: "erin", own: true, owner: "erin", members: [] },
	);
	const sessions = (await call(luis, "GET", "/api/sessions")).json;
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].name, "agents");
	assert.deepEqual(sessions[0].project, {
		id: luisProject,
		name: "vibetogether",
	});
	assert.equal(sessions[0].group.name, "luis");
	assert.equal(sessions[0].open, "members");
	assert.equal(sessions[0].app, null);
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

test("the person mints a machine's token on the account page, which only they can", async () => {
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

	assert.equal(
		(await call(token, "POST", "/api/tokens", { name: "more" })).status,
		403,
	);
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
		204,
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

test("friends are mutual, only friends become members of a group, and leaving it ends access", async () => {
	const created = await call(luis, "POST", "/api/groups", {
		name: "Potential Hedge",
	});
	assert.equal(created.status, 201, created.text);
	const group = created.json.id;
	assert.deepEqual(created.json.members, []);
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
	assert.deepEqual(added.json.members, ["ben"]);
	assert.equal(added.json.owner, "luis");

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
	// Only the group's owner adds members, deletes projects, and opens a session by its address.
	assert.equal(
		(await call(ben, "PUT", `/api/groups/${group}/members/luis`)).status,
		403,
	);
	assert.equal(
		(await call(ben, "DELETE", `/api/projects/${shared}`)).status,
		403,
	);
	assert.equal(
		(await call(ben, "PATCH", `/api/sessions/${owned.id}`, { open: "link" }))
			.status,
		403,
	);
	assert.equal(
		(await call(ben, "PATCH", `/api/sessions/${owned.id}`, { name: "hedging" }))
			.json.name,
		"hedging",
	);
	// The owner stays.
	assert.equal(
		(await call(ben, "DELETE", `/api/groups/${group}/members/luis`)).status,
		403,
	);
	assert.equal(
		(await call(luis, "DELETE", `/api/groups/${group}/members/luis`)).status,
		403,
	);

	// Only a person in the browser deletes a session: one they created, or one in a group they own.
	assert.equal(owned.creator, "ben");
	const luiss = await session(luis, "luis-made", shared);
	assert.equal(
		(await call(ben, "DELETE", `/api/sessions/${luiss.id}`)).status,
		403,
	);
	assert.equal(
		(await call(benToken, "DELETE", `/api/sessions/${owned.id}`)).status,
		403,
	);
	assert.equal(
		(await call(luisToken, "DELETE", `/api/sessions/${luiss.id}`)).status,
		403,
	);
	assert.equal(
		(await call(luisToken, "DELETE", `/api/projects/${shared}`)).status,
		403,
	);
	assert.equal(
		(await call(luis, "DELETE", `/api/sessions/${luiss.id}`)).status,
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

	// Deleting the group, only the owner's in the browser, deletes its projects and sessions.
	assert.equal(
		(await call(luisToken, "DELETE", `/api/groups/${group}`)).status,
		403,
	);
	assert.equal(
		(await call(luis, "DELETE", `/api/groups/${own.id}`)).status,
		403,
	);
	assert.equal(
		(await call(luis, "DELETE", `/api/groups/${group}`)).status,
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

test("a session open by its address lets anyone in, and only the person opens it", async () => {
	const created = await call(luis, "POST", "/api/sessions", {
		name: "open",
		project: luisProject,
	});
	const id = created.json.id;
	const session = created.json.address.split("/").pop();
	const join = (name: string, token: string | null) =>
		call(null, "POST", "/agentwire/join", {
			session,
			name,
			token,
			owned: true,
		});
	assert.equal((await join("stranger", null)).status, 403);

	const agent = await connect(luis, "opener");
	assert.equal(
		(await call(agent, "PATCH", `/api/sessions/${id}`, { open: "link" }))
			.status,
		403,
	);
	assert.equal(
		(
			await call(agent, "POST", "/api/sessions", {
				name: "x",
				project: luisProject,
				open: "link",
			})
		).status,
		403,
	);
	// The browser is the cookie alone: the sign-in's own token as a bearer is no browser.
	assert.equal(
		(await call(luisToken, "PATCH", `/api/sessions/${id}`, { open: "link" }))
			.status,
		403,
	);
	assert.equal(
		(await call(luis, "PATCH", `/api/sessions/${id}`, { open: "maybe" }))
			.status,
		400,
	);
	const opened = await call(luis, "PATCH", `/api/sessions/${id}`, {
		open: "link",
	});
	assert.equal(opened.json.open, "link");
	assert.equal(opened.json.name, "open");
	assert.equal((await join("stranger", null)).json.account, null);
	// A token still verifies the name, a non-member's too.
	assert.equal((await join("ben/claude", benToken)).json.account, "ben");
	assert.equal((await join("luis", benToken)).status, 403);

	assert.equal(
		(await call(agent, "PATCH", `/api/sessions/${id}`, { open: "members" }))
			.json.open,
		"members",
	);
	assert.equal((await join("stranger", null)).status, 403);
	await call(luis, "DELETE", `/api/sessions/${id}`);
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

test("only the person adds friends and members, never an agent's token", async () => {
	const token = await connect(ben, "helper");
	assert.equal((await call(token, "PUT", "/api/friends/luis")).status, 403);
	const group = (await call(ben, "POST", "/api/groups", { name: "helpers" }))
		.json.id;
	assert.equal(
		(await call(token, "PUT", `/api/groups/${group}/members/luis`)).status,
		403,
	);
	// Nor a bearer copy of the person's own sign-in.
	assert.equal(
		(await call(benToken, "PUT", `/api/groups/${group}/members/luis`)).status,
		403,
	);
	assert.equal((await call(benToken, "PUT", "/api/friends/luis")).status, 403);
	assert.equal((await call(ben, "DELETE", `/api/groups/${group}`)).status, 204);
});

test("unfriending takes each out of the other's groups", async () => {
	const { cookie: carol } = await person("carol");
	await call(luis, "PUT", "/api/friends/carol");
	await call(carol, "PUT", "/api/friends/luis");
	const group = (await call(luis, "POST", "/api/groups", { name: "carol" }))
		.json.id;
	assert.deepEqual(
		(await call(luis, "PUT", `/api/groups/${group}/members/carol`)).json
			.members,
		["carol"],
	);
	assert.equal((await call(carol, "DELETE", "/api/friends/luis")).status, 204);
	assert.deepEqual(
		(await call(luis, "GET", "/api/groups")).json.find(
			(g: any) => g.id === group,
		).members,
		[],
	);
	await call(luis, "DELETE", `/api/groups/${group}`);
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
	assert.equal((await call(null, "GET", `/agentwire/sessions/${address}`)).status, 200);
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

test("an app asks for OTPs and polls them apart from its address's limit, and only with its secret", async () => {
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
				scope: "person",
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
	// A request can't claim to be a checked app: the mark is the service's own.
	const statuses = [];
	for (let i = 0; i < 12; i++)
		statuses.push(
			(
				await app.request("/api/auth/device/code", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-forwarded-for": "198.51.100.11",
						"x-vibetogether-app": "a-guess",
					},
					body: JSON.stringify({ client_id: "flood" }),
				})
			).status,
		);
	assert.ok(statuses.includes(429), statuses.join(" "));
});

test("an app acts as its person only with its secret, the person's approval, and until it is unlinked", async () => {
	from = "192.0.2.44";
	const ask = (body: Record<string, string>) =>
		call(null, "POST", "/api/auth/device/code", {
			client_id: "messagent",
			scope: "person",
			...body,
		});
	// The client_id alone is public, so it is no proof of the app.
	assert.equal((await ask({})).status, 401);
	assert.equal((await ask({ client_secret: "a-guess" })).status, 401);
	assert.equal(
		(
			await call(null, "POST", "/api/auth/device/code", {
				client_id: "laptop",
				client_secret: "a-secret-of-the-bot",
				scope: "person",
			})
		).status,
		401,
	);

	const code = await ask({
		client_secret: "a-secret-of-the-bot",
		for: "Telegram 123 @luiswirth",
	});
	assert.equal(code.status, 200, code.text);
	const page = await call(
		luis,
		"GET",
		`/api/auth/device?user_code=${code.json.user_code}`,
	);
	assert.equal(page.status, 200, page.text);
	assert.equal(page.json.client_id, "messagent");
	assert.equal(page.json.person, true);
	assert.equal(page.json.for, "Telegram 123 @luiswirth");
	assert.equal(
		(
			await call(luis, "POST", "/api/auth/device/approve", {
				userCode: code.json.user_code,
			})
		).status,
		200,
	);
	const redeem = (secret?: string) =>
		call(null, "POST", "/api/auth/device/token", {
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: code.json.device_code,
			client_id: "messagent",
			...(secret && { client_secret: secret }),
		});
	assert.equal((await redeem()).status, 401);
	const redeemed = await redeem("a-secret-of-the-bot");
	assert.equal(redeemed.status, 200, redeemed.text);
	const token = redeemed.json.access_token;

	// An app's grant is no token: tokens only connect agents.
	assert.equal(
		(await call(luis, "GET", "/api/tokens")).json.some(
			(t: any) => t.name === "messagent",
		),
		false,
	);
	const [listed] = (await call(luis, "GET", "/api/apps")).json;
	assert.equal(listed.name, "messagent");
	assert.equal(listed.for, "Telegram 123 @luiswirth");
	assert.equal(listed.id.slice(0, 2), "a_");
	assert.equal(
		(await call(luis, "DELETE", `/api/tokens/t_${listed.id.slice(2)}`)).status,
		404,
	);
	// The app owns the sessions it creates, and manages them alone.
	const created = await call(token, "POST", "/api/sessions", {
		name: "Telegram",
	});
	assert.equal(created.status, 201, created.text);
	assert.deepEqual(created.json.app, { id: listed.id, name: "messagent" });
	// It goes into the app's project, of the person's own group.
	assert.equal(created.json.project.name, "messagent");
	assert.equal(created.json.group.name, "luis");
	const appProject = created.json.project.id;
	assert.equal(
		(await call(luis, "GET", "/api/projects")).json.find(
			(p: any) => p.id === appProject,
		).app,
		"messagent",
	);
	// The project is the app's: no session of anyone else's goes in, and it stays.
	assert.equal(
		(
			await call(luis, "POST", "/api/sessions", {
				name: "mine",
				project: appProject,
			})
		).status,
		403,
	);
	assert.equal(
		(await call(luis, "DELETE", `/api/projects/${appProject}`)).status,
		403,
	);
	// An app reaches no group or project of its person's.
	assert.equal(
		(
			await call(token, "POST", "/api/sessions", {
				name: "elsewhere",
				project: luisProject,
			})
		).status,
		403,
	);
	for (const [method, path] of [
		["POST", "/api/projects"],
		["POST", "/api/groups"],
	] as const)
		assert.equal(
			(await call(token, method, path, { name: "x" })).status,
			403,
			path,
		);
	const kept = await call(token, "POST", "/api/sessions", { name: "kept" });
	for (const someone of [luis, luisToken])
		assert.equal(
			(await call(someone, "DELETE", `/api/sessions/${created.json.id}`))
				.status,
			403,
		);
	assert.equal(
		(
			await call(luis, "PATCH", `/api/sessions/${created.json.id}`, {
				name: "mine",
			})
		).status,
		403,
	);
	assert.equal(
		(await call(token, "DELETE", `/api/sessions/${created.json.id}`)).status,
		204,
	);
	// An app manages only its own sessions.
	const [own] = (await call(luis, "GET", "/api/sessions")).json.filter(
		(s: any) => s.app === null && s.group.name === "luis",
	);
	assert.equal(
		(await call(token, "DELETE", `/api/sessions/${own.id}`)).status,
		403,
	);

	const [owned] = (await call(token, "GET", "/api/sessions")).json;
	const session = owned.address.split("/").pop();
	const join = (name: string, as: string) =>
		call(null, "POST", "/agentwire/join", {
			session,
			name,
			token: as,
			owned: true,
		});
	assert.equal((await join("luis", token)).json.account, "luis");
	assert.equal((await join("luis/messagent", token)).json.account, "luis");
	assert.equal((await join("luis/claude", token)).status, 403);
	assert.equal((await join("ben", token)).status, 403);
	// An agent's token still never joins as the person.
	const agent = await connect(luis, "laptop");
	assert.equal((await join("luis", agent)).status, 403);
	// It acts as the person in sessions only: what only the person does stays theirs.
	assert.equal((await call(token, "PUT", "/api/friends/ben")).status, 403);
	const other = await ask({ client_secret: "a-secret-of-the-bot" });
	for (const [path, body] of [
		["/api/auth/device/approve", { userCode: other.json.user_code }],
		["/api/auth/device/deny", { userCode: other.json.user_code }],
		["/api/auth/update-user", { name: "x" }],
	] as const)
		assert.equal((await call(token, "POST", path, body)).status, 403, path);
	// No variant of a path gets past the checks that match it exactly.
	for (const path of [
		"/api/auth/device/code/",
		"/api/auth//device/code",
		"/api/auth/device/token/",
	])
		assert.equal(
			(
				await call(null, "POST", path, {
					client_id: "messagent",
					scope: "person",
				})
			).status,
			404,
			path,
		);

	// Unlinking from the app's side.
	assert.equal((await call(token, "DELETE", "/api/tokens/self")).status, 404);
	// Only the person revokes an app, never an agent's token.
	assert.equal(
		(await call(agent, "DELETE", `/api/apps/${listed.id}`)).status,
		403,
	);
	assert.equal((await call(token, "DELETE", "/api/apps/self")).status, 204);
	// Revoking the app ends its sessions.
	assert.equal(
		(await call(luis, "GET", "/api/sessions")).json.some(
			(s: any) => s.id === kept.json.id,
		),
		false,
	);
	assert.equal((await join("luis", token)).status, 403);
	assert.equal((await call(token, "GET", "/api/me")).status, 401);
	assert.equal((await call(agent, "GET", "/api/me")).status, 200);
});
