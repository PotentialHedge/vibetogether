import { createHash, randomBytes } from "node:crypto";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { config } from "./config.ts";
import { db, migrate } from "./db.ts";
import { isNamePart } from "./names.ts";

/** The hash under which the OAuth provider stores a token, which `caller` looks tokens up by. */
export function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("base64url");
}

export const oauthAccessTokenPrefix = "vt_at_";

const day = 24 * 60 * 60;

/**
 * The header by which the service tells Better Auth that it checked a request's bridge by its
 * secret: it is removed from every request that arrives, and set only to this process's own mark.
 */
export const bridgeHeader = "x-vibetogether-bridge";
export const bridgeMark = randomBytes(32).toString("base64url");

/**
 * An OTP's limit per address, where a checked bridge goes unlimited: a bridge, such as the
 * Telegram bot, asks for everyone it serves from one address, and only those holding its secret are it.
 */
const unlessBridge = (window: number, max: number) => (request: Request) =>
	request.headers.get(bridgeHeader) === bridgeMark ? false : { window, max };

const options = {
	baseURL: config.url,
	basePath: "/api/auth",
	secret: config.secret,
	database: db,
	trustedOrigins: [config.url],
	// On everywhere, not only where NODE_ENV is production. Caddy sets X-Forwarded-For to the client.
	rateLimit: {
		enabled: true,
		window: 60,
		max: 100,
		customRules: {
			"/device/code": unlessBridge(60, 10),
			"/device/token": unlessBridge(60, 100),
			"/oauth2/register": { window: 3600, max: 20 },
			"/sign-in/social": { window: 60, max: 10 },
		},
	},
	socialProviders: {
		github: {
			clientId: config.github.clientId,
			clientSecret: config.github.clientSecret,
			mapProfileToUser: (profile) => ({ login: profile.login.toLowerCase() }),
		},
	},
	// The login is input, since Better Auth takes only input fields from a provider's profile, so
	// no request may update the user afterwards.
	disabledPaths: ["/update-user"],
	user: {
		additionalFields: {
			// The person's name in agentwire, from their GitHub login.
			login: { type: "string", required: true, unique: true },
		},
	},
	session: {
		// A session from an OTP is a token, which lives while it is used.
		expiresIn: 90 * day,
		updateAge: day,
		additionalFields: {
			agent: { type: "string", required: false, input: false },
			// A bridge's credential: the session it was added to, by its id, and what the bridge
			// said it bridges, such as a Telegram chat.
			bridge: { type: "string", required: false, input: false },
			claim: { type: "string", required: false, input: false },
		},
	},
	databaseHooks: {
		session: {
			create: {
				before: async (session, ctx) => {
					if (ctx?.path !== "/device/token") return;
					const asked = db
						.prepare(
							"SELECT bridge, session, claim FROM device_request WHERE device_code = ?",
						)
						.get(tokenHash(String(ctx.body.device_code))) as
						| {
								bridge: string | null;
								session: string | null;
								claim: string | null;
						  }
						| undefined;
					if (!asked?.bridge)
						return { data: { ...session, agent: ctx.body.client_id } };
					// Approved without a session picked, which only the service's own approval
					// prevents: such a bridge gets nothing.
					if (!asked.session) return false;
					// It lasts until it is removed, as a link lasted, Luis's agreement (2026-11-09).
					return {
						data: {
							...session,
							agent: ctx.body.client_id,
							bridge: asked.session,
							claim: asked.claim,
							expiresAt: new Date("9999-12-31T00:00:00Z"),
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
migrate();

export const auth = betterAuth(options);
