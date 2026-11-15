PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "login" text not null unique);
INSERT INTO user VALUES('qvwUUEwGtdkcGWNsS5344qE7SH4FC2t6','Luis Wirth','luis@example.com',1,'https://avatars.githubusercontent.com/u/1001','2026-11-15T19:45:58.240Z','2026-11-15T19:45:58.240Z','luis');
INSERT INTO user VALUES('Rw3MFwmh9KTplZuN8uceWIHGbGcuff6j','ben','ben@example.com',1,NULL,'2026-11-15T19:45:58.782Z','2026-11-15T19:45:58.782Z','ben');
CREATE TABLE IF NOT EXISTS "login" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "machine" text);
INSERT INTO login VALUES('8lLVnqONNaSgi57ME2CGYWxgt38D6Olt','2027-02-13T19:45:58.242Z','pHv8UOJruhnH60k4ODn8kD27ECqo4HER','2026-11-15T19:45:58.242Z','2026-11-15T19:45:58.242Z','','','qvwUUEwGtdkcGWNsS5344qE7SH4FC2t6',NULL);
INSERT INTO login VALUES('V9P57LynxEOJ0tVHJFv4U3XrIZ9DFGjN','9999-12-31T00:00:00.000Z','AGDek2NG0aCyeRhK2TqlaSC58sWnEQ1F','2026-11-15T19:45:58.245Z','2026-11-15T19:45:58.245Z','','','qvwUUEwGtdkcGWNsS5344qE7SH4FC2t6','luis-dev');
INSERT INTO login VALUES('SUZVdW9VDHvRHLnT9s0gQnTcDVT5xciM','2027-02-13T19:45:58.783Z','LQAE2yHdgGpUadQ4hK84Qu5G6SWzxYQ6','2026-11-15T19:45:58.783Z','2026-11-15T19:45:58.783Z','','','Rw3MFwmh9KTplZuN8uceWIHGbGcuff6j',NULL);
INSERT INTO login VALUES('QCjuX19Wa8FSUqyudAaYpB07dXsJVCjD','9999-12-31T00:00:00.000Z','rJfmpSNATlAQ2TbEKKv2R8Tz3kZRykaX','2026-11-15T19:45:58.785Z','2026-11-15T19:45:58.785Z','','','Rw3MFwmh9KTplZuN8uceWIHGbGcuff6j','ben-dev');
INSERT INTO login VALUES('old','2026-01-01T00:00:00.000Z','expiredtoken','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z',NULL,NULL,'Rw3MFwmh9KTplZuN8uceWIHGbGcuff6j','ben-old');
CREATE TABLE IF NOT EXISTS "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
INSERT INTO account VALUES('acc1','1001','github','qvwUUEwGtdkcGWNsS5344qE7SH4FC2t6','gho_x',NULL,NULL,NULL,NULL,'read:user',NULL,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');
INSERT INTO user VALUES('sys','Impostor','impostor@example.com',1,NULL,'2026-11-15T19:45:58.782Z','2026-11-15T19:45:58.782Z','vibetogether');
INSERT INTO account VALUES('acc3','1003','github','sys',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');
INSERT INTO account VALUES('acc2','1002','github','Rw3MFwmh9KTplZuN8uceWIHGbGcuff6j',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');
CREATE TABLE IF NOT EXISTS "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE IF NOT EXISTS "deviceCode" ("id" text not null primary key, "deviceCode" text not null, "userCode" text not null, "userId" text, "expiresAt" date not null, "status" text not null, "lastPolledAt" date, "pollingInterval" integer, "clientId" text, "scope" text);
CREATE TABLE IF NOT EXISTS "oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" integer, "skipConsent" integer, "enableEndSession" integer, "subjectType" text, "scopes" text, "clientCredentialsScopes" text, "userId" text references "user" ("id") on delete cascade, "createdAt" date, "updatedAt" date, "name" text, "uri" text, "icon" text, "contacts" text, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" text not null, "postLogoutRedirectUris" text, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" integer, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" text, "responseTypes" text, "requirePKCE" integer, "dpopBoundAccessTokens" integer, "referenceId" text, "metadata" text);
CREATE TABLE IF NOT EXISTS "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" text, "customClaims" text, "dpopBoundAccessTokensRequired" integer, "disabled" integer, "createdAt" date, "updatedAt" date, "policyVersion" integer, "metadata" text);
INSERT INTO oauthResource VALUES('YzWVJ46gAEKeNJqqEFXEa73vJXpQA4CW','http://localhost:5173/mcp','http://localhost:5173/mcp',NULL,NULL,NULL,NULL,NULL,'null',0,0,'2026-11-15T19:45:58.234Z','2026-11-15T19:45:58.234Z',1,'null');
CREATE TABLE IF NOT EXISTS "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" text, "createdAt" date);
CREATE TABLE IF NOT EXISTS "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "login" ("id") on delete set null, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "rotatedAt" date, "rotationReplayResponse" text, "rotationReplayExpiresAt" date, "authTime" date, "confirmation" text, "scopes" text not null);
CREATE TABLE IF NOT EXISTS "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "login" ("id") on delete set null, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "confirmation" text, "scopes" text not null);
CREATE TABLE IF NOT EXISTS "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "resources" text, "requestedUserInfoClaims" text, "scopes" text not null, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE IF NOT EXISTS "oauthClientAssertion" ("id" text not null primary key, "expiresAt" date not null);
CREATE TABLE IF NOT EXISTS "group" (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			person TEXT UNIQUE REFERENCES user(id) ON DELETE CASCADE,
			created TEXT NOT NULL
		);
INSERT INTO "group" VALUES('g_1','luis','qvwUUEwGtdkcGWNsS5344qE7SH4FC2t6','2026-11-01T00:00:00.000Z');
CREATE TABLE group_member (
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			PRIMARY KEY ("group", user)
		);
INSERT INTO group_member VALUES('g_1','qvwUUEwGtdkcGWNsS5344qE7SH4FC2t6');
CREATE TABLE project (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			created TEXT NOT NULL
		);
CREATE TABLE project_repo (
			project TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
			position INTEGER NOT NULL,
			repo TEXT NOT NULL,
			PRIMARY KEY (project, position),
			UNIQUE (project, repo)
		);
CREATE TABLE session (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			project TEXT REFERENCES project(id) ON DELETE CASCADE,
			creator TEXT REFERENCES user(id) ON DELETE SET NULL,
			created TEXT NOT NULL
		);
INSERT INTO session VALUES('s_1','general',NULL,NULL,'2026-11-01T00:00:00.000Z');
CREATE TABLE group_session (
			session TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			general INTEGER NOT NULL DEFAULT 0
		);
INSERT INTO group_session VALUES('s_1','g_1',1);
CREATE TABLE dm (
			a TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			b TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			session TEXT NOT NULL UNIQUE REFERENCES session(id),
			PRIMARY KEY (a, b),
			CHECK (a < b)
		);
CREATE TABLE friend (
			"from" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			"to" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			PRIMARY KEY ("from", "to")
		);
CREATE TABLE entry (
			session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
			n INTEGER NOT NULL,
			time TEXT NOT NULL,
			sender TEXT NOT NULL,
			participant TEXT,
			type TEXT NOT NULL,
			size INTEGER NOT NULL,
			filename TEXT,
			text TEXT,
			payload BLOB,
			PRIMARY KEY (session, n)
		) WITHOUT ROWID;
INSERT INTO entry VALUES('s_1',1,'2026-11-01T00:00:00Z','vibetogether',NULL,'text/plain',2,NULL,'hi',NULL);
CREATE TABLE agent (
			id TEXT PRIMARY KEY,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			holder TEXT,
			seen TEXT,
			archived TEXT,
			created TEXT NOT NULL
		);
INSERT INTO agent VALUES('a_12345678','qvwUUEwGtdkcGWNsS5344qE7SH4FC2t6','claude','V9P57LynxEOJ0tVHJFv4U3XrIZ9DFGjN',NULL,NULL,'2026-11-01T00:00:00.000Z');
CREATE TABLE status (
			participant TEXT PRIMARY KEY,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			text TEXT NOT NULL
		);
CREATE TABLE participant (
			session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
			id TEXT NOT NULL,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			inside INTEGER NOT NULL,
			entry INTEGER NOT NULL,
			received INTEGER NOT NULL,
			read INTEGER NOT NULL,
			since TEXT NOT NULL,
			PRIMARY KEY (session, id)
		);
CREATE TABLE stream_head (
			participant TEXT PRIMARY KEY,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			last INTEGER NOT NULL,
			received INTEGER NOT NULL,
			read INTEGER NOT NULL
		);
CREATE TABLE stream (
			participant TEXT NOT NULL REFERENCES stream_head(participant) ON DELETE CASCADE,
			n INTEGER NOT NULL,
			session TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
			entry INTEGER NOT NULL,
			reach TEXT NOT NULL,
			created TEXT NOT NULL,
			PRIMARY KEY (participant, n)
		) WITHOUT ROWID;
CREATE TABLE activity (
			id INTEGER PRIMARY KEY,
			user TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			login TEXT NOT NULL,
			agent TEXT NOT NULL,
			operation TEXT NOT NULL,
			arguments TEXT NOT NULL,
			created TEXT NOT NULL
		);
CREATE TABLE invite (
			code TEXT PRIMARY KEY,
			inviter TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			project TEXT REFERENCES project(id) ON DELETE CASCADE,
			created TEXT NOT NULL,
			expires TEXT NOT NULL,
			accepted_by TEXT REFERENCES user(id) ON DELETE CASCADE,
			accepted TEXT
		);
CREATE TABLE invite_group (
			code TEXT PRIMARY KEY REFERENCES invite(code) ON DELETE CASCADE,
			"group" TEXT NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
			session TEXT REFERENCES session(id) ON DELETE SET NULL
		);
CREATE TABLE otp_request (
			user_code TEXT PRIMARY KEY,
			requested TEXT NOT NULL,
			"from" TEXT NOT NULL
		);
CREATE TRIGGER group_session_gone AFTER DELETE ON group_session
		BEGIN
			DELETE FROM session WHERE id = OLD.session;
		END;
CREATE TRIGGER dm_session AFTER DELETE ON dm
		BEGIN
			DELETE FROM session WHERE id = OLD.session;
		END;
CREATE TRIGGER invite_group_gone AFTER DELETE ON invite_group
		BEGIN
			DELETE FROM invite WHERE code = OLD.code;
		END;
CREATE INDEX "login_userId_idx" on "login" ("userId");
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
CREATE INDEX session_of ON session (project);
CREATE INDEX group_session_of ON group_session ("group");
CREATE UNIQUE INDEX general_of ON group_session ("group") WHERE general = 1;
CREATE UNIQUE INDEX agent_name ON agent (user, name) WHERE archived IS NULL;
CREATE INDEX stream_age ON stream (created);
CREATE INDEX activity_of ON activity (user, created);
COMMIT;
