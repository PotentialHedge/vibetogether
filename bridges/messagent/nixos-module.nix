# messagent's shared bot as a NixOS service: one Telegram bot for everyone, which acts as each
# person who linked their chat. It fetches Telegram's updates by long polling, so it listens on
# nothing. It runs as a user of its own, whose state directory holds the people's tokens.
self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.messagent;
in {
  options.services.messagent = {
    enable = lib.mkEnableOption "messagent's shared Telegram bot";
    accounts = lib.mkOption {
      type = lib.types.str;
      example = "https://vibetogether.agentics.lwirth.com";
      description = "The account service, as the bot reaches it.";
    };
    botTokenFile = lib.mkOption {
      type = lib.types.path;
      description = "The file holding the bot's token, from BotFather, read as a credential, so that it never enters the store.";
    };
    appSecretFile = lib.mkOption {
      type = lib.types.path;
      description = "The file holding messagent's secret at the account service, read as a credential.";
    };
  };

  config.systemd.services.messagent = lib.mkIf cfg.enable {
    description = "messagent's shared Telegram bot";
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
        "--app-secret"
        "%d/app-secret"
        "--accounts"
        cfg.accounts
      ];
      Restart = "on-failure";
      RestartSec = 5;
      LoadCredential = [
        "bot-token:${cfg.botTokenFile}"
        "app-secret:${cfg.appSecretFile}"
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
