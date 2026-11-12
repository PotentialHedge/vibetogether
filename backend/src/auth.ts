import { createHash } from "node:crypto";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { config } from "./config.ts";
import { createTables, db } from "./db.ts";
import { isNamePart } from "./names.ts";
import { systemName } from "./transport.ts";

/** The hash under which the OAuth provider stores a token. */
export function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("base64url");
}

export const oauthAccessTokenPrefix = "vt_at_";

/** When a machine's token expires: never, since a token lasts until it is revoked. */
const never = new Date("9999-12-31T00:00:00Z");

/**
 * A GitHub login is unique on GitHub, but one that was renamed there keeps its old login here
 * until it signs in again. Whoever has the login now takes it, and the one before is named
 * after its GitHub id until then.
 */
function freeLogin(login: unknown, email: unknown): void {
	if (typeof login !== "string") return;
	const holder = db
		.prepare(
			`SELECT u.id, u.email, a.accountId FROM user u
			 LEFT JOIN account a ON a.userId = u.id AND a.providerId = 'github' WHERE u.login = ?`,
		)
		.get(login) as
		| { id: string; email: string; accountId: string | null }
		| undefined;
	// The user being updated is the one with its email, which is unique too.
	if (!holder || holder.email === String(email).toLowerCase()) return;
	db.prepare("UPDATE user SET login = ? WHERE id = ?").run(
		`github-${holder.accountId ?? holder.id}`,
		holder.id,
	);
}

const options = {
	baseURL: config.url,
	basePath: "/api/auth",
	secret: config.secret,
	database: db,
	// Exact origins only: other sites under the same domain are other people's.
	trustedOrigins: [config.url],
	// Over HTTPS, every cookie is `__Host-`: Secure, for this host alone and its whole path.
	...(config.url.startsWith("https://") && {
		advanced: {
			useSecureCookies: false,
			cookiePrefix: "__Host-vibetogether",
			defaultCookieAttributes: { secure: true, path: "/" },
		},
	}),
	// On everywhere, not only where NODE_ENV is production. Caddy sets X-Forwarded-For to the client.
	rateLimit: {
		enabled: true,
		window: 60,
		max: 100,
		customRules: {
			"/device/code": { window: 60, max: 10 },
			"/oauth2/register": { window: 3600, max: 20 },
			"/sign-in/social": { window: 60, max: 10 },
		},
	},
	socialProviders: {
		github: {
			clientId: config.github.clientId,
			clientSecret: config.github.clientSecret,
			mapProfileToUser: (profile) => ({ login: profile.login.toLowerCase() }),
			// A rename on GitHub renames the account at its next sign-in.
			overrideUserInfoOnSignIn: true,
		},
	},
	// The login is GitHub's, so no request updates the user.
	disabledPaths: ["/update-user"],
	user: {
		additionalFields: {
			login: { type: "string", required: true, unique: true },
		},
	},
	// Better Auth's session is a login: a sign-in in a browser, or a machine's token.
	session: {
		modelName: "login",
		expiresIn: 90 * 24 * 60 * 60,
		updateAge: 24 * 60 * 60,
		additionalFields: {
			// The machine a token is for, by its name; null for a sign-in.
			machine: { type: "string", required: false, input: false },
		},
	},
	databaseHooks: {
		user: {
			// No account takes the name system messages are sent under, so that none passes for them.
			create: {
				before: async (user) =>
					user.login === systemName ? false : freeLogin(user.login, user.email),
			},
			update: {
				before: async (user) =>
					user.login === systemName ? false : freeLogin(user.login, user.email),
			},
		},
		session: {
			create: {
				before: async (session, ctx) => {
					if (ctx?.path !== "/device/token") return;
					return {
						data: {
							...session,
							machine: String(ctx.body.client_id),
							expiresAt: never,
						},
					};
				},
			},
		},
	},
	plugins: [
		bearer(),
		deviceAuthorization({
			verificationUri: `${config.url}/account/device/`,
			validateClient: isNamePart,
			expiresIn: "15m",
		}),
		mcp({
			resource: `${config.url}/mcp`,
			loginPage: "/account/sign-in/",
			consentPage: "/account/consent/",
			// Opaque tokens only, so that revoking one cuts its agent off at once.
			disableJwtPlugin: true,
			storeTokens: { hash: async (token) => tokenHash(token) },
			prefix: {
				opaqueAccessToken: oauthAccessTokenPrefix,
				refreshToken: "vt_rt_",
			},
			scopes: ["openid", "profile", "offline_access"],
			// MCP clients that predate Client ID Metadata Documents still register themselves.
			allowDynamicClientRegistration: true,
			allowUnauthenticatedClientRegistration: true,
			clientRegistrationDefaultApplicationType: "infer",
		}),
		cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
	],
} satisfies BetterAuthOptions;

// Before Better Auth starts, since it checks the schema as it does.
await (await getMigrations(options)).runMigrations();
createTables();

export const auth = betterAuth(options);
