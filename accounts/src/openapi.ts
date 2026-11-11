/**
 * The service's interface, defined once: every operation is a route declared here, with its
 * arguments, answers and description for agents, and the service checks each request against it.
 * The OpenAPI document made from these routes is the only definition of an operation:
 * the MCP server makes its account tools from it, and the reference agents read with curl is
 * rendered from it.
 */
import {
	createRoute,
	OpenAPIHono,
	type RouteConfig,
	z,
} from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { recorded } from "./activity.ts";
import { type Caller, callerOf } from "./caller.ts";
import { config } from "./config.ts";
import { ownGroupOf } from "./db.ts";

export { z };

export type Env = { Variables: { caller: Caller; bridgeOnly?: boolean } };

/**
 * Who may call an operation:
 * - `anyone`, without signing in;
 * - `account`, the account, by a token or the person signed in in the browser;
 * - `browser`, the person alone, signed in in the browser, by the cookie: a token gets 403;
 * - `bridge`, a bridge, by its credential, which reaches nothing else.
 * It sets both the operation's security in the document and the check, so the two can't differ.
 */
export type Who = "anyone" | "account" | "browser" | "bridge";

const origin = new URL(config.url).origin;

/**
 * The account a request is from, or 401. A change by the person, signed in in the browser, comes
 * from the account page alone: the session cookie is sent from every site that counts as the same
 * site, other subdomains included.
 */
const signedIn: MiddlewareHandler<Env> = async (c, next) => {
	const bridge = c.get("bridgeOnly") === true;
	const changes = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
	if (
		changes &&
		!c.req.header("authorization") &&
		c.req.header("origin") !== origin
	)
		return c.text("A change by the person comes from the account page.", 403);
	const caller = await callerOf(c.req.raw.headers);
	if (!caller)
		return c.text(
			"Sign in, or send a token as Authorization: Bearer <token>.",
			401,
		);
	// A bridge's credential is for its own session, which it reaches through the relay, and for
	// the operations on itself alone.
	if (Boolean(caller.bridge) !== bridge)
		return bridge
			? c.text("The request carries no bridge's credential.", 404)
			: c.text(
					"A bridge reaches only its own session, through the relay.",
					403,
				);
	c.set("caller", caller);
	// Everyone has a group of their own, from their first request on.
	ownGroupOf(caller.id);
	await next();
};

/** The person alone, signed in in the browser: a sign-in's own token sent as a bearer is no browser. */
const inTheBrowser: MiddlewareHandler<Env> = async (c, next) => {
	if (c.req.header("authorization"))
		return c.text(
			"Only the person does this, signed in in the browser, never with a token.",
			403,
		);
	await next();
};

const securityOf: Record<Who, RouteConfig["security"]> = {
	anyone: [],
	account: [{ token: [] }, { browser: [] }],
	browser: [{ browser: [] }],
	bridge: [{ bridge: [] }],
};

/** Marks an operation as a bridge's own, for `signedIn`. */
const forBridges: MiddlewareHandler<Env> = async (c, next) => {
	c.set("bridgeOnly", true);
	await next();
};

const middlewareOf: Record<Who, MiddlewareHandler<Env>[]> = {
	anyone: [],
	account: [signedIn],
	browser: [signedIn, inTheBrowser],
	bridge: [forBridges, signedIn],
};

/** What every refusal is: one sentence, for whoever reads it, agent or person. */
const refusal = {
	content: { "text/plain": { schema: z.string() } },
	description: "Refused, with one sentence that says why.",
};

type Operation = Omit<
	RouteConfig,
	"security" | "middleware" | "operationId" | "tags"
> & {
	/** Its name, in snake case, which the MCP server names its tool after, such as `list_groups`. */
	id: string;
	/** The concept it acts on, one of `tags`. */
	tag: keyof typeof tags;
	who: Who;
};

/**
 * An operation: a route with its security and checks from `who`, every refusal as text, and
 * what an agent changes with it recorded.
 */
export function operation<const O extends Operation>({
	id,
	tag,
	who,
	responses,
	...route
}: O) {
	// Typed as the operation declares it, so that a handler's `c.req.valid` knows its request:
	// an `Omit` of the generic loses it.
	return createRoute({
		...route,
		operationId: id,
		tags: [tag],
		security: securityOf[who],
		middleware: who === "anyone" ? [] : [...middlewareOf[who], recorded(id)],
		responses: { ...responses, default: refusal },
	} as RouteConfig) as unknown as O & {
		responses: { default: typeof refusal };
		getRoutingPath(): string;
	};
}

/**
 * The concepts, each a tag of the operations on it: the reference opens each section with its
 * description, and the MCP server's instructions hold them, so both say the same.
 */
export const tags = {
	Invites:
		"An invite is a short link from a person, or their agent, to be friends, or to join one of their projects. It works once, for 7 days, and its maker revokes it. The invited person opens it, signs in with GitHub, accepts, and gets a prompt with an OTP for their own agent, which trades it for its machine's token.",
	Account:
		"A person's name is their GitHub login in lower case, such as `luiswirth`. It is their name in agentwire, and their agents take part as `<name>/<agent>`, such as `luiswirth/claude`: a token never joins as the person.",
	Groups:
		"A group is people, such as Potential Hedge. Everyone has a group of their own, named after them, which holds them alone. A group's members are equal: any member adds a friend of theirs, removes anyone, and leaves on their own. What a group has is its members' alike: its projects and their sessions. A group shows only to its members: to anyone else, it and everything in it is not found.",
	Projects:
		"A project is a group's named set of sessions, which may point at GitHub repositories, where its work lives. A project stays in its group.",
	Sessions:
		"Every session is an agentwire session, and one of a project's. It lasts, with a name, and only the members of its group, their agents and the bridges they added join it. Its address is hard to guess and identifies it: join it at its address as the transport says, with the token as `Authorization: Bearer <token>`, under one of the person's agents' names, `<name>/<agent>`.",
	Friends:
		"Friends are mutual: two people are friends once each has added the other. Only a friend of a member joins a group through them, and every two friends have a DM.",
	DMs: "Two friends have a DM: one session with the two people and their agents alone, in no group or project. Nobody renames or deletes one.",
	Tokens:
		"A token connects agents to the account, and acts for the whole account, as the person does, except that only the person deletes the account. A machine's token is used by every agent on the machine; an MCP client's is that client's. A token lasts until it is revoked; a machine's also ends after 90 days unused.",
	"Getting a token":
		"An agent with a shell gets its machine's token with an OTP, RFC 8628's device authorization: it asks for an OTP, gives its person the link in `verification_uri_complete`, where they sign in and approve it, and meanwhile asks for the token every `interval` seconds. `<machine>` is the machine's hostname in lower case, such as `lwirth-server`: the token is the machine's, kept in a file there for every agent on it. An MCP client gets its token on its own, by OAuth.",
	Bridges:
		"A bridge mirrors a room outside Vibe Together and a session onto each other, such as messagent, which bridges a Telegram chat: what is said in either reaches the other. A member adds one to a session by approving its OTP, signed in, and picking the session. It joins as `<name>/<bridge>`, such as `luiswirth/messagent`, and reaches only that session, while that member is in its group; any member removes it. A person who linked their identity on the bridge's messenger, by an OTP from a chat of theirs alone, speaks through it as themselves; everyone else's messages come from the bridge, marked unverified.",
} as const;

/** A request's body that isn't what the operation takes: one sentence for each thing wrong. */
export function newApi() {
	return new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (result.success) return;
			const wrong = result.error.issues.map((issue) =>
				issue.path.length
					? `${issue.path.join(".")}: ${issue.message}`
					: issue.message,
			);
			return c.text(`${wrong.join("; ")}.`, 400);
		},
	});
}

/** The document, as the service serves it at `/api/openapi.json`. */
export function documentOf(api: OpenAPIHono<Env>) {
	api.openAPIRegistry.registerComponent("securitySchemes", "token", {
		type: "http",
		scheme: "bearer",
		description: "A token, as `Authorization: Bearer <token>`.",
	});
	api.openAPIRegistry.registerComponent("securitySchemes", "bridge", {
		type: "http",
		scheme: "bearer",
		description:
			"A bridge's credential, which a person approved for one session, as `Authorization: Bearer <credential>`.",
	});
	api.openAPIRegistry.registerComponent("securitySchemes", "browser", {
		type: "apiKey",
		in: "cookie",
		name: "__Host-vibetogether.session_token",
		description: "The person, signed in in the browser.",
	});
	registerDeviceFlow(api);
	return api.getOpenAPI31Document({
		openapi: "3.1.0",
		info: {
			title: "Vibe Together accounts",
			version: "1",
			description:
				"The account service of Vibe Together: people sign in with GitHub, and their account holds their groups with their projects and sessions, their friends and their tokens. A person through the website and an agent through `curl` use the same requests.",
		},
		servers: [{ url: `${origin}/api` }],
		tags: Object.entries(tags).map(([name, description]) => ({
			name,
			description,
		})),
	});
}

/**
 * Better Auth's device authorization, which an agent with a shell calls for its token: no
 * route of ours, so declared here alone, and no tool of the MCP server, whose client signs in
 * by OAuth (`x-tool`).
 */
function registerDeviceFlow(api: OpenAPIHono<Env>) {
	const device = { "x-tool": false, tags: ["Getting a token"], security: [] };
	const form = (schema: z.ZodType) => ({
		body: { content: { "application/json": { schema } }, required: true },
	});
	api.openAPIRegistry.registerPath({
		...device,
		method: "post",
		path: "/auth/device/code",
		operationId: "request_otp",
		summary: "Ask for an OTP",
		description: "Asks for an OTP for the machine, for the person to approve.",
		request: form(
			z.object({
				client_id: z
					.string()
					.meta({ description: "The machine's name, `<machine>`." }),
			}),
		),
		responses: {
			200: {
				description: "The OTP.",
				content: {
					"application/json": {
						schema: z.object({
							user_code: z.string(),
							verification_uri_complete: z.string().meta({
								description: "The link the person approves the OTP at.",
							}),
							device_code: z.string(),
							interval: z.number().meta({
								description: "Seconds between two asks for the token.",
							}),
						}),
					},
				},
			},
		},
	});
	api.openAPIRegistry.registerPath({
		...device,
		method: "post",
		path: "/auth/device/token",
		operationId: "redeem_otp",
		summary: "Get the token of an approved OTP",
		description:
			'Gives the machine\'s token once the person approved the OTP, as `access_token`; until then it answers 400 with `{"error":"authorization_pending"}`. Keep the token on the machine, readable by its user only, such as in `~/.config/vibetogether/token`: it acts for the person\'s account.',
		request: form(
			z.object({
				grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
				device_code: z.string(),
				client_id: z
					.string()
					.meta({ description: "The machine's name, `<machine>`." }),
			}),
		),
		responses: {
			200: {
				description: "The token.",
				content: {
					"application/json": {
						schema: z.object({ access_token: z.string() }),
					},
				},
			},
		},
	});
}
