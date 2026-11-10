/**
 * The reference agents read with curl, rendered from the document (`openapi.ts`), so it
 * says what the MCP server's tools say, word for word: each concept with its paragraph, and
 * each operation with its description, arguments, answer and a curl request.
 */

type Schema = {
	type?: string | string[];
	properties?: Record<string, Schema>;
	required?: string[];
	items?: Schema;
	enum?: unknown[];
	description?: string;
	anyOf?: Schema[];
	allOf?: Schema[];
	oneOf?: Schema[];
	additionalProperties?: Schema | boolean;
	$ref?: string;
};

type Parameter = {
	in: string;
	name: string;
	schema: Schema;
	description?: string;
};

type Operation = {
	operationId: string;
	summary?: string;
	description?: string;
	tags?: string[];
	security?: Record<string, string[]>[];
	parameters?: Parameter[];
	requestBody?: { content: Record<string, { schema: Schema }> };
	responses: Record<
		string,
		{ description: string; content?: Record<string, { schema: Schema }> }
	>;
};

type Document = {
	info: { title: string; description?: string };
	servers?: { url: string }[];
	tags?: { name: string; description?: string }[];
	paths: Record<string, Record<string, Operation>>;
	components?: { schemas?: Record<string, Schema> };
};

/** `schema` with its reference followed and its `allOf` merged into one object. */
function flat(document: Document, schema: Schema, depth = 0): Schema {
	if (depth > 8) return {};
	if (schema.$ref) {
		const name = schema.$ref.split("/").pop() ?? "";
		return flat(
			document,
			document.components?.schemas?.[name] ?? {},
			depth + 1,
		);
	}
	if (!schema.allOf) return schema;
	const parts = schema.allOf.map((part) => flat(document, part, depth + 1));
	return {
		type: "object",
		properties: Object.assign(
			{},
			...parts.map((part) => part.properties ?? {}),
		),
		required: parts.flatMap((part) => part.required ?? []),
	};
}

/** `schema` as a short JSON-like shape, such as `{"id": string, "members": [string]}`. */
function shape(document: Document, schema: Schema, depth = 0): string {
	if (depth > 8) return "…";
	schema = flat(document, schema);
	const variants = schema.anyOf ?? schema.oneOf;
	if (variants)
		return variants.map((v) => shape(document, v, depth + 1)).join(" | ");
	if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
	const types = [schema.type ?? "any"].flat();
	return types
		.map((type) => {
			if (type === "object" && schema.properties) {
				const fields = Object.entries(schema.properties).map(
					([name, field]) => `"${name}": ${shape(document, field, depth + 1)}`,
				);
				return `{${fields.join(", ")}}`;
			}
			if (type === "object") return "{…}";
			if (type === "array")
				return `[${shape(document, schema.items ?? {}, depth + 1)}]`;
			return type;
		})
		.join(" | ");
}

/** The fields of an object schema, one line each, with whether each is optional and what it is. */
function fields(document: Document, schema: Schema, where: string): string[] {
	schema = flat(document, schema);
	return Object.entries(schema.properties ?? {}).map(([name, field]) => {
		const optional = schema.required?.includes(name) ? "" : ", optional";
		const about = field.description ? `: ${field.description}` : "";
		return `- \`${name}\`${where} (${shape(document, field)}${optional})${about}`;
	});
}

function who(operation: Operation): string {
	const ways = (operation.security ?? []).flatMap((way) => Object.keys(way));
	if (ways.length === 0) return "Anyone, with no token.";
	if (!ways.includes("token"))
		return "Only the person, signed in in the browser: a token gets 403.";
	return "";
}

export function referenceOf(document: Document): string {
	const base = document.servers?.[0]?.url ?? "";
	const lines = [`# ${document.info.title}`, ""];
	if (document.info.description) lines.push(document.info.description, "");
	lines.push(
		"Every operation below is one request. Unless it says otherwise, it takes the account's token as `Authorization: Bearer <token>`, and is also a tool of the MCP server, of the same name.",
		"A refusal answers with a status of 400 or more and one sentence that says why.",
		"",
	);
	for (const tag of document.tags ?? []) {
		lines.push(`## ${tag.name}`, "");
		if (tag.description) lines.push(tag.description, "");
		for (const [path, item] of Object.entries(document.paths))
			for (const [method, operation] of Object.entries(item)) {
				if (!operation.tags?.includes(tag.name)) continue;
				lines.push(`### ${operation.summary ?? operation.operationId}`, "");
				lines.push(
					`\`${method.toUpperCase()} ${new URL(base).pathname}${path}\` (\`${operation.operationId}\`)`,
					"",
				);
				if (operation.description) lines.push(operation.description, "");
				const whom = who(operation);
				if (whom) lines.push(whom, "");
				const params = (operation.parameters ?? []).filter(
					(p) => p.in === "path",
				);
				const body = operation.requestBody?.content["application/json"]?.schema;
				if (params.length || body) {
					lines.push("Arguments:", "");
					for (const p of params)
						lines.push(
							`- \`{${p.name}}\` in the path (${shape(document, p.schema)})${p.description || p.schema.description ? `: ${p.description ?? p.schema.description}` : ""}`,
						);
					if (body) lines.push(...fields(document, body, " in the body"));
					lines.push("");
				}
				const curl = ["curl -s"];
				if (method !== "get") curl.push(`-X ${method.toUpperCase()}`);
				if (operation.security?.some((way) => "token" in way))
					curl.push("-H 'Authorization: Bearer <token>'");
				if (body) {
					const example = Object.fromEntries(
						Object.keys(body.properties ?? {})
							.filter((name) => body.required?.includes(name))
							.map((name) => {
								const field = flat(document, body.properties?.[name] ?? {});
								return [name, field.enum?.length === 1 ? field.enum[0] : "…"];
							}),
					);
					curl.push(
						`-H 'Content-Type: application/json' -d '${JSON.stringify(example)}'`,
					);
				}
				curl.push(`'${base}${path.replace(/\{(\w+)\}/g, "<$1>")}'`);
				lines.push("```sh", curl.join(" "), "```", "");
				for (const [status, answer] of Object.entries(operation.responses)) {
					if (status === "default") continue;
					const schema = answer.content?.["application/json"]?.schema;
					lines.push(
						schema
							? `It answers ${status} with \`${shape(document, schema)}\`.`
							: `It answers ${status}, with nothing.`,
						"",
					);
				}
			}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}
