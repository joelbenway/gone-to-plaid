# Copyright (c) Joel Benway
# SPDX-License-Identifier: MIT

self: { config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.gone-to-plaid-sync;
in
{
  options.services.gone-to-plaid-sync = {
    enable = mkEnableOption "gone-to-plaid-sync daemon for Actual Budget";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.system}.default;
      description = "The package providing gone-to-plaid-sync.";
    };

    port = mkOption {
      type = types.port;
      default = 8085;
      description = "Port on which the web dashboard and API listen.";
    };

    dataDir = mkOption {
      type = types.path;
      default = "/var/lib/gone-to-plaid-sync";
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

  config = mkIf cfg.enable {
    users.users.plaid-sync = {
      isSystemUser = true;
      group = "plaid-sync";
      home = cfg.dataDir;
      createHome = true;
    };
    users.groups.plaid-sync = {};

    systemd.services.gone-to-plaid-sync = {
      description = "Gone To Plaid Actual Sync Daemon";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        ExecStart = "${cfg.package}/bin/gone-to-plaid-sync --data-dir ${cfg.dataDir} --port ${toString cfg.port}";
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

    systemd.timers.gone-to-plaid-sync-trigger = {
      description = "Periodic trigger for gone-to-plaid-sync ledger sync";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "5m";
        OnUnitActiveSec = cfg.syncInterval;
        Unit = "gone-to-plaid-sync-run.service";
      };
    };

    systemd.services.gone-to-plaid-sync-run = {
      description = "Run gone-to-plaid-sync background pass";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.curl}/bin/curl -s -X POST http://127.0.0.1:${toString cfg.port}/api/sync";
        User = "plaid-sync";
      };
    };
  };
}
