/**
 * Signs `<login>` in on a local backend, which GitHub can't call back to, and prints a sign-in's
 * cookie and a machine's token of theirs.
 */
import { serializeSignedCookie } from "better-call";
import { auth } from "../src/auth.ts";
import { db } from "../src/db.ts";

const login = process.argv[2];
if (!login) throw new Error("usage: seed.ts <login>");
const context = await auth.$context;
const existing = db.prepare("SELECT id FROM user WHERE login = ?").get(login) as
	| { id: string }
	| undefined;
const id =
	existing?.id ??
	(
		await context.internalAdapter.createUser(
			{
				email: `${login}@example.com`,
				name: login,
				login,
				emailVerified: true,
			},
			{ method: "admin" },
		)
	).id;
const signIn = await context.internalAdapter.createSession(id);
const cookie = await serializeSignedCookie(
	context.authCookies.sessionToken.name,
	signIn.token,
	context.secret,
);
const machine = await context.internalAdapter.createSession(id, false, {
	machine: `${login}-dev`,
});
console.log(
	JSON.stringify({ cookie: cookie.split(";")[0], token: machine.token }),
);
