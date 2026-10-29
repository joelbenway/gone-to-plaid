# Copyright (c) Joel Benway
# SPDX-License-Identifier: MIT

{
  description = "gone-to-plaid: Ludicrous-speed Plaid-to-Actual Budget bridge";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      rec {
        packages.default = pkgs.buildNpmPackage {
          pname = "gone-to-plaid";
          version = "1.0.0";
          src = ./.;

          npmDepsHash = "sha256-J+0rMKcpIi/lBLmlm687ySm3Ba3bvwDyGk0GQ32bDvM=";

          buildPhase = ''
            npm run build
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/gone-to-plaid
            cp -r dist node_modules package.json $out/lib/gone-to-plaid/
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/gone-to-plaid \
              --add-flags "$out/lib/gone-to-plaid/dist/index.js"
          '';

          nativeBuildInputs = [ pkgs.makeWrapper pkgs.python3 ];
        };

        packages.gone-to-plaid = packages.default;

        apps.default = {
          type = "app";
          program = "${packages.default}/bin/gone-to-plaid";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_22
            pkgs.typescript
          ];
        };

        checks = {
          package = packages.default;
        } // (pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          nixosTest = import ./nix/test.nix { inherit pkgs self; };
        });
      }
    ) // {
      nixosModules.default = import ./nix/module.nix self;
      nixosModules.gone-to-plaid = self.nixosModules.default;
      overlays.default = final: prev: {
        gone-to-plaid = self.packages.${prev.system}.default;
      };
    };
}
