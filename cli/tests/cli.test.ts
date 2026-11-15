import assert from "node:assert/strict";
import { test } from "node:test";
import { type Io, run } from "../src/cli.ts";

/** A document of the shapes the backend's has: parameters, JSON bodies, a raw payload. */
const document = {
	openapi: "3.1.0",
	info: { title: "Test", description: "A test API." },
	tags: [
		{ name: "Things", description: "Things are things." },
		{ name: "Tokens", description: "How to get one." },
	],
	paths: {
		"/things": {
			get: {
				operationId: "list_things",
				summary: "List the things",
				tags: ["Things"],
				security: [{ token: [] }, { browser: [] }],
			},
			post: {
				operationId: "create_thing",
				summary: "Create a thing",
				description: "Creates a thing.",
				tags: ["Things"],
				security: [{ token: [] }, { browser: [] }],
				requestBody: {
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/New" },
						},
					},
				},
			},
		},
		"/things/{id}/entries": {
			post: {
				operationId: "send",
				summary: "Send an entry",
				tags: ["Things"],
				security: [{ token: [] }],
				parameters: [
					{
						in: "path",
						name: "id",
						required: true,
						schema: { type: "string" },
					},
					{ in: "query", name: "agent", schema: { type: "string" } },
				],
				requestBody: { content: { "*/*": { schema: { type: "string" } } } },
			},
			get: {
				operationId: "receive",
				summary: "Receive",
				tags: ["Things"],
				security: [{ token: [] }],
				parameters: [
					{
						in: "path",
						name: "id",
						required: true,
						schema: { type: "string" },
					},
					{ in: "query", name: "agent", schema: { type: "string" } },
					{ in: "query", name: "wait", schema: { type: ["integer", "null"] } },
				],
			},
		},
		"/token": {
			post: {
				operationId: "redeem_otp",
				summary: "Get the token",
				tags: ["Tokens"],
				security: [],
				"x-tool": false,
				requestBody: {
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									grant_type: { type: "string", enum: ["device_code"] },
									device_code: { type: "string" },
								},
								required: ["grant_type", "device_code"],
							},
						},
					},
				},
			},
		},
	},
	components: {
		schemas: {
			New: {
				type: "object",
				properties: {
					name: { type: "string", description: "Its name." },
					size: { type: "integer" },
					shared: { type: "boolean" },
					tags: { type: "array", items: { type: "string" } },
				},
				required: ["name"],
			},
		},
	},
};

type Sent = { method: string; url: string; headers: Headers; body: string };

/** A run against `answer`, which answers every request but the document's. */
async function cli(
	args: string[],
	options: {
		answer?: (request: Request, n: number) => Response | Promise<Response>;
		stdin?: string;
		env?: Record<string, string>;
	} = {},
) {
	const sent: Sent[] = [];
	let stdout = "";
	let stderr = "";
	const sleeps: number[] = [];
	const io: Io = {
		env: { VIBETOGETHER_TOKEN: "t0ken", ...options.env },
		fetch: async (request) => {
			if (request.url.endsWith("/api/openapi.json"))
				return Response.json(document);
			sent.push({
				method: request.method,
				url: request.url,
				headers: request.headers,
				body: await request.text(),
			});
			return (options.answer ?? (() => Response.json({ ok: true })))(
				request,
				sent.length,
			);
		},
		stdin: async () => new TextEncoder().encode(options.stdin ?? ""),
		stdout: (data) => {
			stdout +=
				typeof data === "string" ? data : new TextDecoder().decode(data);
		},
		stderr: (text) => {
			stderr += text;
		},
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	};
	const code = await run(args, io);
	return { code, stdout, stderr, sent, sleeps };
}

test("the help lists every operation by its tag, x-tool: false included", async () => {
	const { code, stdout } = await cli(["--help"]);
	assert.equal(code, 0);
	assert.match(
		stdout,
		/Things: Things are things\.\n {2}list-things +List the things/,
	);
	assert.match(
		stdout,
		/Tokens: How to get one\.\n {2}redeem-otp +Get the token/,
	);
});

test("a command's help shows its description and arguments", async () => {
	const { code, stdout } = await cli(["create-thing", "--help"]);
	assert.equal(code, 0);
	assert.match(stdout, /--name <string> \[--size <integer>\] \[--shared\]/);
	assert.match(stdout, /Create a thing: Creates a thing\./);
	assert.match(stdout, /--name \(required\): Its name\./);
	assert.match(stdout, /--tags \(repeatable\)/);
});

test("a command is its request, with the token, and prints the answer", async () => {
	const { code, stdout, sent } = await cli(["list-things"], {
		answer: () => Response.json([{ id: "x" }]),
	});
	assert.equal(code, 0);
	assert.equal(stdout, '[{"id":"x"}]');
	assert.equal(sent[0]?.method, "GET");
	assert.equal(
		sent[0]?.url,
		"https://vibetogether.potentialhedge.com/api/things",
	);
	assert.equal(sent[0]?.headers.get("authorization"), "Bearer t0ken");
});

test("flags make the JSON body: numbers, booleans, repeated arrays", async () => {
	const { code, sent } = await cli([
		"create-thing",
		"--name",
		"a",
		"--size=3",
		"--shared",
		"--tags",
		"x",
		"--tags",
		"y",
	]);
	assert.equal(code, 0);
	assert.deepEqual(JSON.parse(sent[0]?.body ?? ""), {
		name: "a",
		size: 3,
		shared: true,
		tags: ["x", "y"],
	});
	assert.equal(sent[0]?.headers.get("content-type"), "application/json");
});

test("--json - reads the body from stdin, under the flags", async () => {
	const { sent } = await cli(["create-thing", "--json", "-", "--size", "2"], {
		stdin: '{"name":"b","size":1}',
	});
	assert.deepEqual(JSON.parse(sent[0]?.body ?? ""), { name: "b", size: 2 });
});

test("a field with one value alone defaults to it", async () => {
	const { code, sent } = await cli(["redeem-otp", "--device-code", "d"]);
	assert.equal(code, 0);
	assert.deepEqual(JSON.parse(sent[0]?.body ?? ""), {
		device_code: "d",
		grant_type: "device_code",
	});
});

test("a raw payload comes from stdin, with --type, and the agent from the environment", async () => {
	const { sent } = await cli(
		[
			"--server",
			"http://local",
			"send",
			"--id",
			"s 1",
			"--type",
			"text/markdown",
		],
		{ stdin: "# hi", env: { VIBETOGETHER_AGENT: "claude" } },
	);
	assert.equal(
		sent[0]?.url,
		"http://local/api/things/s%201/entries?agent=claude",
	);
	assert.equal(sent[0]?.body, "# hi");
	assert.equal(sent[0]?.headers.get("content-type"), "text/markdown");
});

test("--agent overrides the environment", async () => {
	const { sent } = await cli(["--agent", "b", "receive", "--id", "s"], {
		env: { VIBETOGETHER_AGENT: "a" },
	});
	assert.equal(sent[0]?.url.endsWith("?agent=b"), true);
});

test("a refusal goes to stderr, with exit code 3", async () => {
	const { code, stdout, stderr } = await cli(["list-things"], {
		answer: () => new Response("No such thing.", { status: 404 }),
	});
	assert.equal(code, 3);
	assert.equal(stdout, "");
	assert.equal(stderr, "No such thing.\n");
});

test("a wrong call is a usage error, with exit code 2", async () => {
	for (const args of [
		["nothing"],
		["list-things", "--size", "1"],
		["create-thing"],
		["create-thing", "--name", "a", "--size", "big"],
		["list-things", "extra"],
	]) {
		const { code, stderr, sent } = await cli(args);
		assert.equal(code, 2, args.join(" "));
		assert.notEqual(stderr, "");
		assert.equal(sent.length, 0);
	}
});

test("a network failure is exit code 4, except for a wait, which tries again", async () => {
	const down = () => {
		throw new TypeError("fetch failed");
	};
	assert.equal((await cli(["list-things"], { answer: down })).code, 4);
	const { code, stdout, sent, sleeps } = await cli(["receive", "--id", "s"], {
		answer: (_, n) => {
			if (n === 1) throw new TypeError("fetch failed");
			if (n === 2)
				return new Response("Restarting.", {
					status: 503,
					headers: { "retry-after": "5" },
				});
			return Response.json({ entries: [] });
		},
	});
	assert.equal(code, 0);
	assert.equal(stdout, '{"entries":[]}');
	assert.equal(sent.length, 3);
	assert.deepEqual(sleeps, [1000, 5000]);
	// With `wait` 0 it waits not, so it tries once.
	assert.equal(
		(await cli(["receive", "--id", "s", "--wait", "0"], { answer: down })).code,
		4,
	);
});
