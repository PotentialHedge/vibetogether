/** The backend's API, through the client library's WebAssembly build in
 * `src/client` (`just client`): the same operations every client makes. The
 * page is the person by its sign-in's cookie. With `#demo` in the address, it
 * answers from made-up data instead, so the page can be looked at without an
 * account.
 *
 * The page is the union of the person's servers: on a server with an owner,
 * the home server keeps the person's tokens for their other servers, and the
 * page reaches each with its own client. What the person sees is merged, each
 * thing of another server marked with its host, and every call on a thing
 * goes to its server; what is new goes to the home server. */

import init, {
	type Account,
	type Activity,
	type Agent,
	Client,
	type GroupAgent,
	type Login,
	type Overview,
	type Reachable,
	type Server,
	type ServerOtp,
	type Trashed,
	type Friend as WireFriend,
	type Group as WireGroup,
	type Project as WireProject,
	type Session as WireSession,
} from "@/client/vibetogether_client";
import { page } from "@/site";

/** Where a thing is: the host of the server it is on, where that is not the
 * home server, the one the page is served from. */
type Where = { server?: string };
export type Group = WireGroup & Where;
export type Project = WireProject & Where;
export type Session = WireSession & Where;
export type Friend = WireFriend & Where;

export type {
	Account,
	Activity,
	Agent,
	GroupAgent,
	Login,
	Reachable,
	Server,
	ServerOtp,
	Trashed,
};

export const demo = location.hash === "#demo";

let ready: Promise<Client> | undefined;

/** The one client of the site's own backend, made at the first call. */
export function client(): Promise<Client> {
	ready ??= init().then(() => new Client(page().replace(/\/$/, "")));
	return ready;
}

/** A server's host, with its port where it names one. */
const hostOf = (url: string) => new URL(url).host;

/** Another server the person is on, with the person's name there. */
export type Remote = {
	host: string;
	url: string;
	account: string;
	client: Client;
};

let remotes: Promise<Remote[]> | undefined;

/** The person's other servers, as the home server keeps them; none on a
 * server without an owner. */
export function others(): Promise<Remote[]> {
	remotes ??= client().then(async (home) => {
		try {
			return (await home.servers()).map((server) => ({
				host: hostOf(server.url),
				url: server.url,
				account: server.account,
				client: new Client(server.url, server.token),
			}));
		} catch {
			return [];
		}
	});
	return remotes;
}

/** The server of each thing seen, by its id, where it is not the home one. */
const whereOf = new Map<string, string>();

/** The client of the server `id` is on. */
export async function clientOf(id: string): Promise<Client> {
	const host = whereOf.get(id);
	const remote = host && (await others()).find((r) => r.host === host);
	return remote ? remote.client : client();
}

/** Whether a call was refused for want of a sign-in. */
export function signedOut(error: unknown): boolean {
	return (error as { status?: unknown } | null)?.status === 401;
}

/** What the account sees at once, its groups' projects and sessions each as
 * one list, across all its servers. */
export type Seen = {
	revision: string;
	me: Account;
	groups: Group[];
	projects: Project[];
	sessions: Session[];
	dms: Session[];
	friends: Friend[];
	reachable: Reachable[];
	/** The person's agents outside the trash, on the home server. */
	agents: Agent[];
	/** The other servers, each with the person's name there, and whether the
	 * page reaches it now. */
	servers: { host: string; account: string; reached: boolean }[];
};

function seen(overview: Overview, server?: string): Omit<Seen, "servers"> {
	const { account, groups, dms, friends, reachable, agents, revision } =
		overview;
	const at = <T extends { id: string }>(thing: T): T & Where => {
		if (server === undefined) return thing;
		whereOf.set(thing.id, server);
		return { ...thing, server };
	};
	const friendAt = (friend: WireFriend): Friend =>
		server === undefined ? friend : { ...friend, server };
	return {
		revision,
		me: account,
		groups: groups.map(at),
		projects: groups.flatMap((group) => group.projects.map(at)),
		sessions: groups.flatMap((group) => [
			...group.sessions.map(at),
			...group.projects.flatMap((project) => project.sessions.map(at)),
		]),
		dms: dms.map(at),
		friends: friends.map(friendAt),
		reachable,
		agents,
	};
}

/** Each server's overview as last seen, by its host, the home one's as "";
 * null where it was not reached. */
const known = new Map<string, Overview | null>();

/** Waits `ms`, or until `signal` aborts. */
const pause = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		});
	});

/** How long a server out of reach is left before it is asked again. */
const UNREACHED_PAUSE = 30_000;

/** Everything as last seen, merged. */
function merged(remote: Remote[]): Seen {
	const home = seen(known.get("") as Overview);
	const servers = remote.map(({ host, account }) => ({
		host,
		account,
		reached: Boolean(known.get(host)),
	}));
	const there = remote.flatMap(({ host }) => {
		const overview = known.get(host);
		return overview ? [seen(overview, host)] : [];
	});
	return {
		...home,
		revision: JSON.stringify([...known].map(([h, o]) => [h, o?.revision])),
		groups: [...home.groups, ...there.flatMap((s) => s.groups)],
		projects: [...home.projects, ...there.flatMap((s) => s.projects)],
		sessions: [...home.sessions, ...there.flatMap((s) => s.sessions)],
		dms: [...home.dms, ...there.flatMap((s) => s.dms)],
		friends: [...home.friends, ...there.flatMap((s) => s.friends)],
		reachable: [...home.reachable, ...there.flatMap((s) => s.reachable)],
		servers,
	};
}

/** Everything the account sees, on every server; with `revision`, once
 * anything differs from what was seen last, or after four minutes. The home
 * server's refusal is the page's; another server's makes it unreached, and it
 * is asked again only after a pause. */
async function seenEverywhere(
	revision?: string,
	signal?: AbortSignal,
): Promise<Seen> {
	const home = await client();
	const remote = await others();
	if (revision === undefined || !known.has("")) {
		const [overview, ...rest] = await Promise.all([
			home.overview({}, signal),
			...remote.map(({ client }) =>
				client.overview({}, signal).catch(() => null),
			),
		]);
		known.set("", overview);
		remote.forEach(({ host }, i) => {
			known.set(host, rest[i] ?? null);
		});
		return merged(remote);
	}
	const stop = new AbortController();
	signal?.addEventListener("abort", () => stop.abort());
	const servers: [string, Client, boolean][] = [
		["", home, true],
		...remote.map(({ host, client }): [string, Client, boolean] => [
			host,
			client,
			false,
		]),
	];
	try {
		const [host, overview] = await Promise.race(
			servers.map(async ([host, client, own]) => {
				const was = known.get(host);
				if (!was) {
					await pause(UNREACHED_PAUSE, stop.signal);
					if (stop.signal.aborted) return new Promise<never>(() => {});
					try {
						return [host, await client.overview({}, stop.signal)] as const;
					} catch {
						return new Promise<never>(() => {});
					}
				}
				try {
					const overview = await client.overview(
						{ revision: was.revision, wait: 240 },
						stop.signal,
					);
					return [host, overview] as const;
				} catch (error) {
					if (own || stop.signal.aborted) throw error;
					return [host, null] as const;
				}
			}),
		);
		known.set(host, overview);
		return merged(remote);
	} finally {
		stop.abort();
	}
}

const live = {
	me: async () => (await client()).me(),
	/** Everything the account sees; with `revision`, once that differs, or
	 * after four minutes. */
	seen: seenEverywhere,
	/** The account's agents outside the trash. */
	agents: async () => (await client()).agents(),
	createAgent: async (name: string) => (await client()).createAgent(name),
	renameAgent: async (id: string, name: string) =>
		(await clientOf(id)).renameAgent(id, name),
	deleteAgent: async (id: string) => (await clientOf(id)).deleteAgent(id),
	/** What is in the trash that the person restores, newest first. */
	trash: async () => (await client()).trash(),
	restore: async (id: string) => (await client()).restore(id),
	createGroup: async (name: string) => (await client()).createGroup(name),
	deleteGroup: async (id: string) => (await clientOf(id)).deleteGroup(id),
	addMember: async (group: string, name: string) =>
		(await clientOf(group)).addMember(group, name),
	removeMember: async (group: string, name: string) =>
		(await clientOf(group)).removeMember(group, name),
	createProject: async (group: string, name: string) =>
		(await clientOf(group)).createProject({ group, name }),
	changeProject: async (
		id: string,
		change: { name?: string; repos?: string[] },
	) => (await clientOf(id)).changeProject(id, change),
	deleteProject: async (id: string) => (await clientOf(id)).deleteProject(id),
	/** A session in a project, or directly in a group. */
	createSession: async (
		place: { project: string } | { group: string },
		name: string,
	) =>
		(
			await clientOf("project" in place ? place.project : place.group)
		).createSession({ ...place, name }),
	deleteSession: async (id: string) => (await clientOf(id)).deleteSession(id),
	activity: async () => (await client()).activity(),
	/** Deletes the account: only the person, signed in, may. */
	deleteAccount: async () => (await client()).deleteAccount(),
	/** An invite to be friends and join the session's group, landing in it. */
	inviteToSession: async (session: string) =>
		(await clientOf(session)).createInvite({ session }),
	addFriend: async (name: string) => (await client()).addFriend(name),
	removeFriend: async (name: string) => (await client()).removeFriend(name),
	logins: async () => (await client()).logins(),
	revokeLogin: async (id: string) => (await client()).revokeLogin(id),
	/** Whether the server has an owner, who is signed in at once. */
	owned: async () => (await (await client()).serverInfo()).identity === "owner",
	/** Where to go to sign in, coming back to the site's page `back`. */
	signIn: async (back: string) => {
		const { pathname, search } = new URL(back, location.href);
		return (await client()).signInUrl(pathname + search);
	},
	signOut: async () => (await client()).signOut(),
	showOtp: async (code: string) => (await client()).showOtp(code),
	approveOtp: async (code: string) => (await client()).approveOtp(code),
	denyOtp: async (code: string) => (await client()).denyOtp(code),
	/** The other servers the home server keeps tokens for, on a server with an
	 * owner. */
	servers: async () => (await client()).servers(),
	/** Adds a server: its OTP, for the person to approve on its website. */
	addServer: async (url: string) => (await client()).addServer(url),
	removeServer: async (id: string) => (await client()).removeServer(id),
	/** Forgets the other servers, so that the next call asks for them again. */
	reachAgain: () => {
		remotes = undefined;
		for (const host of known.keys()) if (host) known.delete(host);
	},
};

export type Api = typeof live;

/** Made-up data, for `#demo`. */
function mock(): Api {
	const me: Account = {
		id: "u_luiswirth",
		name: "luiswirth",
		displayName: "Luis Wirth",
		image: "https://avatars.githubusercontent.com/luiswirth",
	};
	const claude: GroupAgent = {
		id: "a_k3x9q2mf",
		name: "luiswirth/claude",
		presence: "awake",
	};
	const codex: GroupAgent = {
		id: "a_p8w1n5vb",
		name: "luiswirth/codex",
		presence: "offline",
	};
	let groups: Group[] = [
		{
			id: "g_0",
			name: "luiswirth",
			own: true,
			members: ["luiswirth"],
			agents: [claude, codex],
		},
		{
			id: "g_1",
			name: "Potential Hedge",
			own: false,
			members: ["luiswirth", "benarmstrong", "tristangabl"],
			agents: [
				{ id: "a_7tq2wz8c", name: "benarmstrong/claude", presence: "asleep" },
				{ id: "a_q9v4k1zs", name: "benarmstrong/review", presence: "offline" },
				claude,
				{ id: "a_m4p0d3xr", name: "tristangabl/codex", presence: "awake" },
			],
		},
	];
	const daysAgo = (days: number) =>
		new Date(Date.now() - days * 86400_000).toISOString();
	let trash: Trashed[] = [
		{
			id: "s_old_spike",
			kind: "session",
			name: "spike",
			group: { id: "g_1", name: "Potential Hedge" },
			project: { id: "p_2", name: "vibetogether" },
			trashed: daysAgo(1),
			by: "luiswirth/claude",
			purged: daysAgo(-29),
		},
		{
			id: "a_r7d2s5qe",
			kind: "agent",
			name: "luiswirth/scratch",
			trashed: daysAgo(3),
			by: "luiswirth/scratch",
			purged: daysAgo(-27),
		},
	];
	const named = (id: string) => {
		const { name } = groups.find((group) => group.id === id) as Group;
		return { id, name };
	};
	let projects: Project[] = [
		{ id: "p_1", name: "notes", group: named("g_0"), repos: [] },
		{
			id: "p_2",
			name: "vibetogether",
			group: named("g_1"),
			repos: ["https://github.com/PotentialHedge/vibetogether"],
		},
	];
	const inProject = (id: string) => {
		const project = projects.find((p) => p.id === id) as Project;
		return {
			project: { id: project.id, name: project.name, repos: project.repos },
			group: project.group,
			general: false,
			own: project.group.id === "g_0",
			pinged: false,
			friend: undefined,
			creator: me.name,
		};
	};
	const general = (group: string): Session => ({
		id: `s_general_${group}`,
		name: "general",
		project: undefined,
		group: named(group),
		general: true,
		own: group === "g_0",
		pinged: group === "g_1",
		friend: undefined,
		creator: undefined,
	});
	let sessions: Session[] = [
		general("g_0"),
		general("g_1"),
		{ id: "s_1", name: "notes", ...inProject("p_1") },
		{ id: "s_2", name: "agents", ...inProject("p_2") },
		{ id: "s_3", name: "demo", ...inProject("p_2") },
	];
	let agents: Agent[] = [
		{
			id: "a_k3x9q2mf",
			name: "luiswirth/claude",
			presence: "awake",
			status: "Fixing the receive loop in the account page.",
			listening: [{ id: "s_2", name: "agents" }],
		},
		{
			id: "a_p8w1n5vb",
			name: "luiswirth/codex",
			presence: "offline",
			seen: new Date(Date.now() - 3 * 3600_000).toISOString(),
			listening: [],
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
			image: undefined,
			state: "friends",
		},
		{
			name: "someone",
			displayName: "Some One",
			image: undefined,
			state: "asking",
		},
	];
	let logins: Login[] = [
		{
			id: "w_1",
			name: "a sign-in",
			kind: "browser",
			current: true,
			created: "2026-11-08T20:00:00Z",
		},
		{
			id: "t_2",
			name: "messagent",
			kind: "person",
			current: false,
			created: "2026-11-09T00:12:00Z",
		},
		{
			id: "t_1",
			name: "lwirth-macbook",
			kind: "agent",
			current: false,
			created: "2026-11-09T00:10:00Z",
		},
	];
	const reachable: Reachable[] = [
		{ id: "u_benarmstrong", name: "benarmstrong", presence: "awake" },
		{ id: "a_7tq2wz8c", name: "benarmstrong/claude", presence: "asleep" },
		{ id: "a_k3x9q2mf", name: "luiswirth/claude", presence: "awake" },
		{
			id: "a_m4p0d3xr",
			name: "tristangabl/codex",
			presence: "awake",
			dnd: true,
		},
	];
	const done = async () => {};
	const otp = async (code: string) => ({
		code,
		name: "lwirth-macbook",
		kind: "agent" as const,
		requested: new Date(Date.now() - 40_000).toISOString(),
		from: "Switzerland",
	});
	return {
		me: async () => me,
		// Nothing changes on its own here.
		seen: (revision?: string, signal?: AbortSignal) =>
			revision === undefined
				? Promise.resolve({
						revision: "demo",
						me,
						groups,
						projects,
						sessions,
						dms: friends
							.filter((friend) => friend.state === "friends")
							.map((friend) => ({
								id: `s_dm_${friend.name}`,
								name: "DM",
								project: undefined,
								group: undefined,
								general: false,
								own: false,
								pinged: false,
								friend: friend.name,
								creator: undefined,
							})),
						friends,
						reachable,
						agents,
						servers: [],
					})
				: new Promise<Seen>((_, reject) =>
						signal?.addEventListener("abort", () =>
							reject(new DOMException("Aborted", "AbortError")),
						),
					),
		agents: async () => agents,
		createAgent: async (name) => {
			const agent: Agent = {
				id: `a_${Date.now().toString(36).slice(-8)}`,
				name: `${me.name}/${name}`,
				presence: "offline",
				listening: [],
			};
			agents = [...agents, agent];
			return agent;
		},
		renameAgent: async (id, name) => {
			agents = agents.map((a) =>
				a.id === id ? { ...a, name: `${me.name}/${name}` } : a,
			);
			return agents.find((a) => a.id === id) as Agent;
		},
		deleteAgent: async (id) => {
			const agent = agents.find((a) => a.id === id) as Agent;
			agents = agents.filter((a) => a.id !== id);
			trash = [
				{
					id,
					kind: "agent",
					name: agent.name,
					trashed: daysAgo(0),
					by: me.name,
					purged: daysAgo(-30),
				},
				...trash,
			];
		},
		trash: async () => trash,
		restore: async (id) => {
			trash = trash.filter((item) => item.id !== id);
		},
		createGroup: async (name) => {
			const group = {
				id: `g_${Date.now()}`,
				name,
				own: false,
				members: [me.name],
				agents: [],
			};
			groups = [...groups, group];
			sessions = [...sessions, general(group.id)];
			return group;
		},
		deleteGroup: async (id) => {
			groups = groups.filter((group) => group.id !== id);
			projects = projects.filter((project) => project.group.id !== id);
			sessions = sessions.filter((session) => session.group?.id !== id);
		},
		addMember: async (id, name) => {
			const agent = agents.find((a) => a.name === name);
			groups = groups.map((group) =>
				group.id !== id
					? group
					: agent
						? {
								...group,
								agents: [
									...group.agents,
									{ id: agent.id, name, presence: agent.presence },
								],
							}
						: { ...group, members: [...group.members, name] },
			);
			return groups.find((group) => group.id === id) as Group;
		},
		removeMember: async (id, name) => {
			groups = groups
				.map((group) =>
					group.id === id
						? {
								...group,
								members: group.members.filter((m) => m !== name),
								agents: group.agents.filter(
									(a) => a.name !== name && !a.name.startsWith(`${name}/`),
								),
							}
						: group,
				)
				.filter((group) => group.id !== id || name !== me.name);
		},
		createProject: async (group, name) => {
			const project = {
				id: `p_${Date.now()}`,
				name,
				group: named(group),
				repos: [],
			};
			projects = [...projects, project];
			return project;
		},
		changeProject: async (id, change) => {
			const repos = change.repos?.map((repo) =>
				repo.startsWith("https://") ? repo : `https://github.com/${repo}`,
			);
			projects = projects.map((project) =>
				project.id === id
					? {
							...project,
							...(change.name && { name: change.name }),
							...(repos && { repos }),
						}
					: project,
			);
			return projects.find((project) => project.id === id) as Project;
		},
		deleteProject: async (id) => {
			projects = projects.filter((project) => project.id !== id);
			sessions = sessions.filter((session) => session.project?.id !== id);
		},
		createSession: async (place, name) => {
			const session = {
				id: `s_${Date.now()}`,
				name,
				...("project" in place
					? inProject(place.project)
					: {
							project: undefined,
							group: named(place.group),
							general: false,
							own: place.group === "g_0",
							pinged: false,
							friend: undefined,
							creator: me.name,
						}),
			};
			sessions = [...sessions, session];
			return session;
		},
		deleteSession: async (id) => {
			sessions = sessions.filter((session) => session.id !== id);
		},
		activity: async () => [
			{
				name: "lwirth-macbook",
				agent: "luiswirth/lead",
				login: "t_1",
				operation: "add_friend",
				arguments: { name: "tristangabl" },
				created: new Date(Date.now() - 3 * 3600_000).toISOString(),
			},
			{
				name: "lwirth-macbook",
				agent: "luiswirth/lead",
				login: "t_1",
				operation: "create_session",
				arguments: { project: "p_2", name: "demo" },
				created: new Date(Date.now() - 26 * 3600_000).toISOString(),
			},
		],
		deleteAccount: done,
		inviteToSession: async () => ({
			code: "demo2invite",
			link: `${location.origin}/i/demo2invite`,
			group: named("g_1"),
			session: undefined,
			created: new Date().toISOString(),
			expires: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
		}),
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
							image: undefined,
							state: "asked",
						},
					];
		},
		removeFriend: async (name) => {
			friends = friends.filter((friend) => friend.name !== name);
		},
		logins: async () => logins,
		revokeLogin: async (id) => {
			logins = logins.filter((login) => login.id !== id);
		},
		owned: async () => false,
		signIn: async () => `${page("account/")}#demo`,
		signOut: done,
		showOtp: otp,
		approveOtp: done,
		denyOtp: done,
		servers: async () => [],
		addServer: async (url) => {
			throw new Error(`No servers in the demo, not ${url}.`);
		},
		removeServer: done,
		reachAgain: () => {},
	};
}

export const api: Api = demo ? mock() : live;
