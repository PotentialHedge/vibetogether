/** What the operations give and take, shared by their modules. */
import { db } from "./db.ts";
import { z } from "./openapi.ts";

export const Id = (prefix: string, what: string) =>
	z.string().meta({ description: `The ${what}'s id, as \`${prefix}_…\`.` });

export const Name = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.meta({ description: "A name, of at most 100 characters." });

export const Login = z
	.string()
	.meta({ description: "A person's name: their GitHub login in lower case." });

export const Named = (prefix: string, what: string) =>
	z.object({ id: Id(prefix, what), name: z.string() });

export const json = <S extends z.ZodType>(schema: S, description: string) => ({
	description,
	content: { "application/json": { schema } },
});

export const body = <S extends z.ZodType>(schema: S) => ({
	body: { content: { "application/json": { schema } }, required: true },
});

export const path = <S extends z.ZodRawShape>(shape: S) => ({
	params: z.object(shape),
});

export const done = { 204: { description: "Done." } };

export const count = (sql: string, ...args: string[]) =>
	(db.prepare(sql).get(...args) as { n: number }).n;
