#!/usr/bin/env node
/**
 * Vibe Together's command line: each operation of the server's OpenAPI document is a command of
 * its id, with its arguments as flags, made from the document as it runs, so it never lags the
 * server. Nothing here knows any operation: the mapping from the document is `vibetogether-operations`,
 * shared with the MCP server, and every operation is a command, since `x-tool` is for MCP alone.
 */
import { readFileSync } from "node:fs";
import { Agent, setGlobalDispatcher } from "undici";
import {
	type Call,
	callsOf,
	type Document,
	type Schema,
	urlOf,
} from "vibetogether-operations";

/** What a run reads from and writes to, so that tests give their own. */
export type Io = {
	env: Record<string, string | undefined>;
	fetch: (request: Request) => Promise<Response>;
	stdin: () => Promise<Uint8Array>;
	stdout: (data: Uint8Array | string) => void;
	stderr: (text: string) => void;
	sleep: (ms: number) => Promise<void>;
};

/** The exit codes, one per kind of failure. */
const code = { usage: 2, refused: 3, network: 4 } as const;

class Exit extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

const usage = (message: string) => new Exit(code.usage, message);

/** `create_project` as `create-project`, `client_id` as `client-id`. */
const kebab = (name: string) =>
	name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/_/g, "-")
		.toLowerCase();

/** A command: the operation's call, with what the listing shows of it. */
type Command = { name: string; tag: string; summary: string; tool: Call };

/** Every operation of `document` as a command, `x-tool: false` and every security included. */
export function commandsOf(document: Document): Command[] {
	return callsOf(document).map((tool) => ({
		name: kebab(tool.name),
		tag: tool.operation.tags?.[0] ?? "",
		summary: tool.operation.summary ?? "",
		tool,
	}));
}

/** A command's arguments as flags: each path and query parameter and JSON field. */
type Argument = { name: string; flag: string; schema: Schema };

function argumentsOf(tool: Call): Argument[] {
	const own = new Set([...tool.params.map((p) => p.name), ...tool.json]);
	return Object.entries(tool.inputSchema.properties ?? {})
		.filter(([name]) => own.has(name))
		.map(([name, schema]) => ({ name, flag: kebab(name), schema }));
}

/** The schema's type, `null` aside, such as `integer` for `["integer", "null"]`. */
function typeOf(schema: Schema): string {
	const type = [schema.type].flat().find((t) => t && t !== "null");
	return type ?? "string";
}

/** `value`, given on the command line, as `schema` takes it. */
function parsed(flag: string, schema: Schema, value: string): unknown {
	switch (typeOf(schema)) {
		case "integer":
		case "number": {
			const n = Number(value);
			if (value.trim() === "" || Number.isNaN(n))
				throw usage(`--${flag} takes a number, not ${value}.`);
			return n;
		}
		case "object":
			try {
				return JSON.parse(value);
			} catch {
				throw usage(`--${flag} takes JSON.`);
			}
		default:
			return value;
	}
}

/** What a flag stands for in the help, such as `<string>` or `ping|entry|change`. */
function shapeOf(schema: Schema): string {
	const values = schema.enum as unknown[] | undefined;
	if (values) return values.join("|");
	const type = typeOf(schema);
	if (type === "array") return `${shapeOf((schema.items ?? {}) as Schema)}...`;
	return `<${type}>`;
}

/** The arguments `args` give for `command`, by name, `agent` where it takes one and none is given. */
async function argsOf(
	command: Command,
	args: string[],
	agent: string | undefined,
	io: Io,
): Promise<{ values: Record<string, unknown>; type?: string }> {
	const { tool } = command;
	const byFlag = new Map(argumentsOf(tool).map((a) => [a.flag, a]));
	const values: Record<string, unknown> = {};
	let json: string | undefined;
	let type: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		const match = arg.match(/^--([^=]+)(?:=(.*))?$/s);
		if (!match) throw usage(`Unexpected ${arg}: every argument is a flag.`);
		const flag = match[1] ?? "";
		const next = () => {
			if (match[2] !== undefined) return match[2];
			const value = args[++i];
			if (value === undefined) throw usage(`--${flag} takes a value.`);
			return value;
		};
		const argument = byFlag.get(flag);
		if (flag === "json" && tool.json.length) json = next();
		else if (flag === "type" && tool.raw) type = next();
		else if (argument) {
			const kind = typeOf(argument.schema);
			if (kind === "boolean")
				values[argument.name] =
					match[2] === undefined ? true : match[2] !== "false";
			else if (kind === "array")
				values[argument.name] = [
					...((values[argument.name] as unknown[]) ?? []),
					parsed(flag, (argument.schema.items ?? {}) as Schema, next()),
				];
			else values[argument.name] = parsed(flag, argument.schema, next());
		} else if (flag === "server" || flag === "agent") next();
		else
			throw usage(
				`${command.name} takes no --${flag}: see vibetogether ${command.name} --help.`,
			);
	}
	if (json !== undefined) {
		const text =
			json === "-" ? new TextDecoder().decode(await io.stdin()) : json;
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw usage("--json takes a JSON object.");
		}
		if (!body || typeof body !== "object" || Array.isArray(body))
			throw usage("--json takes a JSON object.");
		for (const [name, value] of Object.entries(body))
			if (!(name in values)) values[name] = value;
	}
	const properties = tool.inputSchema.properties ?? {};
	if ("agent" in properties && values.agent === undefined && agent)
		values.agent = agent;
	for (const name of tool.inputSchema.required ?? []) {
		if (values[name] !== undefined || name === "content") continue;
		const only = properties[name]?.enum as unknown[] | undefined;
		if (only?.length === 1) values[name] = only[0];
		else throw usage(`${command.name} needs --${kebab(name)}.`);
	}
	return { values, ...(type !== undefined && { type }) };
}

/** The request `command` makes with `values`. */
async function requestOf(
	command: Command,
	values: Record<string, unknown>,
	type: string | undefined,
	base: string,
	token: string | undefined,
	io: Io,
): Promise<() => Request> {
	const { tool } = command;
	const url = urlOf(tool, values, base);
	const headers = new Headers();
	if (token) headers.set("authorization", `Bearer ${token}`);
	let body: string | Uint8Array<ArrayBuffer> | undefined;
	if (tool.json.length) {
		body = JSON.stringify(
			Object.fromEntries(
				Object.entries(values).filter(([name]) => tool.json.includes(name)),
			),
		);
		headers.set("content-type", "application/json");
	}
	if (tool.raw) {
		body = new Uint8Array(await io.stdin());
		if (type) headers.set("content-type", type);
	}
	return () =>
		new Request(url, {
			method: tool.method,
			headers,
			...(body !== undefined && { body }),
		});
}

/** The help: every command by its concept, with its summary. */
function helpOf(document: Document, commands: Command[]): string {
	const width = Math.max(...commands.map((c) => c.name.length)) + 2;
	const tags = [
		...(document.tags ?? []),
		...[...new Set(commands.map((c) => c.tag))]
			.filter((name) => !document.tags?.some((t) => t.name === name))
			.map((name) => ({ name, description: undefined })),
	];
	return [
		document.info.description ?? document.info.title,
		"Usage: vibetogether [--server <url>] [--agent <agent>] <command> [--<argument> <value>...]\n       vibetogether <command> --help",
		...tags.map((tag) =>
			[
				tag.description ? `${tag.name}: ${tag.description}` : tag.name,
				...commands
					.filter((c) => c.tag === tag.name)
					.map((c) => `  ${c.name.padEnd(width)}${c.summary}`),
			].join("\n"),
		),
		[
			"The server is --server, else VIBETOGETHER_URL, else https://vibetogether.potentialhedge.com.",
			"The token is VIBETOGETHER_TOKEN, else the file ~/.config/vibetogether/token.",
			"The agent is --agent, else VIBETOGETHER_AGENT, for each command that takes one.",
			"The answer goes to stdout as the server sends it; a refusal's reason to stderr, with exit code 3 (2: usage, 4: network).",
			"A command that waits retries network failures by itself.",
		].join("\n"),
	].join("\n\n");
}

/** A command's help: how to call it, what it does, and its arguments. */
function commandHelpOf(command: Command): string {
	const { tool } = command;
	// A field with one value alone defaults to it.
	const required = new Set(
		(tool.inputSchema.required ?? []).filter(
			(name) =>
				(tool.inputSchema.properties?.[name]?.enum as unknown[] | undefined)
					?.length !== 1,
		),
	);
	const all = argumentsOf(tool);
	const call = [
		`vibetogether ${command.name}`,
		...all.map((a) => {
			const flag =
				typeOf(a.schema) === "boolean"
					? `--${a.flag}`
					: `--${a.flag} ${shapeOf(a.schema)}`;
			return required.has(a.name) ? flag : `[${flag}]`;
		}),
		...(tool.json.length ? ["[--json -]"] : []),
		...(tool.raw ? ["[--type <mime>] < payload"] : []),
	].join(" ");
	const lines = all.map((a) => {
		const description = a.schema.description ?? "";
		const marks = [
			required.has(a.name) && "required",
			typeOf(a.schema) === "array" && "repeatable",
		].filter(Boolean);
		return `  --${a.flag}${marks.length ? ` (${marks.join(", ")})` : ""}: ${description}`;
	});
	if (tool.json.length)
		lines.push(
			"  --json: the whole body as a JSON object, `-` for stdin; flags override its fields.",
		);
	if (tool.raw)
		lines.push(
			`  --type: the payload's MIME type, with its parameters; the payload itself is read from stdin.`,
		);
	return [
		call,
		tool.description,
		...(lines.length ? [`Arguments:\n${lines.join("\n")}`] : []),
	].join("\n\n");
}

/** The token: `VIBETOGETHER_TOKEN`, else the file. */
function tokenOf(env: Io["env"]): string | undefined {
	if (env.VIBETOGETHER_TOKEN) return env.VIBETOGETHER_TOKEN.trim();
	const config = env.XDG_CONFIG_HOME || `${env.HOME ?? ""}/.config`;
	try {
		return readFileSync(`${config}/vibetogether/token`, "utf8").trim();
	} catch {
		return undefined;
	}
}

/** Why `fetch` failed, from its cause, such as `ECONNREFUSED`. */
function reasonOf(error: unknown): string {
	const cause = (error as { cause?: { code?: string; message?: string } })
		?.cause;
	return cause?.code ?? cause?.message ?? String(error);
}

/**
 * Runs the command line with `args`, and returns its exit code. A command that waits, one with a
 * `wait` parameter not set to 0, makes its request again after a network failure, or while the
 * server is restarting, so that it stays waiting until it returns.
 */
export async function run(args: string[], io: Io): Promise<number> {
	try {
		return await runOrExit(args, io);
	} catch (error) {
		if (!(error instanceof Exit)) throw error;
		io.stderr(`${error.message}\n`);
		return error.code;
	}
}

async function runOrExit(args: string[], io: Io): Promise<number> {
	// Flags of the command line itself, which come first, or anywhere for `--server`.
	let server =
		io.env.VIBETOGETHER_URL || "https://vibetogether.potentialhedge.com";
	let agent = io.env.VIBETOGETHER_AGENT;
	let help = false;
	let i = 0;
	for (; i < args.length; i++) {
		const arg = args[i] ?? "";
		const match = arg.match(/^--(server|agent)(?:=(.*))?$/s);
		if (match) {
			const value = match[2] ?? args[++i];
			if (value === undefined) throw usage(`--${match[1]} takes a value.`);
			if (match[1] === "server") server = value;
			else agent = value;
		} else if (arg === "--help" || arg === "-h") help = true;
		else break;
	}
	const [name, ...rest] = args.slice(i);
	// The document is fetched before the command's own flags are parsed.
	for (let j = 0; j < rest.length; j++) {
		const match = rest[j]?.match(/^--server(?:=(.*))?$/s);
		const value = match?.[1] ?? (match ? rest[j + 1] : undefined);
		if (value !== undefined) server = value;
	}
	if (rest.includes("--help") || rest.includes("-h")) help = true;
	const base = `${server.replace(/\/+$/, "")}/api`;

	let document: Document;
	try {
		const response = await io.fetch(new Request(`${base}/openapi.json`));
		if (!response.ok)
			throw new Exit(
				code.refused,
				`${server} has no API document: ${response.status} ${await response.text()}`.trim(),
			);
		document = (await response.json()) as Document;
	} catch (error) {
		if (error instanceof Exit) throw error;
		throw new Exit(
			code.network,
			`${server} is unreachable: ${reasonOf(error)}.`,
		);
	}
	const commands = commandsOf(document);
	if (!name || name.startsWith("-")) {
		if (name) throw usage(`Unexpected ${name}: see vibetogether --help.`);
		io.stdout(`${helpOf(document, commands)}\n`);
		return 0;
	}
	const command = commands.find((c) => c.name === name);
	if (!command) throw usage(`No command ${name}: see vibetogether --help.`);
	if (help) {
		io.stdout(`${commandHelpOf(command)}\n`);
		return 0;
	}
	const { values, type } = await argsOf(
		command,
		rest.filter((arg) => arg !== "--help" && arg !== "-h"),
		agent,
		io,
	);
	const request = await requestOf(
		command,
		values,
		type,
		base,
		tokenOf(io.env),
		io,
	);
	const waits =
		command.tool.method === "GET" &&
		command.tool.params.some((p) => p.name === "wait" && p.in === "query") &&
		values.wait !== 0;

	for (let failures = 0; ; failures++) {
		const delay = Math.min(1000 * 2 ** failures, 30_000);
		let response: Response;
		try {
			response = await io.fetch(request());
		} catch (error) {
			if (!waits)
				throw new Exit(
					code.network,
					`${server} is unreachable: ${reasonOf(error)}.`,
				);
			await io.sleep(delay);
			continue;
		}
		if (waits && [502, 503, 504].includes(response.status)) {
			const after = Number(response.headers.get("retry-after"));
			await io.sleep(after > 0 ? after * 1000 : delay);
			continue;
		}
		const body = new Uint8Array(await response.arrayBuffer());
		if (!response.ok) {
			const reason = new TextDecoder().decode(body).trim();
			throw new Exit(code.refused, reason || `Refused: ${response.status}.`);
		}
		io.stdout(body);
		return 0;
	}
}

if (import.meta.main) {
	// Node's fetch gives up on an answer after 300 s, and a wait may take longer: it is one
	// request until it returns.
	setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
	const io: Io = {
		env: process.env,
		fetch: (request) => fetch(request),
		stdin: async () => {
			const chunks: Uint8Array[] = [];
			for await (const chunk of process.stdin) chunks.push(chunk);
			return Buffer.concat(chunks);
		},
		stdout: (data) => {
			process.stdout.write(data);
			const last = typeof data === "string" ? data.at(-1) : data.at(-1);
			if (process.stdout.isTTY && last !== "\n" && last !== 10)
				process.stdout.write("\n");
		},
		stderr: (text) => process.stderr.write(text),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
	process.exitCode = await run(process.argv.slice(2), io);
}
