/** The account service, as its spec has it (`accounts/api.md`), served on
 * the site's own host under `/api/`. The page calls it
 * with its session cookie, through the same requests an agent makes with its
 * token. With `#demo` in the address, it answers from made-up data instead,
 * so the page can be looked at without an account. */

import { page } from "@/site";

export type Me = { name: string; displayName: string; image: string };

export type Room = {
	id: string;
	name: string;
	owner: string;
	members: string[];
	/** Who may join: its members only, or anyone with its address. */
	open: Open;
	/** Its URL on the relay, hard to guess: it identifies the room, and is its secret. */
	address: string;
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
	/** The machine's name, for a token from an OTP, or its MCP client's. */
	name: string;
	/** How it was created: with an OTP, bound to a machine, or by an MCP
	 * client signing in. */
	via: "otp" | "mcp";
	created: string;
};

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
	rooms: () => call<Room[]>("GET", "api/rooms"),
	createRoom: (name: string) => call<Room>("POST", "api/rooms", { name }),
	changeRoom: (id: string, change: { name?: string; open?: Open }) =>
		call<Room>("PATCH", `api/rooms/${encodeURIComponent(id)}`, change),
	deleteRoom: (id: string) =>
		call<void>("DELETE", `api/rooms/${encodeURIComponent(id)}`),
	addMember: (id: string, name: string) =>
		call<void>(
			"PUT",
			`api/rooms/${encodeURIComponent(id)}/members/${encodeURIComponent(name)}`,
		),
	removeMember: (id: string, name: string) =>
		call<void>(
			"DELETE",
			`api/rooms/${encodeURIComponent(id)}/members/${encodeURIComponent(name)}`,
		),
	friends: () => call<Friend[]>("GET", "api/friends"),
	addFriend: (name: string) =>
		call<void>("PUT", `api/friends/${encodeURIComponent(name)}`),
	removeFriend: (name: string) =>
		call<void>("DELETE", `api/friends/${encodeURIComponent(name)}`),
	tokens: () => call<Token[]>("GET", "api/tokens"),
	revoke: (id: string) =>
		call<void>("DELETE", `api/tokens/${encodeURIComponent(id)}`),
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
	let rooms: Room[] = [
		{
			id: "r_1",
			name: "notes",
			owner: "luiswirth",
			members: [],
			open: "members",
			address: "",
		},
		{
			id: "r_2",
			name: "booking-app",
			owner: "luiswirth",
			members: ["benarmstrong"],
			open: "link",
			address: "",
		},
		{
			id: "r_3",
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
	let tokens: Token[] = [
		{
			id: "o_1",
			name: "Claude Code",
			via: "mcp",
			created: "2026-11-09T00:12:00Z",
		},
		{
			id: "s_1",
			name: "lwirth-macbook",
			via: "otp",
			created: "2026-11-09T00:10:00Z",
		},
		{
			id: "s_2",
			name: "lwirth-server",
			via: "otp",
			created: "2026-11-02T14:31:00Z",
		},
	];
	const done = async () => {};
	return {
		me: async () => me,
		rooms: async () => rooms,
		createRoom: async (name) => {
			const room = {
				id: `r_${Date.now()}`,
				name,
				owner: me.name,
				members: [],
				open: "members" as Open,
				address: "",
			};
			rooms = [...rooms, room];
			return room;
		},
		changeRoom: async (id, change) => {
			rooms = rooms.map((room) =>
				room.id === id ? { ...room, ...change } : room,
			);
			return rooms.find((room) => room.id === id) as Room;
		},
		deleteRoom: async (id) => {
			rooms = rooms.filter((room) => room.id !== id);
		},
		addMember: async (id, name) => {
			rooms = rooms.map((room) =>
				room.id === id ? { ...room, members: [...room.members, name] } : room,
			);
		},
		removeMember: async (id, name) => {
			rooms = rooms.map((room) =>
				room.id === id
					? { ...room, members: room.members.filter((m) => m !== name) }
					: room,
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
		revoke: async (id) => {
			tokens = tokens.filter((token) => token.id !== id);
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
