# The backend as a NixOS service. It acts for no one, so it runs as a user of
# its own, which reaches nothing but its database. It listens on 127.0.0.1
# only: the host proxies /api/ to it.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.vibetogether-backend;
in {
  options.services.vibetogether-backend = {
    enable = lib.mkEnableOption "Vibe Together's backend";
    port = lib.mkOption {
      type = lib.types.port;
      default = 8793;
      description = "The port the backend listens on, on 127.0.0.1.";
    };
    url = lib.mkOption {
      type = lib.types.str;
      example = "https://vibetogether.potentialhedge.com";
      description = "Where the backend is reached from outside.";
    };
    owner = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "luiswirth";
      description = "The server's owner, where it has one: whoever reaches it is its owner, so the network it is served on is the boundary. Without one, people sign in with GitHub.";
    };
    github.clientId = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "The GitHub OAuth app's client ID, on a server without an owner.";
    };
    github.clientSecretFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "The file holding the GitHub OAuth app's client secret, read as a credential, so that it never enters the store.";
    };
    site = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression "vibetogether.packages.\${system}.website";
      description = "The website's build, served by the backend itself beside the API, where no other host serves it.";
    };
  };

  config.assertions = lib.mkIf cfg.enable [
    {
      assertion = cfg.owner != null || (cfg.github.clientId != null && cfg.github.clientSecretFile != null);
      message = "services.vibetogether-backend: an owner, or a GitHub OAuth app.";
    }
  ];

  config.systemd.services.vibetogether-backend = lib.mkIf cfg.enable {
    description = "Vibe Together's backend";
    after = ["network.target"];
    wantedBy = ["multi-user.target"];
    environment =
      {
        BACKEND_URL = cfg.url;
        BACKEND_PORT = toString cfg.port;
        # A database of the TypeScript backend's is imported at the first start
        # (backend/src/legacy.rs), and kept beside it as backend-legacy-imported.db.
        BACKEND_DATABASE = "/var/lib/vibetogether-backend/backend.db";
      }
      // lib.optionalAttrs (cfg.owner != null) {BACKEND_OWNER = cfg.owner;}
      // lib.optionalAttrs (cfg.owner == null) {GITHUB_CLIENT_ID = cfg.github.clientId;}
      // lib.optionalAttrs (cfg.site != null) {BACKEND_SITE = toString cfg.site;};
    serviceConfig = {
      ExecStart = lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.vibetogether-backend;
      Restart = "on-failure";
      # A blow-up ends this service alone, which then restarts; each waiting
      # receive holds a connection, so the default of 1024 files is too few.
      MemoryMax = "1G";
      LimitNOFILE = 65536;
      # Read by the backend from $CREDENTIALS_DIRECTORY/github.
      LoadCredential = lib.optional (cfg.owner == null) "github:${cfg.github.clientSecretFile}";
      DynamicUser = true;
      StateDirectory = "vibetogether-backend";
      ProtectHome = true;
      PrivateDevices = true;
      ProtectClock = true;
      ProtectControlGroups = true;
      ProtectHostname = true;
      ProtectKernelLogs = true;
      ProtectKernelModules = true;
      ProtectKernelTunables = true;
      ProtectProc = "invisible";
      CapabilityBoundingSet = "";
      LockPersonality = true;
      RestrictAddressFamilies = ["AF_INET" "AF_INET6" "AF_UNIX"];
      RestrictNamespaces = true;
      RestrictRealtime = true;
      SystemCallArchitectures = "native";
      SystemCallFilter = ["@system-service" "~@privileged"];
      UMask = "0077";
    };
  };
}
