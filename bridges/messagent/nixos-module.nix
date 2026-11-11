# messagent's Telegram bridge as a NixOS service: one bot for everyone, which bridges each chat a
# member added to a session of theirs. It fetches Telegram's updates by long polling, so it listens
# on nothing. It runs as a user of its own, whose state directory holds the bridges' credentials.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.messagent;
in {
  options.services.messagent = {
    enable = lib.mkEnableOption "messagent's Telegram bridge";
    accounts = lib.mkOption {
      type = lib.types.str;
      example = "https://vibetogether.potentialhedge.com";
      description = "The account service, as the bot reaches it.";
    };
    botTokenFile = lib.mkOption {
      type = lib.types.path;
      description = "The file holding the bot's token, from BotFather, read as a credential, so that it never enters the store.";
    };
    bridgeSecretFile = lib.mkOption {
      type = lib.types.path;
      description = "The file holding messagent's secret at the account service, as a bridge it knows, read as a credential.";
    };
  };

  config.systemd.services.messagent = lib.mkIf cfg.enable {
    description = "messagent's Telegram bridge";
    after = ["network-online.target"];
    wants = ["network-online.target"];
    wantedBy = ["multi-user.target"];
    environment = {
      HOME = "/var/lib/messagent";
      XDG_STATE_HOME = "/var/lib/messagent";
      XDG_CONFIG_HOME = "/var/lib/messagent";
    };
    serviceConfig = {
      # A blow-up ends this service alone, which then restarts.
      MemoryMax = "256M";
      ExecStart = lib.escapeShellArgs [
        (lib.getExe' self.packages.${pkgs.stdenv.hostPlatform.system}.messagent "messagent")
        "serve"
        "--bot-token"
        "%d/bot-token"
        "--bridge-secret"
        "%d/bridge-secret"
        "--accounts"
        cfg.accounts
      ];
      Restart = "on-failure";
      RestartSec = 5;
      LoadCredential = [
        "bot-token:${cfg.botTokenFile}"
        "bridge-secret:${cfg.bridgeSecretFile}"
      ];
      DynamicUser = true;
      StateDirectory = "messagent";
      StateDirectoryMode = "0700";
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
