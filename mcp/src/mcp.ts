/**
 * An MCP server made from an OpenAPI document: each operation a token may call is a tool of
 * its id, with its description and arguments, called as the same request with the agent's
 * token. Nothing here knows any operation, so the document is the one definition of each.
 */
import { createMcpHandler, Server } from "@modelcontextprotocol/server";

type Schema = Record<string, unknown> & {
	type?: string | string[];
	properties?: Record<string, Schema>;
	required?: string[];
	description?: string;
	$ref?: string;
};

type Parameter = {
	in: "path" | "query" | "header" | "cookie";
	name: string;
	required?: boolean;
	description?: string;
	schema: Schema;
};

type Operation = {
	operationId: string;
	summary?: string;
	description?: string;
	tags?: string[];
	security?: Record<string, string[]>[];
	parameters?: Parameter[];
	requestBody?: { content: Record<string, { schema: Schema }> };
	"x-tool"?: boolean;
};

export type Document = {
	info: { title: string; description?: string };
	tags?: { name: string; description?: string }[];
	paths: Record<string, Record<string, Operation>>;
	components?: { schemas?: Record<string, Schema> };
};

/** A tool: the operation it calls, and its arguments, by where each goes in the request. */
type Tool = {
	name: string;
	description: string;
	inputSchema: Schema;
	method: string;
	path: string;
	params: Parameter[];
	/** The body's fields, where it is JSON. */
	json: string[];
	/** Whether the body is the payload itself, which the tool takes as `content`. */
	raw: boolean;
};

/** The most an image is that a tool hands over as one, rather than as how to fetch it. */
const maxImage = 5 * 1024 * 1024;

/** `schema` with its references followed, since a tool's schema stands on its own. */
function resolved(document: Document, schema: Schema, depth = 0): Schema {
	if (depth > 12) return {};
	if (schema.$ref) {
		const name = schema.$ref.split("/").pop() ?? "";
		return resolved(
			document,
			document.components?.schemas?.[name] ?? {},
			depth + 1,
		);
	}
	const out: Schema = {};
	for (const [key, value] of Object.entries(schema)) {
		if (Array.isArray(value))
			out[key] = value.map((v) =>
				v && typeof v === "object"
					? resolved(document, v as Schema, depth + 1)
					: v,
			);
		else if (value && typeof value === "object")
			out[key] =
				key === "properties"
					? Object.fromEntries(
							Object.entries(value as Record<string, Schema>).map(([k, v]) => [
								k,
								resolved(document, v, depth + 1),
							]),
						)
					: resolved(document, value as Schema, depth + 1);
		else out[key] = value;
	}
	return out;
}

/** The tools of `document`: every operation a token may call, but those marked `x-tool: false`. */
export function toolsOf(document: Document): Tool[] {
	const tools: Tool[] = [];
	for (const [path, item] of Object.entries(document.paths))
		for (const [method, operation] of Object.entries(item)) {
			if (operation["x-tool"] === false) continue;
			if (!operation.security?.some((way) => "token" in way)) continue;
			const params = (operation.parameters ?? []).filter(
				(p) => p.in === "path" || p.in === "query",
			);
			const properties: Record<string, Schema> = {};
			const required: string[] = [];
			for (const p of params) {
				properties[p.name] = {
					...resolved(document, p.schema),
					...(p.description && { description: p.description }),
				};
				if (p.required || p.in === "path") required.push(p.name);
			}
			const content = operation.requestBody?.content ?? {};
			const jsonBody = content["application/json"]?.schema;
			const raw = !jsonBody && Object.keys(content).length > 0;
			const json: string[] = [];
			if (jsonBody) {
				const body = resolved(document, jsonBody);
				for (const [name, field] of Object.entries(body.properties ?? {})) {
					properties[name] = field;
					json.push(name);
				}
				required.push(...(body.required ?? []));
			}
			if (raw) {
				properties.content = {
					type: "string",
					description:
						"The payload: text as it is, or anything else in base64 with `base64` set.",
				};
				properties.type = {
					type: "string",
					description:
						"The payload's MIME type, with its parameters, `text/plain; charset=utf-8` where left out.",
				};
				properties.base64 = {
					type: "boolean",
					description: "Whether `content` is base64.",
				};
				required.push("content");
			}
			tools.push({
				name: operation.operationId,
				description: [operation.summary, operation.description]
					.filter(Boolean)
					.join(": "),
				inputSchema: {
					type: "object",
					properties,
					...(required.length && { required }),
				},
				method: method.toUpperCase(),
				path,
				params,
				json,
				raw,
			});
		}
	return tools;
}

/** The instructions: what the document says of itself and of each concept. */
export function instructionsOf(document: Document): string {
	return [
		document.info.description,
		...(document.tags ?? []).map(
			(tag) => `${tag.name}: ${tag.description ?? ""}`,
		),
		"Each tool is one request of the API, with your token. A receive waits until someone pings you, in its session or in any other you see, and returns what named you elsewhere with its `session`: keep a `receive` waiting always, in the session you work in or in your group's general, so that you are woken and others see you online; `overview` lists the online agents you can ping.",
	]
		.filter(Boolean)
		.join("\n\n");
}

type Content =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

/** The answer as the agent gets it: JSON or text as text, an image as an image. */
async function contentOf(response: Response, url: string): Promise<Content[]> {
	const type = response.headers.get("content-type") ?? "";
	const essence = type.split(";")[0]?.trim().toLowerCase() ?? "";
	if (response.status === 204) return [{ type: "text", text: "Done." }];
	if (essence.startsWith("image/") && essence !== "image/svg+xml") {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length <= maxImage)
			return [
				{
					type: "image",
					data: Buffer.from(bytes).toString("base64"),
					mimeType: essence,
				},
			];
		return [
			{
				type: "text",
				text: `An image of ${bytes.length} bytes, too large to hand over: fetch it with curl -s -H 'Authorization: Bearer <token>' -o <file> '${url}'.`,
			},
		];
	}
	const textual =
		essence.startsWith("text/") ||
		essence === "application/json" ||
		essence.endsWith("+json");
	if (textual) return [{ type: "text", text: await response.text() }];
	const size = (await response.arrayBuffer()).byteLength;
	return [
		{
			type: "text",
			text: `A payload of type ${type}, ${size} bytes: fetch it with curl -s -H 'Authorization: Bearer <token>' -o <file> '${url}'.`,
		},
	];
}

/** Calls the tool's operation with `args` and the agent's `token`, through `fetch`. */
async function call(
	tool: Tool,
	args: Record<string, unknown>,
	token: string,
	base: string,
	fetch: (request: Request) => Promise<Response>,
	signal: AbortSignal,
): Promise<{ content: Content[]; isError?: boolean }> {
	let path = tool.path;
	const query = new URLSearchParams();
	for (const p of tool.params) {
		const value = args[p.name];
		if (value === undefined || value === null) continue;
		if (p.in === "path")
			path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
		else query.set(p.name, String(value));
	}
	const url = `${base}${path}${query.size ? `?${query}` : ""}`;
	const headers = new Headers({ authorization: `Bearer ${token}` });
	let body: string | Uint8Array<ArrayBuffer> | undefined;
	if (tool.json.length) {
		const fields = Object.fromEntries(
			tool.json
				.filter((name) => args[name] !== undefined)
				.map((name) => [name, args[name]]),
		);
		body = JSON.stringify(fields);
		headers.set("content-type", "application/json");
	}
	if (tool.raw) {
		const content = String(args.content ?? "");
		body = args.base64
			? new Uint8Array(Buffer.from(content, "base64"))
			: content;
		headers.set(
			"content-type",
			String(args.type ?? "text/plain; charset=utf-8"),
		);
	}
	const response = await fetch(
		new Request(url, {
			method: tool.method,
			headers,
			signal,
			...(body !== undefined && { body }),
		}),
	);
	const content = await contentOf(response, url);
	return response.ok ? { content } : { content, isError: true };
}

/**
 * The MCP server's HTTP handler at `resource`, from the document `documentOf` gives, whose
 * operations it calls at `base` through `fetch`. A request without a token, or with one that
 * `/me` refuses, gets MCP's 401 challenge, naming the server's metadata.
 */
export function mcpHandler(options: {
	resource: string;
	base: string;
	document: () => Promise<Document>;
	fetch: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response> {
	const metadata = `${new URL(options.resource).origin}/.well-known/oauth-protected-resource${new URL(options.resource).pathname}`;
	const challenge = () =>
		new Response("Sign in: send a token as Authorization: Bearer <token>.", {
			status: 401,
			headers: { "www-authenticate": `Bearer resource_metadata="${metadata}"` },
		});
	const handler = createMcpHandler(async (context) => {
		const document = await options.document();
		const tools = toolsOf(document);
		const server = new Server(
			{ name: "vibetogether", version: "3" },
			{ capabilities: { tools: {} }, instructions: instructionsOf(document) },
		);
		const token = String(context.authInfo?.token ?? "");
		server.setRequestHandler("tools/list", () => ({
			tools: tools.map(({ name, description, inputSchema }) => ({
				name,
				description,
				inputSchema: inputSchema as { type: "object" },
			})),
		}));
		server.setRequestHandler("tools/call", async (request, ctx) => {
			const tool = tools.find((t) => t.name === request.params.name);
			if (!tool)
				return {
					content: [
						{ type: "text", text: `No such tool: ${request.params.name}.` },
					],
					isError: true,
				};
			// A long receive tells the client now and then that it still waits.
			const progressToken = request.params._meta?.progressToken;
			let progress = 0;
			const ticking =
				progressToken !== undefined
					? setInterval(() => {
							progress += 1;
							ctx.mcpReq
								.notify({
									method: "notifications/progress",
									params: { progressToken, progress, message: "Waiting." },
								})
								.catch(() => {});
						}, 30_000)
					: undefined;
			try {
				return await call(
					tool,
					request.params.arguments ?? {},
					token,
					options.base,
					options.fetch,
					ctx.mcpReq.signal,
				);
			} finally {
				clearInterval(ticking);
			}
		});
		return server;
	});
	return async (request) => {
		const token = request.headers
			.get("authorization")
			?.match(/^bearer\s+(.+)$/i)?.[1]
			?.trim();
		if (!token) return challenge();
		const me = await options.fetch(
			new Request(`${options.base}/me`, {
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		if (me.status === 401) return challenge();
		return handler.fetch(request, {
			authInfo: { token, clientId: "", scopes: [] },
		});
	};
}
