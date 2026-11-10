import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

/** A secret: systemd's credential `credential` where the service has one, else `<name>` itself. */
function secret(name: string, credential: string): string {
	const file =
		process.env.CREDENTIALS_DIRECTORY &&
		`${process.env.CREDENTIALS_DIRECTORY}/${credential}`;
	return file && existsSync(file)
		? readFileSync(file, "utf8").trim()
		: required(name);
}

/** The key that signs sessions: `ACCOUNTS_SECRET`, else the file `ACCOUNTS_SECRET_FILE`, made on the first start. */
function signingKey(): string {
	const file = process.env.ACCOUNTS_SECRET_FILE;
	if (!file) return required("ACCOUNTS_SECRET");
	if (!existsSync(file))
		writeFileSync(file, randomBytes(48).toString("base64"), {
			mode: 0o600,
			flag: "wx",
		});
	return readFileSync(file, "utf8").trim();
}

/**
 * The bridges known to the service, such as messagent's Telegram bot: each by its `client_id`,
 * with the SHA-256 of its secret in hex. One bridge per line, `<client_id> <sha256>`, from
 * systemd's credential `bridges`, else `ACCOUNTS_BRIDGES`; none where neither is set.
 */
function bridges(): Map<string, string> {
	const file =
		process.env.CREDENTIALS_DIRECTORY &&
		`${process.env.CREDENTIALS_DIRECTORY}/bridges`;
	const text =
		file && existsSync(file)
			? readFileSync(file, "utf8")
			: (process.env.ACCOUNTS_BRIDGES ?? "");
	const bridges = new Map<string, string>();
	for (const line of text.split("\n")) {
		const [id, hash, ...rest] = line.trim().split(/\s+/);
		if (!id) continue;
		if (!hash || rest.length || !/^[0-9a-f]{64}$/.test(hash))
			throw new Error(
				`bridges: "${id}" is no line "<client_id> <sha256 in hex>"`,
			);
		bridges.set(id, hash);
	}
	return bridges;
}

export const config = {
	/** Where the service is reached from outside, such as `https://vibetogether.agentics.lwirth.com`. */
	url: required("ACCOUNTS_URL").replace(/\/$/, ""),
	port: Number(process.env.ACCOUNTS_PORT ?? 3000),
	database: required("ACCOUNTS_DATABASE"),
	secret: signingKey(),
	github: {
		clientId: required("GITHUB_CLIENT_ID"),
		clientSecret: secret("GITHUB_CLIENT_SECRET", "github"),
	},
	/** The bridges known to the service, by `client_id`, each with its secret's SHA-256 in hex. */
	bridges: bridges(),
	/** The relay the sessions live on, as its participants reach it. */
	relay: required("AGENTWIRE_RELAY").replace(/\/$/, ""),
};
