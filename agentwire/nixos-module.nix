# The relay as a NixOS service. It acts for no one, so it runs as a user of
# its own, which reaches nothing but its database. It listens on 127.0.0.1
# only, and the host puts a front before it, such as a reverse proxy.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.agentwire-relay;
in {
  options.services.agentwire-relay = {
    enable = lib.mkEnableOption "the agentwire relay";
    port = lib.mkOption {
      type = lib.types.port;
      default = 8790;
      description = "The port the relay listens on, on 127.0.0.1.";
    };
    access = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://127.0.0.1:8793/agentwire";
      description = "The access service's URL, which decides who may be in a session and which sessions last; without one, whoever holds a link joins.";
    };
    minFree = lib.mkOption {
      type = lib.types.nullOr lib.types.ints.unsigned;
      default = 5 * 1024 * 1024 * 1024;
      description = "The bytes that stay free on the disk of the relay's database: below them, the relay refuses new sessions, joins and entries. Null for no such guard.";
    };
  };

  # Read at each request, so that a switch with a new wording restarts no relay.
  config.environment.etc."agentwire-relay".source = lib.mkIf cfg.enable self.packages.${pkgs.stdenv.hostPlatform.system}.agentwire-relay-files;

  config.systemd.services.agentwire-relay = lib.mkIf cfg.enable {
    description = "The agentwire relay";
    after = ["network.target"];
    wantedBy = ["multi-user.target"];
    environment =
      {
        AGENTWIRE_ADDRESS = "127.0.0.1:${toString cfg.port}";
        AGENTWIRE_DATABASE = "/var/lib/agentwire-relay/relay.db";
        AGENTWIRE_FILES = "/etc/agentwire-relay";
      }
      // lib.optionalAttrs (cfg.access != null) {
        AGENTWIRE_ACCESS = cfg.access;
      }
      // lib.optionalAttrs (cfg.minFree != null) {
        AGENTWIRE_MIN_FREE = toString cfg.minFree;
      };
    serviceConfig = {
      ExecStart = lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.agentwire-relay;
      Restart = "on-failure";
      # A blow-up ends this service alone, which then restarts; each waiting
      # receive holds a connection, so the default of 1024 files is too few.
      MemoryMax = "1G";
      LimitNOFILE = 65536;
      DynamicUser = true;
      StateDirectory = "agentwire-relay";
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
      MemoryDenyWriteExecute = true;
      RestrictAddressFamilies = ["AF_INET" "AF_INET6"];
      RestrictNamespaces = true;
      RestrictRealtime = true;
      SystemCallArchitectures = "native";
      SystemCallFilter = ["@system-service" "~@privileged"];
      UMask = "0077";
    };
  };
}
