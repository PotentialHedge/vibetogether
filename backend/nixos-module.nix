# The backend as a NixOS service, the MCP server in it. It acts for no one, so
# it runs as a user of its own, which reaches nothing but its database. It
# listens on 127.0.0.1 only: the host proxies /api/, /mcp and /.well-known/ to it.
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
    github.clientId = lib.mkOption {
      type = lib.types.str;
      description = "The GitHub OAuth app's client ID.";
    };
    github.clientSecretFile = lib.mkOption {
      type = lib.types.path;
      description = "The file holding the GitHub OAuth app's client secret, read as a credential, so that it never enters the store.";
    };
  };

  config.systemd.services.vibetogether-backend = lib.mkIf cfg.enable {
    description = "Vibe Together's backend";
    after = ["network.target"];
    wantedBy = ["multi-user.target"];
    environment = {
      BACKEND_URL = cfg.url;
      BACKEND_PORT = toString cfg.port;
      BACKEND_DATABASE = "/var/lib/vibetogether-backend/backend.db";
      # The key that signs sign-ins, which the backend makes on its first start.
      BACKEND_SECRET_FILE = "/var/lib/vibetogether-backend/secret";
      GITHUB_CLIENT_ID = cfg.github.clientId;
    };
    serviceConfig = {
      ExecStart = lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.vibetogether-backend;
      Restart = "on-failure";
      # A blow-up ends this service alone, which then restarts; each waiting
      # receive holds a connection, so the default of 1024 files is too few.
      MemoryMax = "1G";
      LimitNOFILE = 65536;
      # Read by the backend from $CREDENTIALS_DIRECTORY/github.
      LoadCredential = ["github:${cfg.github.clientSecretFile}"];
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
