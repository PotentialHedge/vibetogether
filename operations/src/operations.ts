/**
 * The operations of an OpenAPI document as they are called: each with its arguments in one
 * schema, and where each argument goes in the request. Nothing here knows any operation, and
 * nothing here depends on how a client offers them, so the MCP server and the command line
 * both stand on it.
 */

export type Schema = Record<string, unknown> & {
	type?: string | string[];
	properties?: Record<string, Schema>;
	required?: string[];
	description?: string;
	$ref?: string;
};

export type Parameter = {
	in: "path" | "query" | "header" | "cookie";
	name: string;
	required?: boolean;
	description?: string;
	schema: Schema;
};

export type Operation = {
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

/** An operation as it is called: its arguments, by where each goes in the request. */
export type Call = {
	/** The operation's id. */
	name: string;
	description: string;
	/** Every argument, as one object's schema. */
	inputSchema: Schema;
	method: string;
	path: string;
	/** The path and query parameters. */
	params: Parameter[];
	/** The body's fields, where it is JSON. */
	json: string[];
	/** Whether the body is the payload itself, which the call takes as `content`. */
	raw: boolean;
	/** The operation as the document has it. */
	operation: Operation;
};

/** `schema` with its references followed, since a call's schema stands on its own. */
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

/** Every operation of `document` as it is called, in the document's order. */
export function callsOf(document: Document): Call[] {
	const calls: Call[] = [];
	for (const [path, item] of Object.entries(document.paths))
		for (const [method, operation] of Object.entries(item)) {
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
			calls.push({
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
				operation,
			});
		}
	return calls;
}

/** The URL `call` requests at `base` with `args`: its path and query parameters filled in. */
export function urlOf(
	call: Call,
	args: Record<string, unknown>,
	base: string,
): string {
	let path = call.path;
	const query = new URLSearchParams();
	for (const p of call.params) {
		const value = args[p.name];
		if (value === undefined || value === null) continue;
		if (p.in === "path") {
			const part = String(value);
			// A path's `.` and `..` would reach another route.
			if (part === "." || part === "..")
				throw new Error(`${p.name} cannot be "${part}".`);
			path = path.replace(`{${p.name}}`, encodeURIComponent(part));
		} else query.set(p.name, String(value));
	}
	return `${base}${path}${query.size ? `?${query}` : ""}`;
}
