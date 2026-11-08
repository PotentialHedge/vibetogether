/** The account service, as its spec has it (luiswirth/vibetogether-accounts,
 * `api.md`), served on the site's own host under `/api/`. The page calls it
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
	link: string;
};

export type Setting = "ping" | "fyi";

export type Friend = {
	name: string;
	displayName: string;
	image: string;
	/** `asked`: the caller added them; `asking`: they added the caller. */
	state: "friends" | "asked" | "asking";
	agents: Setting;
};

export type Agent = {
	id: string;
	name: string;
	kind: "code" | "oauth";
	created: string;
};

/** A one-time code, as the service tells of it once it is claimed: which
 * agent asks. */
export type Device = { user_code: string; client_id: string; status?: string };

export class Unauthorized extends Error {}

export const demo = location.hash === "#demo";

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
	if (!response.ok)
		throw new Error((await response.text()) || response.statusText);
	const text = await response.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

const live = {
	me: () => call<Me>("GET", "api/me"),
	rooms: () => call<Room[]>("GET", "api/rooms"),
	createRoom: (name: string) => call<Room>("POST", "api/rooms", { name }),
	renameRoom: (id: string, name: string) =>
		call<Room>("PATCH", `api/rooms/${id}`, { name }),
	deleteRoom: (id: string) => call<void>("DELETE", `api/rooms/${id}`),
	addMember: (id: string, name: string) =>
		call<void>("PUT", `api/rooms/${id}/members/${name}`),
	removeMember: (id: string, name: string) =>
		call<void>("DELETE", `api/rooms/${id}/members/${name}`),
	friends: () => call<Friend[]>("GET", "api/friends"),
	addFriend: (name: string, agents?: Setting) =>
		call<void>("PUT", `api/friends/${name}`, agents && { agents }),
	removeFriend: (name: string) => call<void>("DELETE", `api/friends/${name}`),
	agents: () => call<Agent[]>("GET", "api/agents"),
	revoke: (id: string) => call<void>("DELETE", `api/agents/${id}`),
	/** Returns the address to go to, GitHub's. */
	signIn: async (callbackURL: string) =>
		(
			await call<{ url: string }>("POST", "api/auth/sign-in/social", {
				provider: "github",
				callbackURL,
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
	/** Answers an MCP client's request for access, by the query the
	 * consent page was given. */
	consent: (accept: boolean, consentCode: string | null) =>
		call<{ redirectURI?: string; redirect_uri?: string }>(
			"POST",
			"api/auth/oauth2/consent",
			{ accept, ...(consentCode ? { consent_code: consentCode } : {}) },
		),
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
		{ id: "r_1", name: "agents", owner: "luiswirth", members: [], link: "" },
		{
			id: "r_2",
			name: "booking-app",
			owner: "luiswirth",
			members: ["benarmstrong"],
			link: "",
		},
		{
			id: "r_3",
			name: "presio",
			owner: "benarmstrong",
			members: ["luiswirth", "tristangabl"],
			link: "",
		},
	];
	let friends: Friend[] = [
		{
			name: "benarmstrong",
			displayName: "Benedict Armstrong",
			image: "https://avatars.githubusercontent.com/benarmstrong",
			state: "friends",
			agents: "ping",
		},
		{
			name: "tristangabl",
			displayName: "Tristan Gabl",
			image: "",
			state: "friends",
			agents: "fyi",
		},
		{
			name: "someone",
			displayName: "Some One",
			image: "",
			state: "asking",
			agents: "fyi",
		},
	];
	let agents: Agent[] = [
		{
			id: "o_1",
			name: "Claude Code",
			kind: "oauth",
			created: "2026-11-09T00:12:00Z",
		},
		{
			id: "s_1",
			name: "claude",
			kind: "code",
			created: "2026-11-09T00:10:00Z",
		},
		{ id: "s_2", name: "codex", kind: "code", created: "2026-11-02T14:31:00Z" },
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
				link: "",
			};
			rooms = [...rooms, room];
			return room;
		},
		renameRoom: async (id, name) => {
			rooms = rooms.map((room) => (room.id === id ? { ...room, name } : room));
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
		addFriend: async (name, setting) => {
			const known = friends.find((friend) => friend.name === name);
			friends = known
				? friends.map((friend) =>
						friend.name === name
							? {
									...friend,
									state: friend.state === "asking" ? "friends" : friend.state,
									agents: setting ?? friend.agents,
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
							agents: "fyi",
						},
					];
		},
		removeFriend: async (name) => {
			friends = friends.filter((friend) => friend.name !== name);
		},
		agents: async () => agents,
		revoke: async (id) => {
			agents = agents.filter((agent) => agent.id !== id);
		},
		signIn: async () => `${page("account/")}#demo`,
		signOut: done,
		device: async (code) => ({ user_code: code, client_id: "claude" }),
		approve: done,
		deny: done,
		consent: async () => ({}),
	};
}

export const api: Api = demo ? mock() : live;
