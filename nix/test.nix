# Copyright (c) Joel Benway
# SPDX-License-Identifier: MIT

{ pkgs, self }:

pkgs.testers.runNixOSTest {
  name = "gone-to-plaid-sync-test";

  nodes.machine = { config, pkgs, ... }: {
    imports = [ self.nixosModules.default ];

    services.gone-to-plaid-sync = {
      enable = true;
      port = 8085;
      dataDir = "/var/lib/gone-to-plaid-sync";
    };
  };

  testScript = ''
    start_all()
    machine.wait_for_unit("gone-to-plaid-sync.service")
    machine.wait_for_open_port(8085)
    machine.wait_for_unit("gone-to-plaid-sync-trigger.timer")

    # Verify the API responds with valid JSON status
    status = machine.succeed("curl -fs http://127.0.0.1:8085/api/status")
    assert '"port":8085' in status, f"Expected port 8085 in response, got: {status}"
    assert '"used":0' in status, f"Expected 0 used items, got: {status}"
  '';
}
