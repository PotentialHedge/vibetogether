CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "login" text not null unique);
CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "agent" text, "person" integer, "claim" text);
CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "deviceCode" ("id" text not null primary key, "deviceCode" text not null, "userCode" text not null, "userId" text, "expiresAt" date not null, "status" text not null, "lastPolledAt" date, "pollingInterval" integer, "clientId" text, "scope" text);
CREATE TABLE "oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" integer, "skipConsent" integer, "enableEndSession" integer, "subjectType" text, "scopes" text, "clientCredentialsScopes" text, "userId" text references "user" ("id") on delete cascade, "createdAt" date, "updatedAt" date, "name" text, "uri" text, "icon" text, "contacts" text, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" text not null, "postLogoutRedirectUris" text, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" integer, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" text, "responseTypes" text, "requirePKCE" integer, "dpopBoundAccessTokens" integer, "referenceId" text, "metadata" text);
CREATE TABLE "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" text, "customClaims" text, "dpopBoundAccessTokensRequired" integer, "disabled" integer, "createdAt" date, "updatedAt" date, "policyVersion" integer, "metadata" text);
CREATE TABLE "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" text, "createdAt" date);
CREATE TABLE "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "rotatedAt" date, "rotationReplayResponse" text, "rotationReplayExpiresAt" date, "authTime" date, "confirmation" text, "scopes" text not null);
CREATE TABLE "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "confirmation" text, "scopes" text not null);
CREATE TABLE "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "resources" text, "requestedUserInfoClaims" text, "scopes" text not null, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "oauthClientAssertion" ("id" text not null primary key, "expiresAt" date not null);
CREATE INDEX "session_userId_idx" on "session" ("userId");
CREATE INDEX "account_userId_idx" on "account" ("userId");
CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");
CREATE INDEX "oauthClient_userId_idx" on "oauthClient" ("userId");
CREATE INDEX "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");
CREATE INDEX "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");
CREATE INDEX "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId");
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");
CREATE INDEX "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");
CREATE INDEX "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");
CREATE INDEX "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId");
CREATE INDEX "oauthConsent_clientId_idx" on "oauthConsent" ("clientId");
CREATE INDEX "oauthConsent_userId_idx" on "oauthConsent" ("userId");
CREATE UNIQUE INDEX "deviceCode_deviceCode_uidx" on "deviceCode" ("deviceCode");
CREATE UNIQUE INDEX "deviceCode_userCode_uidx" on "deviceCode" ("userCode");
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");
CREATE TABLE device_request (
			user_code TEXT PRIMARY KEY,
			requested TEXT NOT NULL,
			"from" TEXT NOT NULL
		, device_code TEXT, person INTEGER NOT NULL DEFAULT 0, claim TEXT);
CREATE TABLE friend (
			"from" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			"to" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			PRIMARY KEY ("from", "to")
		);
CREATE TABLE "group" (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			own INTEGER NOT NULL DEFAULT 0,
			created TEXT NOT NULL
		);
CREATE UNIQUE INDEX group_own ON "group" (owner) WHERE own = 1;
CREATE TABLE group_member (
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			PRIMARY KEY ("group", user)
		);
CREATE TABLE project (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			app TEXT,
			created TEXT NOT NULL
		);
CREATE UNIQUE INDEX project_app ON project ("group", app) WHERE app IS NOT NULL;
CREATE TABLE "owned_session" (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				project TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
				creator TEXT REFERENCES user(id) ON DELETE SET NULL,
				secret TEXT UNIQUE,
				created TEXT NOT NULL,
				app_grant TEXT
			);
CREATE TABLE dm (
			id TEXT PRIMARY KEY,
			a TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			b TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			secret TEXT UNIQUE,
			created TEXT NOT NULL,
			UNIQUE (a, b),
			CHECK (a < b)
		);
CREATE TABLE project_repo (
			project TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
			position INTEGER NOT NULL,
			repo TEXT NOT NULL,
			PRIMARY KEY (project, position),
			UNIQUE (project, repo)
		);
CREATE TABLE minted (
			session TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
			by TEXT NOT NULL
		);
CREATE TABLE activity (
			id INTEGER PRIMARY KEY,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			token TEXT NOT NULL,
			agent TEXT NOT NULL,
			operation TEXT NOT NULL,
			arguments TEXT NOT NULL,
			created TEXT NOT NULL
		);
CREATE INDEX activity_of ON activity (user, created);
CREATE TABLE invite (
			code TEXT PRIMARY KEY,
			inviter TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			project TEXT REFERENCES project(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			expires TEXT NOT NULL,
			accepted_by TEXT REFERENCES user(id) ON DELETE CASCADE,
			accepted TEXT
		);
CREATE TABLE person_otp (
			code TEXT PRIMARY KEY,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			expires TEXT NOT NULL
		);
