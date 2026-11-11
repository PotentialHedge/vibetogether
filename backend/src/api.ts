/**
 * The operations under `/api/`, each declared once (`openapi.ts`).
 * An agent with its person's token does everything the person does on the website, but
 * deleting the account; signing in and approving an OTP are Better Auth's, outside these.
 */
import { grantKey } from "./caller.ts";
import { changed, versionOf } from "./changes.ts";
import {
	areFriends,
	db,
	dmOf,
	isMember,
	newId,
	ownGroupOf,
	transaction,
} from "./db.ts";
import { inviteOperations } from "./invites.ts";
import { documentOf as documentFrom, newApi, operation, z } from "./openapi.ts";
import { referenceOf } from "./reference.ts";
import { maxRepos, reposOf, reposOfInput, setRepos } from "./repos.ts";
import {
	body,
	count,
	done,
	Id,
	json,
	Login,
	Name,
	Named,
	path,
} from "./schemas.ts";
import {
	projectSessionsOf,
	Session,
	sessionJson,
	sessionOperations,
} from "./sessions.ts";
import { Refused } from "./transport.ts";

export const api = newApi();

const Repos = z
	.array(z.string())
	.max(maxRepos)
	.meta({
		description: `GitHub repositories, at most ${maxRepos}, each as \`owner/name\` or its URL.`,
	});

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
		repos: z.array(z.string()).meta({
			description: "The GitHub repositories it points at, each as its URL.",
		}),
	})
	.openapi("Project");

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

const LoginJson = z
	.object({
		id: z.string().meta({
			description: "The login's id, which needs no encoding in a path.",
		}),
		name: z.string().meta({
			description:
				"The machine's name for a machine's token, the client's for an MCP client's, and `a sign-in` for a browser's.",
		}),
		kind: z.enum(["browser", "machine", "mcp"]),
		current: z
			.boolean()
			.meta({ description: "Whether the request was made by it." }),
		created: z.string(),
	})
	.openapi("Login");

const Activity = z
	.object({
		agent: z.string().meta({
			description:
				"The name of the login that made it, such as the machine's or the MCP client's: every agent on a machine shares its token.",
		}),
		login: z.string().meta({
			description: "The id of that login, as `list_logins` gives it.",
		}),
		operation: z
			.string()
			.meta({ description: "The operation's id, such as `add_friend`." }),
		arguments: z.record(z.string(), z.unknown()),
		created: z.string(),
	})
	.openapi("Activity");

type Person = { id: string; login: string; name: string; image: string | null };

function personByLogin(login: string): Person | undefined {
	return db
		.prepare("SELECT id, login, name, image FROM user WHERE login = ?")
		.get(login) as Person | undefined;
}

type GroupRow = {
	id: string;
	name: string;
	person: string | null;
	created: string;
};
type ProjectRow = { id: string; name: string; group: string; created: string };

/** The group, where `user` is in it: to anyone else no group shows. */
function groupFor(id: string, user: string): GroupRow | undefined {
	const group = db.prepare(`SELECT * FROM "group" WHERE id = ?`).get(id) as
		| GroupRow
		| undefined;
	return group && isMember(group.id, user) ? group : undefined;
}

function projectFor(id: string, user: string): ProjectRow | undefined {
	const project = db.prepare("SELECT * FROM project WHERE id = ?").get(id) as
		| ProjectRow
		| undefined;
	return project && isMember(project.group, user) ? project : undefined;
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
			`SELECT g.* FROM "group" g JOIN group_member m ON m."group" = g.id WHERE m.user = ? ORDER BY g.person IS NULL, g.created`,
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
		own: group.person !== null,
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
		repos: reposOf(project.id),
	};
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

/** The sessions of `me`'s DMs, with each friend, while they are friends. */
function dmsOf(me: string): z.infer<typeof Session>[] {
	const friends = db
		.prepare(
			`SELECT f."to" AS friend FROM friend f JOIN friend r ON r."from" = f."to" AND r."to" = f."from"
			 JOIN user u ON u.id = f."to" WHERE f."from" = ? ORDER BY u.login`,
		)
		.all(me) as { friend: string }[];
	return friends.map(({ friend }) => sessionJson(dmOf(me, friend), me));
}

/** The limits on what one account has. */
const maxGroups = 20;
const maxMembers = 50;
const maxProjects = 50;

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
			"The account, its groups each with its projects and their sessions, its DMs and its friends: all an agent needs to find a session, in one request, with the ids the other operations take. With `version`, it waits until any of it changes, such as by a friend or another agent.",
		request: {
			query: z
				.object({
					version: z.string().optional().meta({
						description:
							"An overview's `version`: waits until the overview differs from it, and returns at once where it already does.",
					}),
					wait: z.coerce.number().int().min(0).optional().meta({
						description:
							"Waits at most this many seconds, and then returns the overview as it is.",
					}),
				})
				.strict(),
		},
		responses: {
			200: json(
				z.object({
					account: Account,
					groups: z.array(
						Group.extend({
							projects: z.array(Project.extend({ sessions: z.array(Session) })),
						}),
					),
					dms: z.array(Session),
					friends: z.array(Friend),
					version: z.string().meta({
						description: "Differs wherever the rest does.",
					}),
				}),
				"The account and what it has.",
			),
		},
	}),
	async (c) => {
		const me = c.var.caller.id;
		const { version, wait } = c.req.valid("query");
		try {
			const overview =
				version === undefined
					? overviewOf(me)
					: await changed(
							me,
							() => overviewOf(me),
							version,
							wait,
							c.req.raw.signal,
						);
			if (!overview) return c.text("The wait was cut off.", 400);
			return c.json({ ...overview, version: versionOf(overview) }, 200);
		} catch (error) {
			if (!(error instanceof Refused)) throw error;
			if (error.retryAfter !== undefined)
				c.header("Retry-After", String(error.retryAfter));
			return c.text(error.message, error.status);
		}
	},
);

/** Everything the account sees at once, as `overview` answers it. */
function overviewOf(me: string) {
	const sessions = projectSessionsOf(me).map((id) => sessionJson(id, me));
	const projects = projectsOf(me).map((project) => ({
		...projectJson(project),
		sessions: sessions.filter((s) => s.project?.id === project.id),
	}));
	return {
		account: accountJson(me),
		groups: groupsOf(me).map((group) => ({
			...groupJson(group),
			projects: projects.filter((p) => p.group.id === group.id),
		})),
		dms: dmsOf(me),
		friends: friendsOf(me),
	};
}

api.openapi(
	operation({
		id: "activity",
		tag: "Account",
		who: "account",
		method: "get",
		path: "/activity",
		summary: "List what agents changed",
		description:
			"What the account's agents changed in it, newest first, at most the last 200: each change with the operation's id and its arguments. What they said in sessions is in the sessions' logs.",
		responses: { 200: json(z.array(Activity), "The changes.") },
	}),
	(c) => {
		const rows = db
			.prepare(
				"SELECT login, agent, operation, arguments, created FROM activity WHERE user = ? ORDER BY id DESC LIMIT 200",
			)
			.all(c.var.caller.id) as {
			login: string;
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
			"Deletes the account with its logins and its DMs, and every group it is the last member of, with their projects and sessions; it leaves the other groups.",
		responses: done,
	}),
	(c) => {
		const me = c.var.caller.id;
		transaction(() => {
			db.prepare(
				`DELETE FROM "group" WHERE id IN (SELECT "group" FROM group_member WHERE user = ?)
				 AND NOT EXISTS (SELECT 1 FROM group_member m WHERE m."group" = "group".id AND m.user != ?)`,
			).run(me, me);
			db.prepare("DELETE FROM user WHERE id = ?").run(me);
		});
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
		const me = c.var.caller.id;
		if (
			count(
				`SELECT count(*) AS n FROM group_member m JOIN "group" g ON g.id = m."group" WHERE m.user = ? AND g.person IS NULL`,
				me,
			) >= maxGroups
		)
			return c.text(
				`A person creates a group only while in fewer than ${maxGroups} besides their own: leave one first.`,
				403,
			);
		const group: GroupRow = {
			id: newId("g"),
			name: c.req.valid("json").name,
			person: null,
			created: new Date().toISOString(),
		};
		transaction(() => {
			db.prepare(
				`INSERT INTO "group" (id, name, created) VALUES (?, ?, ?)`,
			).run(group.id, group.name, group.created);
			db.prepare(`INSERT INTO group_member ("group", user) VALUES (?, ?)`).run(
				group.id,
				me,
			);
		});
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
			"Renames a group. Any member does this; one's own group is named after them.",
		request: {
			...path({ id: Id("g", "group") }),
			...body(z.object({ name: Name })),
		},
		responses: { 200: json(Group, "The group.") },
	}),
	(c) => {
		const group = groupFor(c.req.valid("param").id, c.var.caller.id);
		if (!group) return c.text("No such group.", 404);
		if (group.person) return c.text("Your own group is named after you.", 403);
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
		if (group.person)
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
		const group = groupFor(id, c.var.caller.id);
		if (!group) return c.text("No such group.", 404);
		if (group.person) return c.text("Your own group holds you alone.", 403);
		const person = personByLogin(name);
		if (!person)
			return c.text(
				"No such person on Vibe Together: an invite to one of the group's projects (`create_invite` with `project`) reaches someone new.",
				404,
			);
		if (isMember(group.id, person.id)) return c.json(groupJson(group), 200);
		if (!areFriends(c.var.caller.id, person.id))
			return c.text(
				"Only a friend of yours becomes a member through you: an invite to one of the group's projects (`create_invite` with `project`) makes them both.",
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
		const group = groupFor(id, c.var.caller.id);
		if (!group) return c.text("No such group.", 404);
		if (group.person) return c.text("Your own group holds you alone.", 403);
		const person = personByLogin(name);
		if (!person || !isMember(group.id, person.id))
			return c.text("No such member.", 404);
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

const badRepos =
	"repos: each is a GitHub repository, as owner/name or its URL.";

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
		const me = c.var.caller.id;
		const input = c.req.valid("json");
		const repos = reposOfInput(input.repos ?? []);
		if (!repos) return c.text(badRepos, 400);
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
		const input = c.req.valid("json");
		const repos = input.repos && reposOfInput(input.repos);
		if (input.repos && !repos) return c.text(badRepos, 400);
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
		db.prepare("DELETE FROM project WHERE id = ?").run(project.id);
		return c.body(null, 204);
	},
);

sessionOperations(api);

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
		const me = c.var.caller.id;
		const person = personByLogin(c.req.valid("param").name);
		if (!person)
			return c.text(
				"No such person on Vibe Together: an invite (`create_invite`) reaches someone new.",
				404,
			);
		if (person.id === me)
			return c.text("You can't add yourself as a friend.", 400);
		db.prepare(
			`INSERT OR IGNORE INTO friend ("from", "to", created) VALUES (?, ?, ?)`,
		).run(me, person.id, new Date().toISOString());
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
			"Removes a friend, which also declines or withdraws an ask. Groups they share stay as they are. Their DM closes, and comes back with its history once they are friends again.",
		request: path({ name: Login }),
		responses: done,
	}),
	(c) => {
		const me = c.var.caller.id;
		const person = personByLogin(c.req.valid("param").name);
		if (!person) return c.text("No such person.", 404);
		db.prepare(
			`DELETE FROM friend WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)`,
		).run(me, person.id, person.id, me);
		return c.body(null, 204);
	},
);

api.openapi(
	operation({
		id: "list_dms",
		tag: "Friends",
		who: "account",
		method: "get",
		path: "/dms",
		summary: "List the DMs",
		description: "The caller's DMs, one session with each friend.",
		responses: { 200: json(z.array(Session), "The DMs.") },
	}),
	(c) => c.json(dmsOf(c.var.caller.id), 200),
);

// Logins: each a sign-in or a machine's token, a row of Better Auth's `login`, or an MCP
// client's, an OAuth grant.

function iso(time: string | number | Date): string {
	return new Date(time).toISOString();
}

api.openapi(
	operation({
		id: "list_logins",
		tag: "Logins",
		who: "account",
		method: "get",
		path: "/logins",
		summary: "List the logins",
		description: "The account's logins, oldest first.",
		responses: { 200: json(z.array(LoginJson), "The logins.") },
	}),
	(c) => {
		const caller = c.var.caller;
		const rows = db
			.prepare(
				"SELECT id, machine, createdAt FROM login WHERE userId = ? AND expiresAt > ?",
			)
			.all(caller.id, Date.now()) as {
			id: string;
			machine: string | null;
			createdAt: string | number;
		}[];
		const grants = db
			.prepare(
				`SELECT ${grantKey} AS grant, c.name, min(t.createdAt) AS createdAt
				 FROM (SELECT authorizationCodeId, clientId, userId, createdAt, expiresAt, revoked FROM oauthRefreshToken
				       UNION ALL SELECT authorizationCodeId, clientId, userId, createdAt, expiresAt, revoked FROM oauthAccessToken) t
				 LEFT JOIN oauthClient c ON c.clientId = t.clientId
				 WHERE t.userId = ? AND t.revoked IS NULL AND t.expiresAt > ?
				 GROUP BY grant`,
			)
			.all(caller.id, Date.now()) as {
			grant: string;
			name: string | null;
			createdAt: string | number;
		}[];
		const logins = [
			...rows.map((row) => ({
				id: `${row.machine ? "t" : "w"}_${row.id}`,
				name: row.machine ?? "a sign-in",
				kind: row.machine ? ("machine" as const) : ("browser" as const),
				created: iso(row.createdAt),
			})),
			...grants.map((grant) => ({
				id: `o_${Buffer.from(grant.grant).toString("base64url")}`,
				name: grant.name ?? "an MCP client",
				kind: "mcp" as const,
				created: iso(grant.createdAt),
			})),
		]
			.map((login) => ({ ...login, current: login.id === caller.loginId }))
			.sort((a, b) => a.created.localeCompare(b.created));
		return c.json(logins, 200);
	},
);

/** Revokes `me`'s login `id`, as `list_logins` gives it; whether there was one. */
function revokeLogin(me: string, id: string): boolean {
	if (id.startsWith("t_") || id.startsWith("w_"))
		return (
			db
				.prepare("DELETE FROM login WHERE id = ? AND userId = ?")
				.run(id.slice(2), me).changes > 0
		);
	if (!id.startsWith("o_")) return false;
	const grant = Buffer.from(id.slice(2), "base64url").toString();
	return transaction(() => {
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
		const access = db
			.prepare(
				`DELETE FROM oauthAccessToken AS t WHERE ${grantKey} = ? AND userId = ?`,
			)
			.run(grant, me).changes;
		const refresh = db
			.prepare(
				`DELETE FROM oauthRefreshToken AS t WHERE ${grantKey} = ? AND userId = ?`,
			)
			.run(grant, me).changes;
		return Number(access) + Number(refresh) > 0;
	});
}

api.openapi(
	operation({
		id: "revoke_login",
		tag: "Logins",
		who: "account",
		method: "delete",
		path: "/logins/{id}",
		summary: "Revoke a login",
		description:
			"Revokes a login, which cuts off at once whatever it reached, a receive already waiting included, within a few seconds. An MCP client asks the person again before it gets another. Revoking the login the request is made by signs it out.",
		request: path({ id: z.string().meta({ description: "The login's id." }) }),
		responses: done,
	}),
	(c) =>
		revokeLogin(c.var.caller.id, c.req.valid("param").id)
			? c.body(null, 204)
			: c.text("No such login.", 404),
);

inviteOperations(api);

// The document, once every operation is declared, made at the first request, and the
// reference rendered from it.
let document: ReturnType<typeof documentFrom> | undefined;
let reference: string | undefined;

/** The OpenAPI document, the one definition of every operation. */
export function documentOf() {
	document ??= documentFrom(api);
	return document;
}

api.get("/openapi.json", (c) => c.json(documentOf()));
api.get("/reference.md", (c) => {
	reference ??= referenceOf(
		documentOf() as unknown as Parameters<typeof referenceOf>[0],
	);
	return c.body(reference, 200, {
		"content-type": "text/markdown; charset=utf-8",
	});
});
