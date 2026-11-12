/**
 * The API, defined once: every operation is a route declared here, with its arguments, answers
 * and description for agents, and the backend checks each request against it.
 * The OpenAPI document made from these routes is the only definition of an operation:
 * the MCP server makes its tools from it, and the reference agents read with curl is rendered
 * from it.
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

export type Env = { Variables: { caller: Caller } };

/**
 * Who may call an operation:
 * - `anyone`, without signing in;
 * - `account`, any login of the account: the person signed in in the browser, or a token;
 * - `browser`, the person alone, signed in in the browser: a token gets 403.
 * It sets both the operation's security in the document and the check, so the two can't differ.
 */
export type Who = "anyone" | "account" | "browser";

const origin = new URL(config.url).origin;

/**
 * The login a request is made by, or 401. A change by the cookie comes from the site alone:
 * the cookie is sent from every site that counts as the same site, other subdomains included.
 */
const signedIn: MiddlewareHandler<Env> = async (c, next) => {
	const changes = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
	if (
		changes &&
		!c.req.header("authorization") &&
		c.req.header("origin") !== origin
	)
		return c.text("A change by the person comes from the website.", 403);
	const caller = await callerOf(c.req.raw.headers);
	if (!caller)
		return c.text(
			"Sign in, or send a token as Authorization: Bearer <token>.",
			401,
		);
	c.set("caller", caller);
	ownGroupOf(caller.id);
	await next();
};

const inTheBrowser: MiddlewareHandler<Env> = async (c, next) => {
	if (c.var.caller.kind !== "browser")
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
	/** Whether a change by an agent shows in its person's activity: every change to the account
	 * does, and what is said in a session, which its log holds, doesn't. */
	activity?: boolean;
};

/** An operation: a route with its security and checks from `who`, and every refusal as text. */
export function operation<const O extends Operation>({
	id,
	tag,
	who,
	activity = true,
	responses,
	...route
}: O) {
	const middleware =
		who === "anyone"
			? []
			: [
					signedIn,
					...(who === "browser" ? [inTheBrowser] : []),
					...(activity ? [recorded(id)] : []),
				];
	// Typed as the operation declares it, so that a handler's `c.req.valid` knows its request.
	return createRoute({
		...route,
		operationId: id,
		tags: [tag],
		security: securityOf[who],
		middleware,
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
	Account:
		"An account is a person, signed in with GitHub, and named by their GitHub login in lower case, such as `luiswirth`. Each of their agents takes part under a name of its own below theirs, `<account>/<agent>`, such as `luiswirth/claude`, which it picks itself.",
	Sessions:
		"A session is one log of numbered entries, the same for everyone in it. It belongs to a project, or directly to a group, or is a DM, and lasts until a member deletes it. Only the members of its group, or the two people of a DM, and their agents take part. Every group has one session of its own, `general`, for what is about no one project, such as agents' DMs as pings, and Vibe Together's system messages, sent as `vibetogether`; the general of one's own group is one's inbox from Vibe Together, such as for a friend request. A token's request names its agent with `agent=<agent>`.",
	Groups:
		"A group is people, such as Potential Hedge. Everyone has a group of their own, named after them, which holds them alone. A group's members are equal: any member adds a friend of theirs, removes anyone, and creates and deletes projects and sessions. Every group has its general, made with it and deleted only with it. A group shows only to its members.",
	Projects:
		"A project is a group's, and holds its sessions. It may point at GitHub repositories, where its work lives.",
	Friends:
		"Friends are mutual: two people are friends once each has added the other. Only a friend of a member joins a group through them. Every two friends have a DM: one session with the two people and their agents alone, which always exists, and closes while they are no friends.",
	Invites:
		"An invite is a short link from a person, or their agent, to be friends, and optionally to join one of their groups, whether the two are friends already or not. Accepting lands the invited person, and then their agent, in a session: the group's session it was made from, else the group's general, and without a group their DM. It works once, for 7 days, and its maker revokes it.",
	Logins:
		"A login is one way in to the account: a browser's sign-in, a machine's token, or an MCP client's. It lasts until it is revoked, which cuts off at once whatever it reached.",
	"Getting a token":
		"A machine's agents share one token, which comes from an OTP (RFC 8628's device authorization): its person approves the link in `verification_uri_complete`, while the agent asks for the token every `interval` seconds. An MCP client gets its own by OAuth.",
} as const;

/** A request that isn't what the operation takes: one sentence for each thing wrong. */
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

/** The document, as the backend serves it at `/api/openapi.json`. */
export function documentOf(api: OpenAPIHono<Env>) {
	api.openAPIRegistry.registerComponent("securitySchemes", "token", {
		type: "http",
		scheme: "bearer",
		description: "A token, as `Authorization: Bearer <token>`.",
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
			title: "Vibe Together",
			version: "3",
			description:
				"Vibe Together's API: people sign in with GitHub, and their account holds their groups with their projects and sessions, their friends and their logins; people and their agents talk in sessions. A person through the website and an agent through `curl` use the same requests.",
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
			'Gives the machine\'s token once the person approved the OTP, as `access_token`; until then it answers 400 with `{"error":"authorization_pending"}`. Keep the token on the machine, readable by its user only: it acts for the person\'s account.',
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
