# Copyright (c) Joel Benway
# SPDX-License-Identifier: MIT

self: { config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.gone-to-plaid;
in
{
  options.services.gone-to-plaid = {
    enable = mkEnableOption "gone-to-plaid daemon for Actual Budget";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.system}.default;
      description = "The package providing gone-to-plaid.";
    };

    port = mkOption {
      type = types.port;
      default = 8085;
      description = "Port on which the web dashboard and API listen.";
    };

    dataDir = mkOption {
      type = types.path;
      default = "/var/lib/gone-to-plaid";
      description = "Directory storing local SQLite database and sync state.";
    };

    syncInterval = mkOption {
      type = types.str;
      default = "4h";
      description = "Systemd calendar expression or interval for automatic ledger sync passes.";
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = ''
        Path to an environment file containing secrets:
        - PLAID_CLIENT_ID
        - PLAID_SECRET
        - PLAID_ENV (sandbox or production)
        - ACTUAL_SERVER_URL
        - ACTUAL_PASSWORD (or server password)
        - ACTUAL_SYNC_ID
        - ACTUAL_ENCRYPTION_PASSWORD (optional, for E2EE budgets)
      '';
    };
  };

  # Compatibility alias for services.gone-to-plaid-sync
  options.services.gone-to-plaid-sync = mkOption {
    type = types.attrs;
    default = {};
    description = "Deprecated alias for services.gone-to-plaid.";
  };

  config = mkIf (cfg.enable || config.services.gone-to-plaid-sync.enable or false) {
    # If legacy option used, mirror enable
    services.gone-to-plaid.enable = mkDefault true;

    users.users.plaid-sync = {
      isSystemUser = true;
      group = "plaid-sync";
      home = cfg.dataDir;
      createHome = true;
    };
    users.groups.plaid-sync = {};

    systemd.services.gone-to-plaid = {
      description = "Gone To Plaid Actual Sync Daemon";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        ExecStart = "${cfg.package}/bin/gone-to-plaid --data-dir ${cfg.dataDir} --port ${toString cfg.port}";
        Restart = "on-failure";
        RestartSec = "10s";
        User = "plaid-sync";
        Group = "plaid-sync";
        WorkingDirectory = cfg.dataDir;
      } // (optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      }) // {
        # Hardening
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.dataDir ];
        PrivateTmp = true;
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
      };
    };

    systemd.timers.gone-to-plaid-trigger = {
      description = "Periodic trigger for gone-to-plaid ledger sync";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "5m";
        OnUnitActiveSec = cfg.syncInterval;
        Unit = "gone-to-plaid-run.service";
      };
    };

    systemd.services.gone-to-plaid-run = {
      description = "Run gone-to-plaid background pass";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.curl}/bin/curl -s -X POST http://127.0.0.1:${toString cfg.port}/api/sync";
        User = "plaid-sync";
      };
    };
  };
}
