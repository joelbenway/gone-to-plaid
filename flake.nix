{
  description = "gone-to-plaid-sync: Resilient Plaid-to-Actual Budget bridge";

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
          pname = "gone-to-plaid-sync";
          version = "1.0.0";
          src = ./.;

          npmDepsHash = "sha256-+ZAj+xxonwQtJHrLglRyWeoanSoCrnwzidH7sJ4qSts=";

          buildPhase = ''
            npm run build
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/gone-to-plaid-sync
            cp -r dist node_modules package.json $out/lib/gone-to-plaid-sync/
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/gone-to-plaid-sync \
              --add-flags "$out/lib/gone-to-plaid-sync/dist/index.js"
          '';

          nativeBuildInputs = [ pkgs.makeWrapper pkgs.python3 ];
        };

        packages.gone-to-plaid-sync = packages.default;

        apps.default = {
          type = "app";
          program = "${packages.default}/bin/gone-to-plaid-sync";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_22
            pkgs.typescript
          ];
        };
      }
    ) // {
      nixosModules.default = import ./nix/module.nix self;
      nixosModules.gone-to-plaid-sync = self.nixosModules.default;
      overlays.default = final: prev: {
        gone-to-plaid-sync = self.packages.${prev.system}.default;
      };
    };
}
