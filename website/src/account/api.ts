/** The backend's API, through the client library's WebAssembly build in
 * `src/client` (`just client`): the same operations every client makes. The
 * page is the person by its sign-in's cookie. With `#demo` in the address, it
 * answers from made-up data instead, so the page can be looked at without an
 * account. */

import init, {
	type Account,
	type Activity,
	type Agent,
	Client,
	type Friend,
	type Group,
	type Login,
	type Overview,
	type Project,
	type Reachable,
	type Session,
} from "@/client/vibetogether_client";
import { page } from "@/site";

export type {
	Account,
	Activity,
	Agent,
	Friend,
	Group,
	Login,
	Project,
	Reachable,
	Session,
};

export const demo = location.hash === "#demo";

let ready: Promise<Client> | undefined;

/** The one client of the site's own backend, made at the first call. */
export function client(): Promise<Client> {
	ready ??= init().then(() => new Client(page().replace(/\/$/, "")));
	return ready;
}

/** Whether a call was refused for want of a sign-in. */
export function signedOut(error: unknown): boolean {
	return (error as { status?: unknown } | null)?.status === 401;
}

/** What the account sees at once, its groups' projects and sessions each as
 * one list. */
export type Seen = {
	version: string;
	me: Account;
	groups: Group[];
	projects: Project[];
	sessions: Session[];
	dms: Session[];
	friends: Friend[];
	reachable: Reachable[];
};

function seen(overview: Overview): Seen {
	const { account, groups, dms, friends, reachable, version } = overview;
	return {
		version,
		me: account,
		groups,
		projects: groups.flatMap((group) => group.projects),
		sessions: groups.flatMap((group) => [
			...group.sessions,
			...group.projects.flatMap((project) => project.sessions),
		]),
		dms,
		friends,
		reachable,
	};
}

const live = {
	me: async () => (await client()).me(),
	/** Everything the account sees; with `version`, once that differs, or
	 * after four minutes. */
	seen: async (version?: string, signal?: AbortSignal) =>
		seen(
			await (await client()).overview(
				version === undefined ? {} : { version, wait: 240 },
				signal,
			),
		),
	/** The account's agents, the archived included. */
	agents: async () => (await client()).agents(),
	createAgent: async (name: string) => (await client()).createAgent(name),
	renameAgent: async (id: string, name: string) =>
		(await client()).renameAgent(id, name),
	archiveAgent: async (id: string) => (await client()).archiveAgent(id),
	createGroup: async (name: string) => (await client()).createGroup(name),
	deleteGroup: async (id: string) => (await client()).deleteGroup(id),
	addMember: async (group: string, name: string) =>
		(await client()).addMember(group, name),
	removeMember: async (group: string, name: string) =>
		(await client()).removeMember(group, name),
	createProject: async (group: string, name: string) =>
		(await client()).createProject({ group, name }),
	changeProject: async (
		id: string,
		change: { name?: string; repos?: string[] },
	) => (await client()).changeProject(id, change),
	deleteProject: async (id: string) => (await client()).deleteProject(id),
	/** A session in a project, or directly in a group. */
	createSession: async (
		place: { project: string } | { group: string },
		name: string,
	) => (await client()).createSession({ ...place, name }),
	deleteSession: async (id: string) => (await client()).deleteSession(id),
	activity: async () => (await client()).activity(),
	/** Deletes the account: only the person, signed in, may. */
	deleteAccount: async () => (await client()).deleteAccount(),
	/** An invite to be friends and join the session's group, landing in it. */
	inviteToSession: async (session: string) =>
		(await client()).createInvite({ session }),
	addFriend: async (name: string) => (await client()).addFriend(name),
	removeFriend: async (name: string) => (await client()).removeFriend(name),
	logins: async () => (await client()).logins(),
	revokeLogin: async (id: string) => (await client()).revokeLogin(id),
	/** Where to go to sign in with GitHub, coming back to the site's page
	 * `back`. */
	signIn: async (back: string) => {
		const { pathname, search } = new URL(back, location.href);
		return (await client()).signInUrl(pathname + search);
	},
	signOut: async () => (await client()).signOut(),
	showOtp: async (code: string) => (await client()).showOtp(code),
	approveOtp: async (code: string) => (await client()).approveOtp(code),
	denyOtp: async (code: string) => (await client()).denyOtp(code),
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
	let groups: Group[] = [
		{
			id: "g_0",
			name: "luiswirth",
			own: true,
			members: ["luiswirth"],
		},
		{
			id: "g_1",
			name: "Potential Hedge",
			own: false,
			members: ["luiswirth", "benarmstrong", "tristangabl"],
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
		{ id: "a_m4p0d3xr", name: "tristangabl/codex", presence: "awake" },
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
		seen: (version?: string, signal?: AbortSignal) =>
			version === undefined
				? Promise.resolve({
						version: "demo",
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
								pinged: false,
								friend: friend.name,
								creator: undefined,
							})),
						friends,
						reachable,
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
		archiveAgent: async (id) => {
			agents = agents.map((a) =>
				a.id === id ? { ...a, presence: "archived" } : a,
			);
		},
		createGroup: async (name) => {
			const group = {
				id: `g_${Date.now()}`,
				name,
				own: false,
				members: [me.name],
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
			groups = groups.map((group) =>
				group.id === id
					? { ...group, members: [...group.members, name] }
					: group,
			);
			return groups.find((group) => group.id === id) as Group;
		},
		removeMember: async (id, name) => {
			groups = groups
				.map((group) =>
					group.id === id
						? { ...group, members: group.members.filter((m) => m !== name) }
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
		signIn: async () => `${page("account/")}#demo`,
		signOut: done,
		showOtp: otp,
		approveOtp: done,
		denyOtp: done,
	};
}

export const api: Api = demo ? mock() : live;
