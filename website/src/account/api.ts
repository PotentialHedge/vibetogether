/** The account service, as its spec has it (`accounts/api.md`), served on
 * the site's own host under `/api/`. The page calls it
 * with its session cookie, through the same requests an agent makes with its
 * token. With `#demo` in the address, it answers from made-up data instead,
 * so the page can be looked at without an account. */

import { page } from "@/site";

export type Me = { name: string; displayName: string; image: string };

export type Session = {
	id: string;
	name: string;
	owner: string;
	members: string[];
	/** Who may join: its members only, or anyone with its address. */
	open: Open;
	/** Its URL on the relay, hard to guess: it identifies the session, and is its secret. */
	address: string;
	/** The app that owns it for the person, such as messagent for a Telegram
	 * chat, which manages it; none for the person's own. */
	app?: { id: string; name: string } | null;
};

export type Open = "members" | "link";

export type Friend = {
	name: string;
	displayName: string;
	image: string;
	/** `asked`: the caller added them; `asking`: they added the caller. */
	state: "friends" | "asked" | "asking";
};

/** What acts for the account, held by an agent or its harness. */
export type Token = {
	id: string;
	/** The machine's name, for a machine's token, or its MCP client's. */
	name: string;
	/** A machine's, from an OTP or minted here, which every agent on it
	 * shares, or an MCP client's, from its signing in. */
	kind: "machine" | "mcp";
	created: string;
};

/** An app that acts as the person, such as messagent for a Telegram chat,
 * by a grant the person approved: no token, since tokens only connect agents. */
export type App = {
	id: string;
	name: string;
	/** What the app said it is for, in its own words. */
	for: string | null;
	created: string;
};

/** A token just minted: the only time the token itself is shown. */
export type Minted = Token & { token: string };

/** An OTP, as the service tells of it once it is claimed: which
 * agent asks. */
export type Device = {
	user_code: string;
	/** The name the requester gave itself. */
	client_id: string;
	status?: string;
	/** When the code was asked for, as an ISO time. */
	requested?: string;
	/** Where it was asked from: an IP address or a country. */
	from?: string;
	/** Whether an app asks to act as the person, rather than a machine for its agents. */
	person?: boolean;
	/** What the app says it is for, in its own words. */
	for?: string | null;
};

export class Unauthorized extends Error {}

export const demo = location.hash === "#demo";

/** What went wrong, as the answer says it: Better Auth's JSON carries it as
 * `message`, the service's own answers as plain text. */
async function problemOf(response: Response): Promise<string> {
	const text = await response.text();
	try {
		const message = (JSON.parse(text) as { message?: unknown }).message;
		if (typeof message === "string") return message;
	} catch {}
	return text || response.statusText;
}

async function call<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await fetch(page(path), {
		method,
		credentials: "same-origin",
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? null : JSON.stringify(body),
	});
	if (response.status === 401) throw new Unauthorized();
	if (!response.ok) throw new Error(await problemOf(response));
	const text = await response.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

const live = {
	me: () => call<Me>("GET", "api/me"),
	sessions: () => call<Session[]>("GET", "api/sessions"),
	createSession: (name: string) =>
		call<Session>("POST", "api/sessions", { name }),
	changeSession: (id: string, change: { name?: string; open?: Open }) =>
		call<Session>("PATCH", `api/sessions/${encodeURIComponent(id)}`, change),
	deleteSession: (id: string) =>
		call<void>("DELETE", `api/sessions/${encodeURIComponent(id)}`),
	addMember: (id: string, name: string) =>
		call<void>(
			"PUT",
			`api/sessions/${encodeURIComponent(id)}/members/${encodeURIComponent(name)}`,
		),
	removeMember: (id: string, name: string) =>
		call<void>(
			"DELETE",
			`api/sessions/${encodeURIComponent(id)}/members/${encodeURIComponent(name)}`,
		),
	friends: () => call<Friend[]>("GET", "api/friends"),
	addFriend: (name: string) =>
		call<void>("PUT", `api/friends/${encodeURIComponent(name)}`),
	removeFriend: (name: string) =>
		call<void>("DELETE", `api/friends/${encodeURIComponent(name)}`),
	tokens: () => call<Token[]>("GET", "api/tokens"),
	mint: (name: string) => call<Minted>("POST", "api/tokens", { name }),
	revoke: (id: string) =>
		call<void>("DELETE", `api/tokens/${encodeURIComponent(id)}`),
	apps: () => call<App[]>("GET", "api/apps"),
	revokeApp: (id: string) =>
		call<void>("DELETE", `api/apps/${encodeURIComponent(id)}`),
	/** Returns the address to go to, GitHub's. `oauthQuery` is the signed
	 * query an MCP client's authorization sent the person here with, so that
	 * it goes on after GitHub. */
	signIn: async (callbackURL: string, oauthQuery?: string) =>
		(
			await call<{ url: string }>("POST", "api/auth/sign-in/social", {
				provider: "github",
				callbackURL,
				...(oauthQuery ? { oauth_query: oauthQuery } : {}),
			})
		).url,
	signOut: () => call<void>("POST", "api/auth/sign-out", {}),
	device: (code: string) =>
		call<Device>(
			"GET",
			`api/auth/device?user_code=${encodeURIComponent(code)}`,
		),
	approve: (code: string) =>
		call<void>("POST", "api/auth/device/approve", { userCode: code }),
	deny: (code: string) =>
		call<void>("POST", "api/auth/device/deny", { userCode: code }),
	/** Answers an MCP client's request for access, by the signed query the
	 * consent page was given, and returns the address to go to. */
	consent: async (accept: boolean, oauthQuery: string) =>
		(
			await call<{ url: string }>("POST", "api/auth/oauth2/consent", {
				accept,
				oauth_query: oauthQuery,
			})
		).url,
	/** The name an MCP client gives itself. */
	clientName: async (clientId: string) =>
		(
			await call<{ client_name?: string }>(
				"GET",
				`api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
			)
		).client_name ?? clientId,
};

export type Api = typeof live;

/** Made-up data, for `#demo`. */
function mock(): Api {
	const me: Me = {
		name: "luiswirth",
		displayName: "Luis Wirth",
		image: "https://avatars.githubusercontent.com/luiswirth",
	};
	let sessions: Session[] = [
		{
			id: "s_0",
			name: "Telegram",
			owner: "luiswirth",
			members: [],
			open: "members",
			address: "",
			app: { id: "a_1", name: "messagent" },
		},
		{
			id: "s_1",
			name: "notes",
			owner: "luiswirth",
			members: [],
			open: "members",
			address: "",
		},
		{
			id: "s_2",
			name: "booking-app",
			owner: "luiswirth",
			members: ["benarmstrong"],
			open: "link",
			address: "",
		},
		{
			id: "s_3",
			name: "presio",
			owner: "benarmstrong",
			members: ["luiswirth", "tristangabl"],
			open: "members",
			address: "",
		},
	];
	let friends: Friend[] = [
		{
			name: "benarmstrong",
			displayName: "Benedict Armstrong",
			image: "https://avatars.githubusercontent.com/benarmstrong",
			state: "friends",
		},
		{
			name: "tristangabl",
			displayName: "Tristan Gabl",
			image: "",
			state: "friends",
		},
		{
			name: "someone",
			displayName: "Some One",
			image: "",
			state: "asking",
		},
	];
	let apps: App[] = [
		{
			id: "a_1",
			name: "messagent",
			for: "Telegram id 123456789, @luiswirth, named Luis",
			created: "2026-11-09T21:40:00Z",
		},
	];
	let tokens: Token[] = [
		{
			id: "o_1",
			name: "Claude Code",
			kind: "mcp",
			created: "2026-11-09T00:12:00Z",
		},
		{
			id: "t_1",
			name: "lwirth-macbook",
			kind: "machine",
			created: "2026-11-09T00:10:00Z",
		},
		{
			id: "t_2",
			name: "lwirth-server",
			kind: "machine",
			created: "2026-11-02T14:31:00Z",
		},
	];
	const done = async () => {};
	return {
		me: async () => me,
		sessions: async () => sessions,
		createSession: async (name) => {
			const session = {
				id: `r_${Date.now()}`,
				name,
				owner: me.name,
				members: [],
				open: "members" as Open,
				address: "",
			};
			sessions = [...sessions, session];
			return session;
		},
		changeSession: async (id, change) => {
			sessions = sessions.map((session) =>
				session.id === id ? { ...session, ...change } : session,
			);
			return sessions.find((session) => session.id === id) as Session;
		},
		deleteSession: async (id) => {
			sessions = sessions.filter((session) => session.id !== id);
		},
		addMember: async (id, name) => {
			sessions = sessions.map((session) =>
				session.id === id
					? { ...session, members: [...session.members, name] }
					: session,
			);
		},
		removeMember: async (id, name) => {
			sessions = sessions.map((session) =>
				session.id === id
					? { ...session, members: session.members.filter((m) => m !== name) }
					: session,
			);
		},
		friends: async () => friends,
		addFriend: async (name) => {
			const known = friends.find((friend) => friend.name === name);
			friends = known
				? friends.map((friend) =>
						friend.name === name
							? {
									...friend,
									state: friend.state === "asking" ? "friends" : friend.state,
								}
							: friend,
					)
				: [
						...friends,
						{
							name,
							displayName: name,
							image: "",
							state: "asked",
						},
					];
		},
		removeFriend: async (name) => {
			friends = friends.filter((friend) => friend.name !== name);
		},
		tokens: async () => tokens,
		mint: async (name) => {
			const minted = {
				id: `t_${tokens.length + 1}`,
				name,
				kind: "machine" as const,
				created: new Date().toISOString(),
				token: "made-up-token-for-the-demo",
			};
			tokens = [...tokens, minted];
			return minted;
		},
		revoke: async (id) => {
			tokens = tokens.filter((token) => token.id !== id);
		},
		apps: async () => apps,
		revokeApp: async (id) => {
			apps = apps.filter((app) => app.id !== id);
		},
		signIn: async () => `${page("account/")}#demo`,
		signOut: done,
		device: async (code) => ({
			user_code: code,
			client_id: "lwirth-macbook",
			requested: new Date(Date.now() - 40_000).toISOString(),
			from: "Switzerland",
		}),
		approve: done,
		deny: done,
		consent: async () => `${page("account/")}#demo`,
		clientName: async () => "Claude Code",
	};
}

export const api: Api = demo ? mock() : live;
