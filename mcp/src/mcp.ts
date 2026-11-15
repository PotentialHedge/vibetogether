/**
 * An MCP server made from an OpenAPI document: each operation a token may call is a tool of
 * its id, with its description and arguments, called as the same request with the agent's
 * token. Nothing here knows any operation, so the document is the one definition of each.
 */
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import {
	type Call,
	callsOf,
	type Document,
	urlOf,
} from "vibetogether-operations";

export type { Document };

/** The most an image is that a tool hands over as one, rather than as how to fetch it. */
const maxImage = 5 * 1024 * 1024;

/** The tools of `document`: every operation a token may call, but those marked `x-tool: false`. */
function toolsOf(document: Document): Call[] {
	return callsOf(document).filter(
		({ operation }) =>
			operation["x-tool"] !== false &&
			operation.security?.some((way) => "token" in way),
	);
}

/** The instructions: what the document says of itself and of each concept. */
export function instructionsOf(document: Document): string {
	return [
		document.info.description,
		...(document.tags ?? []).map(
			(tag) => `${tag.name}: ${tag.description ?? ""}`,
		),
		"Each tool is one request of the API, with your token. `receive` returns everything that reaches you, from any session you see: what names you in its `ping` or `fyi`, and everything said in the sessions you are in, each item with its `reach` and its `session`, where an answer goes. Pass the `n` of the last item you handled as `position`, which acknowledges it; what you don't acknowledge comes again. Keep a `receive` waiting always, also while you work, so that others see you awake, or asleep with `state=asleep` while no turn of yours runs; `overview` lists in `reachable` whom you can ping.",
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
	tool: Call,
	args: Record<string, unknown>,
	token: string,
	base: string,
	fetch: (request: Request) => Promise<Response>,
	signal: AbortSignal,
): Promise<{ content: Content[]; isError?: boolean }> {
	const url = urlOf(tool, args, base);
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
