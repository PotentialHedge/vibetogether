/** The account service, as its spec has it (`accounts/api.md`), served on
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
	owner: string;
	/** Everyone but the owner. */
	members: string[];
};

/** A reference to a group or a project, as a session or a project names it. */
export type Named = { id: string; name: string };

/** A group's named set of sessions. */
export type Project = {
	id: string;
	name: string;
	group: Named;
	/** The app whose sessions it holds, in the person's own group. */
	app: string | null;
	/** The GitHub repositories where its context lives, as their URLs. */
	repos: string[];
};

export type Session = {
	id: string;
	name: string;
	project: Named;
	group: Named;
	/** Who created it, who may delete it, as may the group's owner. */
	creator?: string | null;
	/** Who may join: its group's members only, or anyone with its address. */
	open: Open;
	/** Its URL on the relay, hard to guess: it identifies the session, and is its secret. */
	address: string;
	/** The app that owns it for the person, such as messagent for a Telegram
	 * chat, which manages it; none for the person's own. */
	app?: { id: string; name: string } | null;
};

export type Open = "members" | "link";

/** Two friends' DM: one session for the two of them and their agents, in no
 * group or project. */
export type Dm = {
	id: string;
	/** The friend's name. */
	friend: string;
	/** Its URL on the relay, as a session's. */
	address: string;
};

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
	changeSession: (id: string, change: { name?: string; open?: Open }) =>
		call<Session>("PATCH", `api/sessions/${encodeURIComponent(id)}`, change),
	deleteSession: (id: string) =>
		call<void>("DELETE", `api/sessions/${encodeURIComponent(id)}`),
	friends: () => call<Friend[]>("GET", "api/friends"),
	dms: () => call<Dm[]>("GET", "api/dms"),
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
	/** Signs out, and forgets the links the session pages kept to read on as
	 * `<name>/reader`, which act for the person. */
	signOut: async () => {
		await call<void>("POST", "api/auth/sign-out", {});
		for (const key of Object.keys(localStorage))
			if (/^vibetogether \S+ [^ /]+\/reader(-\d+)?$/.test(key))
				localStorage.removeItem(key);
	},
	/** The token of the page's own sign-in, with which a page joins a session
	 * as one of the person's, `<name>/<part>`, exactly where the person may. */
	pageToken: async () =>
		(await call<{ session: { token: string } }>("GET", "api/auth/get-session"))
			.session.token,
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
			owner: "luiswirth",
			members: [],
		},
		{
			id: "g_1",
			name: "Potential Hedge",
			own: false,
			owner: "luiswirth",
			members: ["benarmstrong", "tristangabl"],
		},
	];
	const named = (id: string) =>
		groups.find((group) => group.id === id) as Named;
	let projects: Project[] = [
		{
			id: "p_0",
			name: "messagent",
			group: named("g_0"),
			app: "messagent",
			repos: [],
		},
		{ id: "p_1", name: "notes", group: named("g_0"), app: null, repos: [] },
		{
			id: "p_2",
			name: "vibetogether",
			group: named("g_1"),
			app: null,
			repos: ["https://github.com/PotentialHedge/vibetogether"],
		},
	];
	const inProject = (id: string) => {
		const project = projects.find((p) => p.id === id) as Project;
		return {
			project: { id: project.id, name: project.name },
			group: project.group,
		};
	};
	let sessions: Session[] = [
		{
			id: "s_0",
			name: "Telegram",
			...inProject("p_0"),
			open: "members",
			address: "",
			app: { id: "a_1", name: "messagent" },
		},
		{
			id: "s_1",
			name: "notes",
			...inProject("p_1"),
			open: "members",
			address: "",
		},
		{
			id: "s_2",
			name: "agents",
			...inProject("p_2"),
			open: "members",
			address: "",
		},
		{ id: "s_3", name: "demo", ...inProject("p_2"), open: "link", address: "" },
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
		groups: async () => groups,
		createGroup: async (name) => {
			const group = {
				id: `g_${Date.now()}`,
				name,
				own: false,
				owner: me.name,
				members: [],
			};
			groups = [...groups, group];
			return group;
		},
		deleteGroup: async (id) => {
			groups = groups.filter((group) => group.id !== id);
			projects = projects.filter((project) => project.group.id !== id);
			sessions = sessions.filter((session) => session.group.id !== id);
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
				app: null,
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
			sessions = sessions.filter((session) => session.project.id !== id);
		},
		sessions: async () => sessions,
		createSession: async (project, name) => {
			const session = {
				id: `s_${Date.now()}`,
				name,
				...inProject(project),
				creator: me.name,
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
		friends: async () => friends,
		dms: async () =>
			friends
				.filter((friend) => friend.state === "friends")
				.map((friend) => ({
					id: `s_dm_${friend.name}`,
					friend: friend.name,
					address: "",
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
		pageToken: async () => "made-up-token-for-the-demo",
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
