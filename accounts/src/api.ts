import { Hono } from "hono";
import { auth } from "./auth.ts";
import { type Caller, callerOf } from "./caller.ts";
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
import { isNamePart } from "./names.ts";
import { reposHelp, reposOf, reposOfInput, setRepos } from "./repos.ts";
import {
	addressOf,
	createSession,
	live,
	type SessionRow,
	secretOf,
} from "./sessions.ts";

type Env = { Variables: { caller: Caller } };

type Person = { id: string; login: string; name: string; image: string | null };

function personByLogin(login: string): Person | undefined {
	return db
		.prepare("SELECT id, login, name, image FROM user WHERE login = ?")
		.get(login) as Person | undefined;
}

function loginOf(id: string): string {
	return (
		db.prepare("SELECT login FROM user WHERE id = ?").get(id) as {
			login: string;
		}
	).login;
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

function groupJson(group: GroupRow) {
	const members = db
		.prepare(
			`SELECT u.login FROM group_member m JOIN user u ON u.id = m.user WHERE m."group" = ? AND m.user != ? ORDER BY u.login`,
		)
		.all(group.id, group.owner) as { login: string }[];
	return {
		id: group.id,
		name: group.name,
		own: group.own === 1,
		owner: loginOf(group.owner),
		members: members.map((m) => m.login),
	};
}

function projectJson(project: ProjectRow) {
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

async function sessionJson(session: SessionOfGroup) {
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
		open: session.open,
		app: appOf(session),
		address,
	};
}

type Input = { name?: string; open?: SessionRow["open"]; place?: string };

const nameHelp = "a name of at most 100 characters";

/**
 * A name, who a session is open to, and where it goes, `project` or `group` as `place` is
 * named, as a request gives them, or undefined where they are malformed.
 */
function inputOf(
	body: unknown,
	place?: "project" | "group",
): Input | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const fields = body as Record<string, unknown>;
	const input: Input = {};
	if (fields.name !== undefined) {
		if (typeof fields.name !== "string") return undefined;
		const trimmed = fields.name.trim();
		if (trimmed.length === 0 || trimmed.length > 100) return undefined;
		input.name = trimmed;
	}
	if (fields.open !== undefined) {
		if (fields.open !== "members" && fields.open !== "link") return undefined;
		input.open = fields.open;
	}
	if (place && fields[place] !== undefined) {
		if (typeof fields[place] !== "string") return undefined;
		input.place = fields[place];
	}
	return input;
}

async function bodyOf(request: Request): Promise<unknown> {
	const text = await request.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export const api = new Hono<Env>();

/**
 * Whether the request is the person's, signed in in the browser, rather than an agent's with a token.
 * Letting others in, as friends, members or by opening a session to its address, is the person's
 * alone, so that an agent told to by someone else can't give them a seat in its person's sessions.
 * A sign-in's own token sent as a bearer is no browser: only the cookie is.
 */
function isPerson(request: Request): boolean {
	return !request.headers.has("authorization");
}

const onlyThePerson =
	"Only the person does this, signed in in the browser, never with a token.";

const origin = new URL(config.url).origin;

api.use(async (c, next) => {
	// A change by the person, signed in in the browser, comes from the account page alone: the
	// session cookie is sent from every site that counts as the same site, other subdomains included.
	const changes = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
	if (changes && isPerson(c.req.raw) && c.req.header("origin") !== origin)
		return c.text("A change by the person comes from the account page.", 403);
	const caller = await callerOf(c.req.raw.headers);
	if (!caller)
		return c.text(
			"Sign in, or send a token as Authorization: Bearer <token>.",
			401,
		);
	c.set("caller", caller);
	// Everyone has a group of their own, from their first request on.
	ownGroupOf(caller.id);
	await next();
});

api.get("/me", (c) => {
	const person = db
		.prepare("SELECT login, name, image FROM user WHERE id = ?")
		.get(c.var.caller.id) as Person;
	return c.json({
		name: person.login,
		displayName: person.name,
		image: person.image,
	});
});

// Groups: people. Everyone has a group of their own, which holds them alone; the owner of any
// other adds and removes its members, each a friend of theirs, and a member leaves on their own.

/** The most groups one person owns besides their own, members of one group, projects of one group, and sessions of one project. */
const maxGroups = 20;
const maxMembers = 50;
const maxProjects = 50;
const maxSessions = 20;

/** An app acts as its person only in its own sessions: groups and projects stay the person's. */
const notForApps = "An app manages only its own sessions.";

api.get("/groups", (c) => {
	const groups = db
		.prepare(
			`SELECT g.* FROM "group" g JOIN group_member m ON m."group" = g.id WHERE m.user = ? ORDER BY g.own DESC, g.created`,
		)
		.all(c.var.caller.id) as GroupRow[];
	return c.json(groups.map(groupJson));
});

api.post("/groups", async (c) => {
	const { id: me, app } = c.var.caller;
	if (app) return c.text(notForApps, 403);
	const input = inputOf(await bodyOf(c.req.raw));
	if (!input?.name)
		return c.text(`The body is {"name":"…"}, ${nameHelp}.`, 400);
	const owned = (
		db
			.prepare(`SELECT count(*) AS n FROM "group" WHERE owner = ? AND own = 0`)
			.get(me) as { n: number }
	).n;
	if (owned >= maxGroups)
		return c.text(
			`A person owns at most ${maxGroups} groups besides their own: delete one first.`,
			403,
		);
	const group: GroupRow = {
		id: newId("g"),
		name: input.name,
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
});

api.patch("/groups/:id", async (c) => {
	const group = groupFor(c.req.param("id"), c.var.caller.id);
	if (!group) return c.text("No such group.", 404);
	if (c.var.caller.app) return c.text(notForApps, 403);
	if (group.own) return c.text("Your own group is named after you.", 403);
	if (group.owner !== c.var.caller.id)
		return c.text("Only the group's owner renames it.", 403);
	const input = inputOf(await bodyOf(c.req.raw));
	if (!input?.name)
		return c.text(`The body is {"name":"…"}, ${nameHelp}.`, 400);
	db.prepare(`UPDATE "group" SET name = ? WHERE id = ?`).run(
		input.name,
		group.id,
	);
	return c.json(groupJson({ ...group, name: input.name }));
});

// With its projects and their sessions, so only the person, signed in in the browser.
api.delete("/groups/:id", (c) => {
	if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
	const group = groupFor(c.req.param("id"), c.var.caller.id);
	if (!group) return c.text("No such group.", 404);
	if (group.own) return c.text("Your own group stays as long as you do.", 403);
	if (group.owner !== c.var.caller.id)
		return c.text("Only the group's owner deletes it.", 403);
	db.prepare(`DELETE FROM "group" WHERE id = ?`).run(group.id);
	return c.body(null, 204);
});

api.put("/groups/:id/members/:name", (c) => {
	if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
	const group = groupFor(c.req.param("id"), c.var.caller.id);
	if (!group) return c.text("No such group.", 404);
	if (group.own) return c.text("Your own group holds you alone.", 403);
	if (group.owner !== c.var.caller.id)
		return c.text("Only the group's owner adds members.", 403);
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	if (isMember(group.id, person.id)) return c.json(groupJson(group));
	if (!areFriends(group.owner, person.id))
		return c.text("Only friends of the owner become members.", 403);
	const members = (
		db
			.prepare(`SELECT count(*) AS n FROM group_member WHERE "group" = ?`)
			.get(group.id) as { n: number }
	).n;
	if (members >= maxMembers)
		return c.text(`A group has at most ${maxMembers} members.`, 403);
	db.prepare(`INSERT INTO group_member ("group", user) VALUES (?, ?)`).run(
		group.id,
		person.id,
	);
	return c.json(groupJson(group));
});

api.delete("/groups/:id/members/:name", (c) => {
	const me = c.var.caller.id;
	if (c.var.caller.app) return c.text(notForApps, 403);
	const group = groupFor(c.req.param("id"), me);
	if (!group) return c.text("No such group.", 404);
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	if (person.id === group.owner)
		return c.text(
			"The owner stays in the group as long as it exists: delete it instead.",
			403,
		);
	if (group.owner !== me && person.id !== me)
		return c.text("Only the owner removes others from a group.", 403);
	db.prepare(`DELETE FROM group_member WHERE "group" = ? AND user = ?`).run(
		group.id,
		person.id,
	);
	return c.body(null, 204);
});

// Projects: each a group's named set of sessions. Any member creates and renames one,
// and only the group's owner deletes one. A project never moves to another group.

api.get("/projects", (c) => {
	const projects = db
		.prepare(
			`SELECT p.* FROM project p JOIN group_member m ON m."group" = p."group" WHERE m.user = ? ORDER BY p.created`,
		)
		.all(c.var.caller.id) as ProjectRow[];
	return c.json(projects.map(projectJson));
});

api.post("/projects", async (c) => {
	const { id: me, app } = c.var.caller;
	if (app) return c.text(notForApps, 403);
	const body = await bodyOf(c.req.raw);
	const input = inputOf(body, "group");
	const given = (body as { repos?: unknown } | null)?.repos;
	const repos = given === undefined ? [] : reposOfInput(given);
	if (!input?.name || !repos)
		return c.text(
			`The body is {"name":"…","group":"<id>","repos":[…]}, ${nameHelp}, the group your own where it is left out, and ${reposHelp}.`,
			400,
		);
	const group = input.place
		? groupFor(input.place, me)
		: groupFor(ownGroupOf(me), me);
	if (!group) return c.text("No such group.", 404);
	const projects = (
		db
			.prepare(`SELECT count(*) AS n FROM project WHERE "group" = ?`)
			.get(group.id) as { n: number }
	).n;
	if (projects >= maxProjects)
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
});

api.patch("/projects/:id", async (c) => {
	const project = projectFor(c.req.param("id"), c.var.caller.id);
	if (!project) return c.text("No such project.", 404);
	if (c.var.caller.app) return c.text(notForApps, 403);
	if (project.app)
		return c.text(
			"This project holds its app's sessions, named after it.",
			403,
		);
	const body = await bodyOf(c.req.raw);
	const input = inputOf(body);
	const given = (body as { repos?: unknown } | null)?.repos;
	const repos = given === undefined ? undefined : reposOfInput(given);
	if (
		!input ||
		(input.name === undefined && given === undefined) ||
		(given !== undefined && !repos)
	)
		return c.text(
			`The body is {"name":"…"}, {"repos":[…]} or both, ${nameHelp}, and ${reposHelp}.`,
			400,
		);
	const name = input.name ?? project.name;
	db.prepare("UPDATE project SET name = ? WHERE id = ?").run(name, project.id);
	if (repos) setRepos(project.id, repos);
	return c.json(projectJson({ ...project, name }));
});

// With its sessions, so only the person, signed in in the browser.
api.delete("/projects/:id", (c) => {
	if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
	const project = projectFor(c.req.param("id"), c.var.caller.id);
	if (!project) return c.text("No such project.", 404);
	if (c.var.caller.app) return c.text(notForApps, 403);
	if (project.app)
		return c.text(
			"This project holds its app's sessions: revoking the app ends them.",
			403,
		);
	const owner = (
		db.prepare(`SELECT owner FROM "group" WHERE id = ?`).get(project.group) as {
			owner: string;
		}
	).owner;
	if (owner !== c.var.caller.id)
		return c.text("Only the group's owner deletes its projects.", 403);
	db.prepare("DELETE FROM project WHERE id = ?").run(project.id);
	return c.body(null, 204);
});

// Sessions: each a project's, open to its group's members only, or to anyone with its address.
// Any member creates, renames and deletes one; only the group's owner opens one to its address.
// An app's sessions are its own, in its project of the person's own group.

/** The app that owns a session for the person, as `/apps` lists it, or null for the person's own. */
function appOf(session: SessionRow): { id: string; name: string } | null {
	if (!session.app_grant) return null;
	const grant = db
		.prepare("SELECT agent FROM session WHERE id = ?")
		.get(session.app_grant) as { agent: string } | undefined;
	return grant ? { id: `a_${session.app_grant}`, name: grant.agent } : null;
}

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

/** Why the request may not open a session of the group to its address, or undefined where it may. */
function notOpened(request: Request, groupOwner: string, caller: Caller) {
	if (!isPerson(request)) return onlyThePerson;
	if (groupOwner !== caller.id)
		return "Only the group's owner opens a session to anyone with its address.";
	return undefined;
}

api.get("/sessions", async (c) => {
	const sessions = db
		.prepare(
			`${sessionsOfGroups} JOIN group_member m ON m."group" = g.id WHERE m.user = ? AND ${live} ORDER BY s.created`,
		)
		.all(c.var.caller.id) as SessionOfGroup[];
	return c.json(await Promise.all(sessions.map(sessionJson)));
});

api.post("/sessions", async (c) => {
	const caller = c.var.caller;
	const input = inputOf(await bodyOf(c.req.raw), "project");
	const help = `The body is {"name":"…","project":"<id>","open":"members"|"link"}, ${nameHelp}, and "open" members where it is left out.`;
	if (!input?.name) return c.text(help, 400);
	// An app's sessions go into its project, which it neither names nor sees.
	let project: ProjectRow | undefined;
	if (caller.app) {
		if (input.place)
			return c.text("An app's sessions go into its own project.", 403);
		project = projectFor(appProjectOf(caller.id, caller.app), caller.id);
	} else {
		if (!input.place) return c.text(help, 400);
		project = projectFor(input.place, caller.id);
		if (!project) return c.text("No such project.", 404);
		if (project.app)
			return c.text("This project holds its app's sessions alone.", 403);
	}
	if (!project) return c.text("No such project.", 404);
	if (input.open === "link") {
		const owner = (
			db
				.prepare(`SELECT owner FROM "group" WHERE id = ?`)
				.get(project.group) as {
				owner: string;
			}
		).owner;
		const refused = notOpened(c.req.raw, owner, caller);
		if (refused) return c.text(refused, 403);
	}
	const sessions = (
		db
			.prepare(
				`SELECT count(*) AS n FROM owned_session WHERE project = ? AND ${live}`,
			)
			.get(project.id) as { n: number }
	).n;
	if (sessions >= maxSessions)
		return c.text(
			`A project has at most ${maxSessions} sessions: delete one first.`,
			403,
		);
	const appGrant = caller.app && caller.token ? caller.token.slice(2) : null;
	const session = await createSession(
		project.id,
		caller.id,
		input.name,
		input.open ?? "members",
		appGrant,
	);
	const created = sessionFor(session.id, caller.id);
	if (!created) return c.text("The session went at once.", 500);
	return c.json(await sessionJson(created), 201);
});

api.patch("/sessions/:id", async (c) => {
	const session = sessionFor(c.req.param("id"), c.var.caller.id);
	if (!session) return c.text("No such session.", 404);
	const notYours = notManaged(session, c.var.caller);
	if (notYours) return c.text(notYours, 403);
	const input = inputOf(await bodyOf(c.req.raw));
	if (!input)
		return c.text(
			`The body is {"name":"…","open":"members"|"link"}, each optional, ${nameHelp}.`,
			400,
		);
	if (input.open === "link" && session.open !== "link") {
		const refused = notOpened(c.req.raw, session.groupOwner, c.var.caller);
		if (refused) return c.text(refused, 403);
	}
	const changed = {
		...session,
		name: input.name ?? session.name,
		open: input.open ?? session.open,
	};
	db.prepare("UPDATE owned_session SET name = ?, open = ? WHERE id = ?").run(
		changed.name,
		changed.open,
		session.id,
	);
	return c.json(await sessionJson(changed));
});

// Deleting a session ends it for everyone, so only a person does it, in the browser, and only
// one they created or one in a group they own, Luis's decision (2026-11-10); an app deletes its own.
api.delete("/sessions/:id", (c) => {
	const { caller } = c.var;
	const session = sessionFor(c.req.param("id"), caller.id);
	if (!session) return c.text("No such session.", 404);
	const notYours = notManaged(session, caller);
	if (notYours) return c.text(notYours, 403);
	if (!session.app_grant) {
		if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
		if (session.creator !== caller.id && session.groupOwner !== caller.id)
			return c.text(
				"Only whoever created a session, or the group's owner, deletes it.",
				403,
			);
	}
	db.prepare("DELETE FROM owned_session WHERE id = ?").run(session.id);
	return c.body(null, 204);
});

// Friends

api.get("/friends", (c) => {
	const me = c.var.caller.id;
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
	return c.json(
		rows.map((row) => ({
			name: row.login,
			displayName: row.name,
			image: row.image,
			state:
				row.added && row.addedBy ? "friends" : row.added ? "asked" : "asking",
		})),
	);
});

api.put("/friends/:name", async (c) => {
	if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
	const me = c.var.caller.id;
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	if (person.id === me)
		return c.text("You can't add yourself as a friend.", 400);
	db.prepare(
		`INSERT OR IGNORE INTO friend ("from", "to", created) VALUES (?, ?, ?)`,
	).run(me, person.id, new Date().toISOString());
	// Friends have a DM from the start.
	if (areFriends(me, person.id)) dmOf(me, person.id);
	return c.body(null, 204);
});

api.delete("/friends/:name", (c) => {
	const me = c.var.caller.id;
	const person = personByLogin(c.req.param("name"));
	if (!person) return c.text("No such person.", 404);
	db.prepare(
		`DELETE FROM friend WHERE ("from" = ? AND "to" = ?) OR ("from" = ? AND "to" = ?)`,
	).run(me, person.id, person.id, me);
	// Members are friends of the owner, so they leave each other's groups too.
	db.prepare(
		`DELETE FROM group_member WHERE (user = ? AND "group" IN (SELECT id FROM "group" WHERE owner = ?)) OR (user = ? AND "group" IN (SELECT id FROM "group" WHERE owner = ?))`,
	).run(person.id, me, me, person.id);
	return c.body(null, 204);
});

// DMs: one session per pair of friends, with the two people and their agents alone, and no
// group or project: to its people it is a DM, Luis's decision (2026-11-10). Unfriending ends
// access to it, and becoming friends again brings it back. Nobody renames or deletes one.
// An app reaches none, since it is no agent of the person's.

type DmRow = { id: string; secret: string | null; friend: string };

api.get("/dms", async (c) => {
	const { id: me, app } = c.var.caller;
	if (app) return c.text(notForApps, 403);
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
	return c.json(
		await Promise.all(
			dms.map(async (dm) => {
				let address: string | null = null;
				try {
					address = addressOf(await secretOf(dm, "dm"));
				} catch (error) {
					console.error(`DM ${dm.id} has no address yet:`, error);
				}
				return { id: dm.id, friend: dm.friend, address };
			}),
		),
	);
});

// Tokens: each a machine's, a Better Auth session named after the machine, from an OTP or minted
// on the account page, or an MCP client's, an OAuth grant named after the client.

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

api.get("/tokens", (c) => {
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
				kind: "machine",
				created: iso(s.createdAt),
			})),
			...grants.map((o) => ({
				id: `o_${Buffer.from(o.grant).toString("base64url")}`,
				name: o.name ?? "an MCP client",
				kind: "mcp",
				created: iso(o.createdAt),
			})),
		].sort((a, b) => a.created.localeCompare(b.created)),
	);
});

api.post("/tokens", async (c) => {
	if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
	const body = (await bodyOf(c.req.raw)) as { name?: unknown } | undefined;
	const name = body?.name;
	if (typeof name !== "string" || !isNamePart(name))
		return c.text(
			"Give the machine's name, in lower case, such as lwirth-server.",
			400,
		);
	const context = await auth.$context;
	const session = await context.internalAdapter.createSession(
		c.var.caller.id,
		false,
		{ agent: name },
	);
	return c.json(
		{
			id: `t_${session.id}`,
			name,
			kind: "machine",
			created: iso(session.createdAt),
			token: session.token,
		},
		201,
	);
});

/** Revokes `me`'s token `id`, as `/tokens` lists it; whether there was one. */
function revokeToken(me: string, id: string): boolean {
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
		return tokens.changes > 0 || refresh.changes > 0;
	}
	return false;
}

// The token the request carries.
api.delete("/tokens/self", (c) => {
	const { id, token } = c.var.caller;
	if (!token) return c.text("The request carries no token.", 404);
	return revokeToken(id, token)
		? c.body(null, 204)
		: c.text("No such token.", 404);
});

api.delete("/tokens/:id", (c) =>
	revokeToken(c.var.caller.id, c.req.param("id"))
		? c.body(null, 204)
		: c.text("No such token.", 404),
);

// Apps: each acts as its person, by a grant the person approved with an OTP, a Better Auth
// session marked as the person's. An app's grant is no token: tokens only connect agents.
// An app owns the sessions it creates, and revoking it ends them, by the grant's cascade.

type AppGrant = {
	id: string;
	agent: string;
	claim: string | null;
	createdAt: string | number;
};

api.get("/apps", (c) => {
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
	);
});

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

// The grant the request carries, as an app unlinks itself from its side.
api.delete("/apps/self", (c) => {
	const { id, token } = c.var.caller;
	return token && revokeApp(id, token)
		? c.body(null, 204)
		: c.text("The request carries no app's grant.", 404);
});

// An app is the person's: only they revoke it, signed in, and the app itself by `/apps/self`.
api.delete("/apps/:id", (c) => {
	if (!isPerson(c.req.raw)) return c.text(onlyThePerson, 403);
	return revokeApp(c.var.caller.id, c.req.param("id"))
		? c.body(null, 204)
		: c.text("No such app.", 404);
});
