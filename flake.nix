{
  description = "org-fleet development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    repo-fleet.url = "git+ssh://git@github.com/hermetic-foundation/repo-fleet.git";
    repo-fleet.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      repo-fleet,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          packageJson = builtins.fromJSON (builtins.readFile ./package.json);
          repoFleet = repo-fleet.packages.${system}.repo-fleet;
          orgFleet = pkgs.buildNpmPackage {
            pname = "org-fleet";
            version = packageJson.version;
            src = ./.;
            npmDepsHash = "sha256-lAFjPthbKYfLmSnEV4IIZggvAHPZV4b5QbG6RVrFOaU=";
            nativeBuildInputs = [ pkgs.makeWrapper ];
            dontNpmBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/lib/org-fleet" "$out/bin"
              cp -R bin src package.json node_modules "$out/lib/org-fleet/"
              chmod +x "$out/lib/org-fleet/bin/org-fleet"
              makeWrapper "$out/lib/org-fleet/bin/org-fleet" "$out/bin/org-fleet" \
                --set ORG_FLEET_REPO_FLEET_BIN "${repoFleet}/bin/repo-fleet" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git pkgs.jujutsu pkgs.nodejs_24 ]}

              runHook postInstall
            '';

            meta = {
              description = "Manage repo-fleet manifests across multiple organizations";
              homepage = "https://github.com/hermetic-foundation/org-fleet";
              license = pkgs.lib.licenses.agpl3Plus;
              mainProgram = "org-fleet";
            };
          };
        in
        {
          org-fleet = orgFleet;
          default = orgFleet;
        }
      );

      apps = forAllSystems (
        system:
        {
          org-fleet = {
            type = "app";
            program = "${self.packages.${system}.org-fleet}/bin/org-fleet";
          };
          default = self.apps.${system}.org-fleet;
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.git
              pkgs.jujutsu
              pkgs.nodejs_24
              repo-fleet.packages.${system}.repo-fleet
            ];
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          package = self.packages.${system}.org-fleet;
          tests = pkgs.runCommand "org-fleet-tests" { nativeBuildInputs = [ pkgs.git pkgs.nodejs_24 ]; } ''
            cp -R ${./.} source
            chmod -R u+w source
            cd source
            cp -R ${self.packages.${system}.org-fleet}/lib/org-fleet/node_modules node_modules
            npm test
            npm run typecheck
            touch $out
          '';
        }
      );
    };
}
