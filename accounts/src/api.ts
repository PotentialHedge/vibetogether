/**
 * The service's operations under `/api/`, each declared once (`openapi.ts`).
 * An agent with its person's token does everything the person does on the website, Luis's
 * decision (2026-11-10), but deleting the account; signing in and approving an OTP are Better
 * Auth's, outside these. An app's grant reaches only the app's own sessions.
 */
import { auth } from "./auth.ts";
import type { Caller } from "./caller.ts";
import { config } from "./config.ts";
import {
	appProjectOf,
	areFriends,
	db,
	dmOf,
	isMember,
	newId,
	ownGroupOf,
} from "./db.ts";
import { inviteOperations } from "./invites.ts";
import { isNamePart } from "./names.ts";
import { documentOf, newApi, operation, z } from "./openapi.ts";
import { referenceOf } from "./reference.ts";
import { maxRepos, reposOf, reposOfInput, setRepos } from "./repos.ts";
import {
	addressOf,
	createSession,
	live,
	type SessionRow,
	secretOf,
} from "./sessions.ts";

export const api = newApi();

// What the operations give and take.

const Id = (prefix: string, what: string) =>
	z.string().meta({ description: `The ${what}'s id, as \`${prefix}_…\`.` });

const Name = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.meta({ description: "A name, of at most 100 characters." });

const Login = z
	.string()
	.meta({ description: "A person's name: their GitHub login in lower case." });

const Repos = z
	.array(z.string())
	.max(maxRepos)
	.meta({
		description: `GitHub repositories, at most ${maxRepos}, each as \`owner/name\` or its URL.`,
	});

const Named = (prefix: string, what: string) =>
	z.object({ id: Id(prefix, what), name: z.string() });

const Account = z
	.object({
		name: Login,
		displayName: z.string(),
		image: z.string().nullable(),
	})
	.openapi("Account");

const Group = z
	.object({
		id: Id("g", "group"),
		name: z.string(),
		own: z.boolean().meta({
			description:
				"Whether it is the caller's own group, which holds them alone.",
		}),
		members: z.array(Login).meta({ description: "Everyone in it." }),
	})
	.openapi("Group");

const Project = z
	.object({
		id: Id("p", "project"),
		name: z.string(),
		group: Named("g", "group"),
		app: z.string().nullable().meta({
			description:
				"The app whose sessions it holds alone, such as `messagent`.",
		}),
		repos: z.array(z.string()).meta({
			description:
				"The GitHub repositories it points at, each as its URL, however it was given.",
		}),
	})
	.openapi("Project");

const Session = z
	.object({
		id: Id("s", "session"),
		name: z.string(),
		project: Named("p", "project"),
		group: Named("g", "group"),
		creator: Login.nullable(),
		app: Named("a", "app")
			.nullable()
			.meta({ description: "The app that owns it for its person, if any." }),
		address: z.string().nullable().meta({
			description: "Its address on the relay, which joining takes.",
		}),
	})
	.openapi("Session");

const Friend = z
	.object({
		name: Login,
		displayName: z.string(),
		image: z.string().nullable(),
		state: z.enum(["friends", "asked", "asking"]).meta({
			description:
				"`friends`, `asked` (the caller added them, they haven't added the caller yet) or `asking` (they added the caller).",
		}),
	})
	.openapi("Friend");

const Dm = z
	.object({
		id: Id("d", "DM"),
		friend: Login,
		address: z.string().nullable().meta({
			description: "Its address on the relay, which joining takes.",
		}),
	})
	.openapi("Dm");

const Token = z
	.object({
		id: z.string().meta({
			description: "The token's id, which needs no encoding in a path.",
		}),
		name: z.string().meta({
			description:
				"A machine's name for a machine's token, a client's name for an MCP client's.",
		}),
		kind: z.enum(["machine", "mcp"]),
		created: z.string(),
	})
	.openapi("Token");

const App = z
	.object({
		id: Id("a", "app"),
		name: z.string(),
		for: z
			.string()
			.nullable()
			.meta({ description: "What the app said it is for, in its own words." }),
		created: z.string(),
	})
	.openapi("App");

const Activity = z
	.object({
		agent: z.string().meta({
			description:
				"The name of the token or app that made it, such as the machine's or the MCP client's: every agent on a machine shares its token.",
		}),
		token: z.string().meta({
			description:
				"The id of that token or app, as `list_tokens` or `list_apps` gives it, never the token itself.",
		}),
		operation: z
			.string()
			.meta({ description: "The operation's id, such as `add_friend`." }),
		arguments: z.record(z.string(), z.unknown()),
		created: z.string(),
	})
	.openapi("Activity");

const json = <S extends z.ZodType>(schema: S, description: string) => ({
	description,
	content: { "application/json": { schema } },
});

const body = <S extends z.ZodType>(schema: S) => ({
	body: { content: { "application/json": { schema } }, required: true },
});

const path = <S extends z.ZodRawShape>(shape: S) => ({
	params: z.object(shape),
});

const done = { 204: { description: "Done." } };

// The rows, and what of them each operation answers with.

type Person = { id: string; login: string; name: string; image: string | null };

function personByLogin(login: string): Person | undefined {
	return db
		.prepare("SELECT id, login, name, image FROM user WHERE login = ?")
		.get(login) as Person | undefined;
}

type GroupRow = {
	id: string;
	name: string;
	owner: string;
	own: number;
	created: string;
};

type ProjectRow = {
	id: string;
	name: string;
	group: string;
	app: string | null;
	created: string;
};

/** A session with its project and group, as one query gives them. */
type SessionOfGroup = SessionRow & {
	projectName: string;
	groupId: string;
	groupName: string;
	groupOwner: string;
	creatorLogin: string | null;
};

const sessionsOfGroups = `SELECT s.*, p.name AS projectName, g.id AS groupId, g.name AS groupName, g.owner AS groupOwner,
	c.login AS creatorLogin
	FROM owned_session s JOIN project p ON p.id = s.project JOIN "group" g ON g.id = p."group"
	LEFT JOIN user c ON c.id = s.creator`;

/** The group, where `user` is in it: to anyone else no group shows, so that none is found by its id. */
function groupFor(id: string, user: string): GroupRow | undefined {
	const group = db.prepare(`SELECT * FROM "group" WHERE id = ?`).get(id) as
		| GroupRow
		| undefined;
	return group && isMember(group.id, user) ? group : undefined;
}

/** The project, where `user` is in its group. */
function projectFor(id: string, user: string): ProjectRow | undefined {
	const project = db.prepare("SELECT * FROM project WHERE id = ?").get(id) as
		| ProjectRow
		| undefined;
	return project && isMember(project.group, user) ? project : undefined;
}

/** The session, where `user` is in its project's group. */
function sessionFor(id: string, user: string): SessionOfGroup | undefined {
	const session = db
		.prepare(`${sessionsOfGroups} WHERE s.id = ? AND ${live}`)
		.get(id) as SessionOfGroup | undefined;
	return session && isMember(session.groupId, user) ? session : undefined;
}

function accountJson(id: string): z.infer<typeof Account> {
	const person = db
		.prepare("SELECT login, name, image FROM user WHERE id = ?")
		.get(id) as Person;
	return { name: person.login, displayName: person.name, image: person.image };
}

function groupsOf(user: string): GroupRow[] {
	return db
		.prepare(
			`SELECT g.* FROM "group" g JOIN group_member m ON m."group" = g.id WHERE m.user = ? ORDER BY g.own DESC, g.created`,
		)
		.all(user) as GroupRow[];
}

function groupJson(group: GroupRow): z.infer<typeof Group> {
	const members = db
		.prepare(
			`SELECT u.login FROM group_member m JOIN user u ON u.id = m.user WHERE m."group" = ? ORDER BY u.login`,
		)
		.all(group.id) as { login: string }[];
	return {
		id: group.id,
		name: group.name,
		own: group.own === 1,
		members: members.map((m) => m.login),
	};
}

function projectsOf(user: string): ProjectRow[] {
	return db
		.prepare(
			`SELECT p.* FROM project p JOIN group_member m ON m."group" = p."group" WHERE m.user = ? ORDER BY p.created`,
		)
		.all(user) as ProjectRow[];
}

function projectJson(project: ProjectRow): z.infer<typeof Project> {
	const group = db
		.prepare(`SELECT name FROM "group" WHERE id = ?`)
		.get(project.group) as { name: string };
	return {
		id: project.id,
		name: project.name,
		group: { id: project.group, name: group.name },
		app: project.app,
		repos: reposOf(project.id),
	};
}

function sessionsOf(user: string): SessionOfGroup[] {
	return db
		.prepare(
			`${sessionsOfGroups} JOIN group_member m ON m."group" = g.id WHERE m.user = ? AND ${live} ORDER BY s.created`,
		)
		.all(user) as SessionOfGroup[];
}

async function sessionJson(
	session: SessionOfGroup,
): Promise<z.infer<typeof Session>> {
	let address: string | null = null;
	try {
		address = addressOf(await secretOf(session));
	} catch (error) {
		console.error(`session ${session.id} has no address yet:`, error);
	}
	return {
		id: session.id,
		name: session.name,
		project: { id: session.project, name: session.projectName },
		group: { id: session.groupId, name: session.groupName },
		creator: session.creatorLogin,
		app: appOf(session),
		address,
	};
}

/** The app that owns a session for the person, as `/apps` lists it, or null for the person's own. */
function appOf(session: SessionRow): { id: string; name: string } | null {
	if (!session.app_grant) return null;
	const grant = db
		.prepare("SELECT agent FROM session WHERE id = ?")
		.get(session.app_grant) as { agent: string } | undefined;
	return grant ? { id: `a_${session.app_grant}`, name: grant.agent } : null;
}

function friendsOf(me: string): z.infer<typeof Friend>[] {
	const rows = db
		.prepare(
			`SELECT u.login, u.name, u.image, mine."from" IS NOT NULL AS added, theirs."from" IS NOT NULL AS addedBy
			 FROM user u
			 LEFT JOIN friend mine ON mine."from" = ? AND mine."to" = u.id
			 LEFT JOIN friend theirs ON theirs."from" = u.id AND theirs."to" = ?
			 WHERE mine."from" IS NOT NULL OR theirs."from" IS NOT NULL
			 ORDER BY u.login`,
		)
		.all(me, me) as {
		login: string;
		name: string;
		image: string | null;
		added: number;
		addedBy: number;
	}[];
	return rows.map((row) => ({
		name: row.login,
		displayName: row.name,
		image: row.image,
		state:
			row.added && row.addedBy ? "friends" : row.added ? "asked" : "asking",
	}));
}

type DmRow = { id: string; secret: string | null; friend: string };

async function dmsOf(me: string): Promise<z.infer<typeof Dm>[]> {
	const dms = db
		.prepare(
			`SELECT d.id, d.secret, u.login AS friend FROM dm d
			 JOIN user u ON u.id = CASE WHEN d.a = ? THEN d.b ELSE d.a END
			 WHERE ? IN (d.a, d.b)
			 AND EXISTS (SELECT 1 FROM friend WHERE "from" = d.a AND "to" = d.b)
			 AND EXISTS (SELECT 1 FROM friend WHERE "from" = d.b AND "to" = d.a)
			 ORDER BY u.login`,
		)
		.all(me, me) as DmRow[];
	return Promise.all(
		dms.map(async (dm) => {
			let address: string | null = null;
			try {
				address = addressOf(await secretOf(dm, "dm"));
			} catch (error) {
				console.error(`DM ${dm.id} has no address yet:`, error);
			}
			return { id: dm.id, friend: dm.friend, address };
		}),
	);
}

/** The limits on what one account has. */
const maxGroups = 20;
const maxMembers = 50;
const maxProjects = 50;
const maxSessions = 20;

/** An app acts as its person only in its own sessions: groups, projects, friends and tokens stay the person's. */
const notForApps = "An app manages only its own sessions.";

/**
 * Why the caller may not manage a session, or undefined where it may:
 * an app's session is its app's alone, and an app manages only its own.
 */
function notManaged(session: SessionRow, caller: Caller): string | undefined {
	if (session.app_grant)
		return caller.token === `a_${session.app_grant}`
			? undefined
			: "This session is its app's: the app manages it, and revoking the app ends it.";
	return caller.app ? notForApps : undefined;
}

const count = (sql: string, ...args: string[]) =>
	(db.prepare(sql).get(...args) as { n: number }).n;

// Account

api.openapi(
	operation({
		id: "me",
		tag: "Account",
		who: "account",
		method: "get",
		path: "/me",
		summary: "Show the account",
		description:
			"The caller's account. Its agents take part under its `name`, as `<name>/<agent>`.",
		responses: { 200: json(Account, "The account.") },
	}),
	(c) => c.json(accountJson(c.var.caller.id), 200),
);

api.openapi(
	operation({
		id: "overview",
		tag: "Account",
		who: "account",
		method: "get",
		path: "/overview",
		summary: "Show everything at once",
		description:
			"The account, its groups each with its projects and their sessions, its DMs and its friends: all an agent needs to find a session, in one request, with the ids the other operations take.",
		responses: {
			200: json(
				z.object({
					account: Account,
					groups: z.array(
						Group.extend({
							projects: z.array(Project.extend({ sessions: z.array(Session) })),
						}),
					),
					dms: z.array(Dm),
					friends: z.array(Friend),
				}),
				"The account and what it has.",
			),
		},
	}),
	async (c) => {
		const me = c.var.caller.id;
		const sessions = await Promise.all(sessionsOf(me).map(sessionJson));
		const projects = projectsOf(me).map((project) => ({
			...projectJson(project),
			sessions: sessions.filter((s) => s.project.id === project.id),
		}));
		return c.json(
			{
				account: accountJson(me),
				groups: groupsOf(me).map((group) => ({
					...groupJson(group),
					projects: projects.filter((p) => p.group.id === group.id),
				})),
				dms: c.var.caller.app ? [] : await dmsOf(me),
				friends: friendsOf(me),
			},
			200,
		);
	},
);

api.openapi(
	operation({
		id: "activity",
		tag: "Account",
		who: "account",
		method: "get",
		path: "/activity",
		summary: "List what agents changed",
		description:
			"What the account's agents and apps changed in it, newest first, at most the last 200: each change with the operation's id and its arguments.",
		responses: { 200: json(z.array(Activity), "The changes.") },
	}),
	(c) => {
		const rows = db
			.prepare(
				"SELECT token, agent, operation, arguments, created FROM activity WHERE user = ? ORDER BY id DESC LIMIT 200",
			)
			.all(c.var.caller.id) as {
			token: string;
			agent: string;
			operation: string;
			arguments: string;
			created: string;
		}[];
		return c.json(
			rows.map((row) => ({ ...row, arguments: JSON.parse(row.arguments) })),
			200,
		);
	},
);

api.openapi(
	operation({
		id: "delete_account",
		tag: "Account",
		who: "browser",
		method: "delete",
		path: "/me",
		summary: "Delete the account",
		description:
			"Deletes the account with its tokens, its apps and its DMs, and every group it is the last member of, with their projects and sessions; it leaves the other groups.",
		responses: done,
	}),
	(c) => {
		const me = c.var.caller.id;
		// A group's `owner` is only who created it now, which the group outlives: deleting the
		// account would delete the group with it, so another member takes it over.
		db.prepare(
			`UPDATE "group" SET owner = (SELECT m.user FROM group_member m WHERE m."group" = "group".id AND m.user != ? LIMIT 1)
			 WHERE owner = ? AND own = 0 AND EXISTS (SELECT 1 FROM group_member m WHERE m."group" = "group".id AND m.user != ?)`,
		).run(me, me, me);
		db.prepare("DELETE FROM user WHERE id = ?").run(me);
		return c.body(null, 204);
	},
);

// Groups

api.openapi(
	operation({
		id: "list_groups",
		tag: "Groups",
		who: "account",
		method: "get",
		path: "/groups",
		summary: "List the groups",
		description: "The groups the caller is in, their own first.",
		responses: { 200: json(z.array(Group), "The groups.") },
	}),
	(c) => c.json(groupsOf(c.var.caller.id).map(groupJson), 200),
);

api.openapi(
	operation({
		id: "create_group",
		tag: "Groups",
		who: "account",
		method: "post",
		path: "/groups",
		summary: "Create a group",
		description: "Creates a group, with the caller as its first member.",
		request: body(z.object({ name: Name })),
		responses: { 201: json(Group, "The group.") },
	}),
	(c) => {
		const { id: me, app } = c.var.caller;
		if (app) return c.text(notForApps, 403);
		const { name } = c.req.valid("json");
		if (
			count(
				`SELECT count(*) AS n FROM "group" WHERE owner = ? AND own = 0`,
				me,
			) >= maxGroups
		)
			return c.text(
				`A person owns at most ${maxGroups} groups besides their own: delete one first.`,
				403,
			);
		const group: GroupRow = {
			id: newId("g"),
			name,
			owner: me,
			own: 0,
			created: new Date().toISOString(),
		};
		db.prepare(
			`INSERT INTO "group" (id, name, owner, own, created) VALUES (?, ?, ?, 0, ?)`,
		).run(group.id, group.name, me, group.created);
		db.prepare(`INSERT INTO group_member ("group", user) VALUES (?, ?)`).run(
			group.id,
			me,
		);
		return c.json(groupJson(group), 201);
	},
);

api.openapi(
	operation({
		id: "rename_group",
		tag: "Groups",
		who: "account",
		method: "patch",
		path: "/groups/{id}",
		summary: "Rename a group",
		description:
			"Renames a group. Any member does this; one's own group can't be renamed, since it is named after them.",
		request: {
			...path({ id: Id("g", "group") }),
			...body(z.object({ name: Name })),
		},
		responses: { 200: json(Group, "The group.") },
	}),
	(c) => {
		const group = groupFor(c.req.valid("param").id, c.var.caller.id);
		if (!group) return c.text("No such group.", 404);
		if (c.var.caller.app) return c.text(notForApps, 403);
		if (group.own) return c.text("Your own group is named after you.", 403);
		const { name } = c.req.valid("json");
		db.prepare(`UPDATE "group" SET name = ? WHERE id = ?`).run(name, group.id);
		return c.json(groupJson({ ...group, name }), 200);
	},
);

api.openapi(
	operation({
		id: "delete_group",
		tag: "Groups",
		who: "account",
		method: "delete",
		path: "/groups/{id}",
		summary: "Delete a group",
		description:
			"Deletes a group, with its projects and their sessions. Any member does this; one's own group stays.",
		request: path({ id: Id("g", "group") }),
		responses: done,
	}),
	(c) => {
		const group = groupFor(c.req.valid("param").id, c.var.caller.id);
		if (!group) return c.text("No such group.", 404);
		if (c.var.caller.app) return c.text(notForApps, 403);
		if (group.own)
			return c.text("Your own group stays as long as you do.", 403);
		db.prepare(`DELETE FROM "group" WHERE id = ?`).run(group.id);
		return c.body(null, 204);
	},
);

api.openapi(
	operation({
		id: "add_group_member",
		tag: "Groups",
		who: "account",
		method: "put",
		path: "/groups/{id}/members/{name}",
		summary: "Add a member to a group",
		description:
			"Adds a friend of the caller to a group. Any member does this, but one's own group holds them alone.",
		request: path({ id: Id("g", "group"), name: Login }),
		responses: { 200: json(Group, "The group.") },
	}),
	(c) => {
		const { id, name } = c.req.valid("param");
		if (c.var.caller.app) return c.text(notForApps, 403);
		const group = groupFor(id, c.var.caller.id);
		if (!group) return c.text("No such group.", 404);
		if (group.own) return c.text("Your own group holds you alone.", 403);
		const person = personByLogin(name);
		if (!person) return c.text("No such person.", 404);
		if (isMember(group.id, person.id)) return c.json(groupJson(group), 200);
		if (!areFriends(c.var.caller.id, person.id))
			return c.text(
				"Only a friend of yours becomes a member through you.",
				403,
			);
		if (
			count(
				`SELECT count(*) AS n FROM group_member WHERE "group" = ?`,
				group.id,
			) >= maxMembers
		)
			return c.text(`A group has at most ${maxMembers} members.`, 403);
		db.prepare(`INSERT INTO group_member ("group", user) VALUES (?, ?)`).run(
			group.id,
			person.id,
		);
		return c.json(groupJson(group), 200);
	},
);

api.openapi(
	operation({
		id: "remove_group_member",
		tag: "Groups",
		who: "account",
		method: "delete",
		path: "/groups/{id}/members/{name}",
		summary: "Remove a member from a group",
		description:
			"Removes a member from a group, the caller included, as one leaves it. Any member does this. The last member leaves only by deleting the group, with its projects and sessions.",
		request: path({ id: Id("g", "group"), name: Login }),
		responses: done,
	}),
	(c) => {
		const { id, name } = c.req.valid("param");
		const me = c.var.caller.id;
		if (c.var.caller.app) return c.text(notForApps, 403);
		const group = groupFor(id, me);
		if (!group) return c.text("No such group.", 404);
		const person = personByLogin(name);
		if (!person) return c.text("No such person.", 404);
		if (group.own) return c.text("Your own group holds you alone.", 403);
		if (!isMember(group.id, person.id)) return c.text("No such member.", 404);
		// Deleting a group deletes its sessions, so it is said explicitly, never a side effect of leaving.
		if (
			count(
				`SELECT count(*) AS n FROM group_member WHERE "group" = ?`,
				group.id,
			) === 1
		)
			return c.text(
				"This is the group's last member: delete the group instead, which deletes its projects and sessions.",
				409,
			);
		db.prepare(`DELETE FROM group_member WHERE "group" = ? AND user = ?`).run(
			group.id,
			person.id,
		);
		return c.body(null, 204);
	},
);

// Projects

api.openapi(
	operation({
		id: "list_projects",
		tag: "Projects",
		who: "account",
		method: "get",
		path: "/projects",
		summary: "List the projects",
		description: "The projects of the caller's groups.",
		responses: { 200: json(z.array(Project), "The projects.") },
	}),
	(c) => c.json(projectsOf(c.var.caller.id).map(projectJson), 200),
);

api.openapi(
	operation({
		id: "create_project",
		tag: "Projects",
		who: "account",
		method: "post",
		path: "/projects",
		summary: "Create a project",
		description:
			"Creates a project in a group, or in the caller's own where `group` is left out.",
		request: body(
			z.object({
				name: Name,
				group: Id("g", "group").optional(),
				repos: Repos.optional(),
			}),
		),
		responses: { 201: json(Project, "The project.") },
	}),
	(c) => {
		const { id: me, app } = c.var.caller;
		if (app) return c.text(notForApps, 403);
		const input = c.req.valid("json");
		const repos = reposOfInput(input.repos ?? []);
		if (!repos)
			return c.text(
				"repos: each is a GitHub repository, as owner/name or its URL.",
				400,
			);
		const group = groupFor(input.group ?? ownGroupOf(me), me);
		if (!group) return c.text("No such group.", 404);
		if (
			count(`SELECT count(*) AS n FROM project WHERE "group" = ?`, group.id) >=
			maxProjects
		)
			return c.text(
				`A group has at most ${maxProjects} projects: delete one first.`,
				403,
			);
		const project: ProjectRow = {
			id: newId("p"),
			name: input.name,
			group: group.id,
			app: null,
			created: new Date().toISOString(),
		};
		db.prepare(
			`INSERT INTO project (id, name, "group", created) VALUES (?, ?, ?, ?)`,
		).run(project.id, project.name, project.group, project.created);
		setRepos(project.id, repos);
		return c.json(projectJson(project), 201);
	},
);

api.openapi(
	operation({
		id: "change_project",
		tag: "Projects",
		who: "account",
		method: "patch",
		path: "/projects/{id}",
		summary: "Rename a project, or change its repos",
		description:
			"Renames a project, points it at other repos in place of its own, or both. Any member of its group does this.",
		request: {
			...path({ id: Id("p", "project") }),
			...body(z.object({ name: Name.optional(), repos: Repos.optional() })),
		},
		responses: { 200: json(Project, "The project.") },
	}),
	(c) => {
		const project = projectFor(c.req.valid("param").id, c.var.caller.id);
		if (!project) return c.text("No such project.", 404);
		if (c.var.caller.app) return c.text(notForApps, 403);
		if (project.app)
			return c.text(
				"This project holds its app's sessions, named after it.",
				403,
			);
		const input = c.req.valid("json");
		const repos = input.repos && reposOfInput(input.repos);
		if (input.repos && !repos)
			return c.text(
				"repos: each is a GitHub repository, as owner/name or its URL.",
				400,
			);
		const name = input.name ?? project.name;
		db.prepare("UPDATE project SET name = ? WHERE id = ?").run(
			name,
			project.id,
		);
		if (repos) setRepos(project.id, repos);
		return c.json(projectJson({ ...project, name }), 200);
	},
);

api.openapi(
	operation({
		id: "delete_project",
		tag: "Projects",
		who: "account",
		method: "delete",
		path: "/projects/{id}",
		summary: "Delete a project",
		description:
			"Deletes a project, with its sessions. Any member of its group does this.",
		request: path({ id: Id("p", "project") }),
		responses: done,
	}),
	(c) => {
		const project = projectFor(c.req.valid("param").id, c.var.caller.id);
		if (!project) return c.text("No such project.", 404);
		if (c.var.caller.app) return c.text(notForApps, 403);
		if (project.app)
			return c.text(
				"This project holds its app's sessions: revoking the app ends them.",
				403,
			);
		db.prepare("DELETE FROM project WHERE id = ?").run(project.id);
		return c.body(null, 204);
	},
);

// Sessions

api.openapi(
	operation({
		id: "list_sessions",
		tag: "Sessions",
		who: "account",
		method: "get",
		path: "/sessions",
		summary: "List the sessions",
		description: "The sessions of the caller's groups.",
		responses: { 200: json(z.array(Session), "The sessions.") },
	}),
	async (c) =>
		c.json(
			await Promise.all(sessionsOf(c.var.caller.id).map(sessionJson)),
			200,
		),
);

api.openapi(
	operation({
		id: "create_session",
		tag: "Sessions",
		who: "account",
		method: "post",
		path: "/sessions",
		summary: "Create a session",
		description:
			"Creates a session in a project, for the members of its group and their agents. An app leaves `project` out: its sessions go into its own project.",
		request: body(
			z.object({
				name: Name,
				project: Id("p", "project").optional(),
			}),
		),
		responses: { 201: json(Session, "The session.") },
	}),
	async (c) => {
		const caller = c.var.caller;
		const input = c.req.valid("json");
		// An app's sessions go into its project, which it neither names nor sees.
		let project: ProjectRow | undefined;
		if (caller.app) {
			if (input.project)
				return c.text("An app's sessions go into its own project.", 403);
			project = projectFor(appProjectOf(caller.id, caller.app), caller.id);
		} else {
			if (!input.project) return c.text("project: give the project's id.", 400);
			project = projectFor(input.project, caller.id);
			if (!project) return c.text("No such project.", 404);
			if (project.app)
				return c.text("This project holds its app's sessions alone.", 403);
		}
		if (!project) return c.text("No such project.", 404);
		if (
			count(
				`SELECT count(*) AS n FROM owned_session WHERE project = ? AND ${live}`,
				project.id,
			) >= maxSessions
		)
			return c.text(
				`A project has at most ${maxSessions} sessions: delete one first.`,
				403,
			);
		const appGrant = caller.app && caller.token ? caller.token.slice(2) : null;
		const session = await createSession(
			project.id,
			caller.id,
			input.name,
			"members",
			appGrant,
		);
		const created = sessionFor(session.id, caller.id);
		if (!created) return c.text("The session went at once.", 500);
		return c.json(await sessionJson(created), 201);
	},
);

api.openapi(
	operation({
		id: "rename_session",
		tag: "Sessions",
		who: "account",
		method: "patch",
		path: "/sessions/{id}",
		summary: "Rename a session",
		description:
			"Renames a session. Any member of its group does this, but an app's session is the app's alone.",
		request: {
			...path({ id: Id("s", "session") }),
			...body(z.object({ name: Name })),
		},
		responses: { 200: json(Session, "The session.") },
	}),
	async (c) => {
		const session = sessionFor(c.req.valid("param").id, c.var.caller.id);
		if (!session) return c.text("No such session.", 404);
		const notYours = notManaged(session, c.var.caller);
		if (notYours) return c.text(notYours, 403);
		const changed = { ...session, name: c.req.valid("json").name };
		db.prepare("UPDATE owned_session SET name = ? WHERE id = ?").run(
			changed.name,
			session.id,
		);
		return c.json(await sessionJson(changed), 200);
	},
);

api.openapi(
	operation({
		id: "delete_session",
		tag: "Sessions",
		who: "account",
		method: "delete",
		path: "/sessions/{id}",
		summary: "Delete a session",
		description:
			"Deletes a session: nobody joins it any more, and the relay deletes it once nobody is in it. Any member of its group does this. An app's session is the app's alone.",
		request: path({ id: Id("s", "session") }),
		responses: done,
	}),
	(c) => {
		const { caller } = c.var;
		const session = sessionFor(c.req.valid("param").id, caller.id);
		if (!session) return c.text("No such session.", 404);
		const notYours = notManaged(session, caller);
		if (notYours) return c.text(notYours, 403);
		db.prepare("DELETE FROM owned_session WHERE id = ?").run(session.id);
		return c.body(null, 204);
	},
);

// Friends

api.openapi(
	operation({
		id: "list_friends",
		tag: "Friends",
		who: "account",
		method: "get",
		path: "/friends",
		summary: "List the friends",
		description: "The caller's friends, and who asked whom.",
		responses: { 200: json(z.array(Friend), "The friends.") },
	}),
	(c) => c.json(friendsOf(c.var.caller.id), 200),
);

api.openapi(
	operation({
		id: "add_friend",
		tag: "Friends",
		who: "account",
		method: "put",
		path: "/friends/{name}",
		summary: "Add a friend",
		description:
			"Adds a person as a friend, which accepts where they asked first. Once both have added each other, they are friends, with a DM.",
		request: path({ name: Login }),
		responses: done,
	}),
	(c) => {
		const { id: me, app } = c.var.caller;
		if (app) return c.text(notForApps, 403);
		const person = personByLogin(c.req.valid("param").name);
		if (!person) return c.text("No such person.", 404);
		if (person.id === me)
			return c.text("You can't add yourself as a friend.", 400);
		db.prepare(
			`INSERT OR IGNORE INTO friend ("from", "to", created) VALUES (?, ?, ?)`,
		).run(me, person.id, new Date().toISOString());
		// Friends have a DM from the start.
		if (areFriends(me, person.id)) dmOf(me, person.id);
		return c.body(null, 204);
	},
);

api.openapi(
	operation({
		id: "remove_friend",
		tag: "Friends",
		who: "account",
		method: "delete",
		path: "/friends/{name}",
		summary: "Remove a friend",
		description:
			"Removes a friend, which also declines or withdraws an ask. Groups they share stay as they are. Their DM stays, closed, until they are friends again.",
		request: path({ name: Login }),
		responses: done,
	}),
	(c) => {
		const { id: me, app } = c.var.caller;
		if (app) return c.text(notForApps, 403);
		const person = personByLogin(c.req.valid("param").name);
		if (!person) return c.text("No such person.", 404);
		db.prepare(
			`DELETE FROM friend WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)`,
		).run(me, person.id, person.id, me);
		return c.body(null, 204);
	},
);

// DMs: one session per pair of friends, with the two people and their agents alone, and no
// group or project: to its people it is a DM, Luis's decision (2026-11-10). Unfriending ends
// access to it, and becoming friends again brings it back. Nobody renames or deletes one.
// An app reaches none, since it is no agent of the person's.

api.openapi(
	operation({
		id: "list_dms",
		tag: "DMs",
		who: "account",
		method: "get",
		path: "/dms",
		summary: "List the DMs",
		description: "The caller's DMs, one with each friend.",
		responses: { 200: json(z.array(Dm), "The DMs.") },
	}),
	async (c) => {
		if (c.var.caller.app) return c.text(notForApps, 403);
		return c.json(await dmsOf(c.var.caller.id), 200);
	},
);

// Tokens: each a machine's, a Better Auth session named after the machine, from an OTP or minted,
// or an MCP client's, an OAuth grant named after the client.

type AgentSession = { id: string; agent: string; createdAt: string | number };
/** One OAuth grant: the tokens that one authorization issued, refreshed ones included. */
type AgentGrant = {
	grant: string;
	name: string | null;
	createdAt: string | number;
};

// The tokens of one grant, by the authorization code that started it, which refreshing keeps.
const grantKey = "coalesce(t.authorizationCodeId, 'client:' || t.clientId)";

function iso(time: string | number | Date): string {
	return new Date(time).toISOString();
}

api.openapi(
	operation({
		id: "list_tokens",
		tag: "Tokens",
		who: "account",
		method: "get",
		path: "/tokens",
		summary: "List the tokens",
		description: "The account's tokens, oldest first.",
		responses: { 200: json(z.array(Token), "The tokens.") },
	}),
	(c) => {
		const me = c.var.caller.id;
		const sessions = db
			.prepare(
				"SELECT id, agent, createdAt FROM session WHERE userId = ? AND agent IS NOT NULL AND person IS NOT 1 AND expiresAt > ?",
			)
			.all(me, Date.now()) as AgentSession[];
		const grants = db
			.prepare(
				`SELECT ${grantKey} AS grant, c.name, min(t.createdAt) AS createdAt
				 FROM (SELECT authorizationCodeId, clientId, userId, createdAt, expiresAt, revoked FROM oauthRefreshToken
				       UNION ALL SELECT authorizationCodeId, clientId, userId, createdAt, expiresAt, revoked FROM oauthAccessToken) t
				 LEFT JOIN oauthClient c ON c.clientId = t.clientId
				 WHERE t.userId = ? AND t.revoked IS NULL AND t.expiresAt > ?
				 GROUP BY grant ORDER BY createdAt`,
			)
			.all(me, Date.now()) as AgentGrant[];
		return c.json(
			[
				...sessions.map((s) => ({
					id: `t_${s.id}`,
					name: s.agent,
					kind: "machine" as const,
					created: iso(s.createdAt),
				})),
				...grants.map((o) => ({
					id: `o_${Buffer.from(o.grant).toString("base64url")}`,
					name: o.name ?? "an MCP client",
					kind: "mcp" as const,
					created: iso(o.createdAt),
				})),
			].sort((a, b) => a.created.localeCompare(b.created)),
			200,
		);
	},
);

api.openapi(
	operation({
		id: "create_token",
		tag: "Tokens",
		who: "account",
		method: "post",
		path: "/tokens",
		summary: "Mint a machine's token",
		description:
			"Mints a token for a machine, for every agent on it. The answer holds the token itself as `token`, which nothing shows again. Revoking the token that minted it revokes it too.",
		request: body(
			z.object({
				name: z.string().meta({
					description:
						"The machine's name, in lower case, such as `lwirth-server`.",
				}),
			}),
		),
		responses: {
			201: json(
				Token.extend({ token: z.string() }),
				"The token, with its secret.",
			),
		},
	}),
	async (c) => {
		const { id: me, app, credential, token } = c.var.caller;
		if (app) return c.text(notForApps, 403);
		// A sign-in's own token would mint tokens that outlive signing out.
		if (credential && !token)
			return c.text(
				"A sign-in mints no token as a bearer: mint it with the cookie, or with an agent's token.",
				403,
			);
		const { name } = c.req.valid("json");
		if (!isNamePart(name))
			return c.text(
				"name: the machine's name, in lower case, such as lwirth-server.",
				400,
			);
		const context = await auth.$context;
		const session = await context.internalAdapter.createSession(me, false, {
			agent: name,
		});
		if (credential)
			db.prepare("INSERT INTO minted (session, by) VALUES (?, ?)").run(
				session.id,
				credential,
			);
		return c.json(
			{
				id: `t_${session.id}`,
				name,
				kind: "machine" as const,
				created: iso(session.createdAt),
				token: session.token,
			},
			201,
		);
	},
);

/** The credential a token's id stands for, as `minted` keeps it. */
function credentialOf(id: string): string {
	return id.startsWith("t_") ? `b_${id.slice(2)}` : id;
}

/** Revokes `me`'s token `id`, as `/tokens` lists it, and those it minted; whether there was one. */
function revokeToken(me: string, id: string): boolean {
	// The ones it minted first, since revoking it deletes the record of them.
	const minted = db
		.prepare("SELECT session FROM minted WHERE by = ?")
		.all(credentialOf(id)) as { session: string }[];
	for (const { session } of minted) revokeToken(me, `t_${session}`);
	if (id.startsWith("t_"))
		return (
			db
				.prepare(
					"DELETE FROM session WHERE id = ? AND userId = ? AND agent IS NOT NULL AND person IS NOT 1",
				)
				.run(id.slice(2), me).changes > 0
		);
	if (id.startsWith("o_")) {
		const grant = Buffer.from(id.slice(2), "base64url").toString();
		// The consent goes too, so that the client asks the person again rather than getting a token silently.
		const clients = db
			.prepare(
				`SELECT DISTINCT clientId FROM (SELECT authorizationCodeId, clientId, userId FROM oauthRefreshToken
				 UNION ALL SELECT authorizationCodeId, clientId, userId FROM oauthAccessToken) t
				 WHERE ${grantKey} = ? AND userId = ?`,
			)
			.all(grant, me) as { clientId: string }[];
		for (const { clientId } of clients)
			db.prepare(
				"DELETE FROM oauthConsent WHERE clientId = ? AND userId = ?",
			).run(clientId, me);
		const tokens = db
			.prepare(
				`DELETE FROM oauthAccessToken AS t WHERE ${grantKey} = ? AND userId = ?`,
			)
			.run(grant, me);
		const refresh = db
			.prepare(
				`DELETE FROM oauthRefreshToken AS t WHERE ${grantKey} = ? AND userId = ?`,
			)
			.run(grant, me);
		db.prepare("DELETE FROM minted WHERE by = ?").run(id);
		return tokens.changes > 0 || refresh.changes > 0;
	}
	return false;
}

api.openapi(
	operation({
		id: "revoke_own_token",
		tag: "Tokens",
		who: "account",
		method: "delete",
		path: "/tokens/self",
		summary: "Revoke the token in use",
		description: "Revokes the token the request carries, and those it minted.",
		responses: done,
	}),
	(c) => {
		const { id, token, app } = c.var.caller;
		if (!token || app) return c.text("The request carries no token.", 404);
		return revokeToken(id, token)
			? c.body(null, 204)
			: c.text("No such token.", 404);
	},
);

api.openapi(
	operation({
		id: "revoke_token",
		tag: "Tokens",
		who: "account",
		method: "delete",
		path: "/tokens/{id}",
		summary: "Revoke a token",
		description:
			"Revokes a token, and those it minted. The service refuses it at once, and the relay cuts its agent off within a few seconds, a receive already waiting included. An MCP client then asks the person again before it gets another.",
		request: path({ id: z.string().meta({ description: "The token's id." }) }),
		responses: done,
	}),
	(c) => {
		if (c.var.caller.app) return c.text(notForApps, 403);
		return revokeToken(c.var.caller.id, c.req.valid("param").id)
			? c.body(null, 204)
			: c.text("No such token.", 404);
	},
);

// Apps: each acts as its person, by a grant the person approved with an OTP, a Better Auth
// session marked as the person's. An app's grant is no token: tokens only connect agents.
// An app owns the sessions it creates, and revoking it ends them.

type AppGrant = {
	id: string;
	agent: string;
	claim: string | null;
	createdAt: string | number;
};

api.openapi(
	operation({
		id: "list_apps",
		tag: "Apps",
		who: "account",
		method: "get",
		path: "/apps",
		summary: "List the apps",
		description: "The apps that act as the person, oldest first.",
		responses: { 200: json(z.array(App), "The apps.") },
	}),
	(c) => {
		const grants = db
			.prepare(
				"SELECT id, agent, claim, createdAt FROM session WHERE userId = ? AND person = 1 AND expiresAt > ? ORDER BY createdAt",
			)
			.all(c.var.caller.id, Date.now()) as AppGrant[];
		return c.json(
			grants.map((g) => ({
				id: `a_${g.id}`,
				name: g.agent,
				for: g.claim,
				created: iso(g.createdAt),
			})),
			200,
		);
	},
);

/** Revokes `me`'s app grant `id`, as `/apps` lists it; whether there was one. */
function revokeApp(me: string, id: string): boolean {
	if (!id.startsWith("a_")) return false;
	const revoked =
		db
			.prepare("DELETE FROM session WHERE id = ? AND userId = ? AND person = 1")
			.run(id.slice(2), me).changes > 0;
	// Its sessions end with it.
	if (revoked)
		db.prepare("DELETE FROM owned_session WHERE app_grant = ?").run(
			id.slice(2),
		);
	return revoked;
}

api.openapi(
	operation({
		id: "unlink_app",
		tag: "Apps",
		who: "account",
		method: "delete",
		path: "/apps/self",
		summary: "Unlink the app in use",
		description:
			"Revokes the app's grant the request carries, as an app unlinks itself. For apps only.",
		responses: done,
	}),
	(c) => {
		const { id, token } = c.var.caller;
		return token && revokeApp(id, token)
			? c.body(null, 204)
			: c.text("The request carries no app's grant.", 404);
	},
);

api.openapi(
	operation({
		id: "revoke_app",
		tag: "Apps",
		who: "account",
		method: "delete",
		path: "/apps/{id}",
		summary: "Revoke an app",
		description: "Revokes an app's grant, which ends its sessions.",
		request: path({ id: Id("a", "app") }),
		responses: done,
	}),
	(c) => {
		if (c.var.caller.app) return c.text(notForApps, 403);
		return revokeApp(c.var.caller.id, c.req.valid("param").id)
			? c.body(null, 204)
			: c.text("No such app.", 404);
	},
);

inviteOperations(api, config.url);

// The document, once every operation is declared, made at the first request, and the
// reference rendered from it.
let document: ReturnType<typeof documentOf> | undefined;
let reference: string | undefined;
api.get("/openapi.json", (c) => {
	document ??= documentOf(api);
	return c.json(document);
});
api.get("/reference.md", (c) => {
	document ??= documentOf(api);
	reference ??= referenceOf(
		document as unknown as Parameters<typeof referenceOf>[0],
	);
	return c.body(reference, 200, {
		"content-type": "text/markdown; charset=utf-8",
	});
});
