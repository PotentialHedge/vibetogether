/** The backend's API, as its reference has it (`/api/reference.md`), served on
 * the site's own host under `/api/`. The page calls it
 * with its session cookie, through the same requests an agent makes with its
 * token. With `#demo` in the address, it answers from made-up data instead,
 * so the page can be looked at without an account. */

import { page } from "@/site";

export type Me = { name: string; displayName: string; image: string };

/** People, such as Potential Hedge; everyone also has a group of their own. */
export type Group = {
	id: string;
	name: string;
	/** Whether it is the person's own, which holds them alone. */
	own: boolean;
	/** Everyone in it: its members are equal. */
	members: string[];
};

/** A reference to a group or a project, as a session or a project names it. */
export type Named = { id: string; name: string };

/** A group's named set of sessions. */
export type Project = {
	id: string;
	name: string;
	group: Named;
	/** The GitHub repositories where its context lives, as their URLs. */
	repos: string[];
};

/** A project's session, a group's own, or a DM. */
export type Session = {
	id: string;
	name: string;
	/** Its project, with the repositories it points at; null for a DM and a group's own. */
	project: (Named & { repos: string[] }) | null;
	/** Its group; null for a DM. */
	group: Named | null;
	/** Whether it is its group's general, which every group has. */
	general: boolean;
	/** Whether a message in it pinged the person, which they haven't seen in it yet. */
	pinged: boolean;
	/** For a DM, the other person in it. */
	friend: string | null;
	/** Who created it. */
	creator: string | null;
};

/** Two friends' DM: a session for the two of them and their agents alone. */
export type Dm = Session & { friend: string };

/** A change an agent made in the account, through its token. */
export type Activity = {
	/** The login's name, such as the machine's. */
	agent: string;
	/** The login's id. */
	login: string;
	/** The operation's id, such as `add_friend`. */
	operation: string;
	arguments: Record<string, unknown>;
	created: string;
};

export type Friend = {
	name: string;
	displayName: string;
	image: string;
	/** `asked`: the caller added them; `asking`: they added the caller. */
	state: "friends" | "asked" | "asking";
};

/** One of the account's agents, as it shows while it receives: an agent
 * that uses Vibe Together always does. */
export type Agent = {
	/** Its full name, as `<account>/<agent>`. */
	name: string;
	/** Whether a receive of its waits, or ended moments ago. */
	online: boolean;
	/** When it was last seen, where it is offline. */
	seen?: string;
	/** The sessions it receives in. */
	receiving: Named[];
};

/** The account's own agents, and the full names of every online agent it
 * sees: its own, its group members' and its friends'. */
export type Agents = { own: Agent[]; online: string[] };

/** One way in to the account: a sign-in in a browser, a machine's token,
 * which every agent on it shares, or an MCP client's. */
export type Login = {
	id: string;
	/** The machine's name, the MCP client's, or `a sign-in`. */
	name: string;
	kind: "browser" | "machine" | "mcp";
	/** Whether the page is signed in by it. */
	current: boolean;
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
		const json = JSON.parse(text) as {
			message?: unknown;
			error_description?: unknown;
		};
		const message = json.message ?? json.error_description;
		if (typeof message === "string") return message;
	} catch {}
	return text || response.statusText;
}

async function call<T>(
	method: string,
	path: string,
	body?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(page(path), {
		method,
		...(signal && { signal }),
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
	/** The version of everything the account sees at once; with `version`, it
	 * waits until that differs, at most four minutes. */
	version: async (version?: string, signal?: AbortSignal) =>
		(
			await call<{ version: string }>(
				"GET",
				version === undefined
					? "api/overview"
					: `api/overview?version=${encodeURIComponent(version)}&wait=240`,
				undefined,
				signal,
			)
		).version,
	agents: async (): Promise<Agents> => {
		const { agents, online } = await call<{
			agents: Agent[];
			online: string[];
		}>("GET", "api/overview");
		return { own: agents, online };
	},
	groups: () => call<Group[]>("GET", "api/groups"),
	createGroup: (name: string) => call<Group>("POST", "api/groups", { name }),
	deleteGroup: (id: string) =>
		call<void>("DELETE", `api/groups/${encodeURIComponent(id)}`),
	addMember: (group: string, name: string) =>
		call<void>(
			"PUT",
			`api/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(name)}`,
		),
	removeMember: (group: string, name: string) =>
		call<void>(
			"DELETE",
			`api/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(name)}`,
		),
	projects: () => call<Project[]>("GET", "api/projects"),
	createProject: (group: string, name: string) =>
		call<Project>("POST", "api/projects", { name, group }),
	changeProject: (id: string, change: { name?: string; repos?: string[] }) =>
		call<Project>("PATCH", `api/projects/${encodeURIComponent(id)}`, change),
	deleteProject: (id: string) =>
		call<void>("DELETE", `api/projects/${encodeURIComponent(id)}`),
	sessions: () => call<Session[]>("GET", "api/sessions"),
	createSession: (project: string, name: string) =>
		call<Session>("POST", "api/sessions", { name, project }),
	changeSession: (id: string, change: { name: string }) =>
		call<Session>("PATCH", `api/sessions/${encodeURIComponent(id)}`, change),
	deleteSession: (id: string) =>
		call<void>("DELETE", `api/sessions/${encodeURIComponent(id)}`),
	friends: () => call<Friend[]>("GET", "api/friends"),
	activity: () => call<Activity[]>("GET", "api/activity"),
	/** Deletes the account: only the person, signed in, may. */
	deleteAccount: () => call<void>("DELETE", "api/me"),
	dms: () => call<Dm[]>("GET", "api/dms"),
	/** An invite to be friends and join the session's group, landing in it. */
	inviteToSession: (session: string) =>
		call<{ link: string }>("POST", "api/invites", { session }),
	addFriend: (name: string) =>
		call<void>("PUT", `api/friends/${encodeURIComponent(name)}`),
	removeFriend: (name: string) =>
		call<void>("DELETE", `api/friends/${encodeURIComponent(name)}`),
	logins: () => call<Login[]>("GET", "api/logins"),
	revoke: (id: string) =>
		call<void>("DELETE", `api/logins/${encodeURIComponent(id)}`),
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
	const named = (id: string) =>
		groups.find((group) => group.id === id) as Named;
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
			friend: null,
			creator: me.name,
		};
	};
	const general = (group: string): Session => ({
		id: `s_general_${group}`,
		name: "general",
		project: null,
		group: named(group),
		general: true,
		pinged: group === "g_1",
		friend: null,
		creator: null,
	});
	let sessions: Session[] = [
		general("g_0"),
		general("g_1"),
		{ id: "s_1", name: "notes", ...inProject("p_1") },
		{ id: "s_2", name: "agents", ...inProject("p_2") },
		{ id: "s_3", name: "demo", ...inProject("p_2") },
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
	let logins: Login[] = [
		{
			id: "w_1",
			name: "a sign-in",
			kind: "browser",
			current: true,
			created: "2026-11-08T20:00:00Z",
		},
		{
			id: "o_1",
			name: "Claude Code",
			kind: "mcp",
			current: false,
			created: "2026-11-09T00:12:00Z",
		},
		{
			id: "t_1",
			name: "lwirth-macbook",
			kind: "machine",
			current: false,
			created: "2026-11-09T00:10:00Z",
		},
	];
	const done = async () => {};
	return {
		me: async () => me,
		// Nothing changes on its own here.
		version: (version?: string, signal?: AbortSignal) =>
			version === undefined
				? Promise.resolve("demo")
				: new Promise<string>((_, reject) =>
						signal?.addEventListener("abort", () =>
							reject(new DOMException("Aborted", "AbortError")),
						),
					),
		agents: async () => ({
			own: [
				{
					name: "luiswirth/claude",
					online: true,
					receiving: [{ id: "s_2", name: "agents" }],
				},
				{
					name: "luiswirth/codex",
					online: false,
					seen: new Date(Date.now() - 3 * 3600_000).toISOString(),
					receiving: [],
				},
			],
			online: ["benarmstrong/claude", "luiswirth/claude", "tristangabl/codex"],
		}),
		groups: async () => groups,
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
		projects: async () => projects,
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
		sessions: async () => sessions,
		createSession: async (project, name) => {
			const session = {
				id: `s_${Date.now()}`,
				name,
				...inProject(project),
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
		friends: async () => friends,
		activity: async () => [
			{
				agent: "lwirth-macbook",
				login: "t_1",
				operation: "add_friend",
				arguments: { name: "tristangabl" },
				created: new Date(Date.now() - 3 * 3600_000).toISOString(),
			},
			{
				agent: "Claude Code",
				login: "o_1",
				operation: "create_session",
				arguments: { project: "p_2", name: "demo" },
				created: new Date(Date.now() - 26 * 3600_000).toISOString(),
			},
		],
		deleteAccount: done,
		inviteToSession: async () => ({
			link: `${location.origin}/i/demo2invite`,
		}),
		dms: async () =>
			friends
				.filter((friend) => friend.state === "friends")
				.map((friend) => ({
					id: `s_dm_${friend.name}`,
					name: "DM",
					project: null,
					group: null,
					general: false,
					pinged: false,
					friend: friend.name,
					creator: null,
				})),
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
		logins: async () => logins,
		revoke: async (id) => {
			logins = logins.filter((login) => login.id !== id);
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
