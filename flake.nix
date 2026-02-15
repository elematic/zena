{
  description = "Zena - A statically typed language targeting WASM-GC";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        nodejs = pkgs.nodePackages_latest.nodejs;

        zena = pkgs.buildNpmPackage {
          pname = "zena";
          version = "0.0.1";

          src = ./.;

          npmDepsHash = "sha256-2bFhkmc2bAS/ITyf2WO4Za0gH229Do9+b+s8byqD+6c=";

          nativeBuildInputs = [ nodejs ];

          buildPhase = ''
            runHook preBuild
            npm run build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out/lib/zena
            cp -r packages $out/lib/zena/
            cp -r node_modules $out/lib/zena/
            cp package.json $out/lib/zena/

            mkdir -p $out/bin
            cat > $out/bin/zena << EOF
            #!${pkgs.bash}/bin/bash
            exec ${nodejs}/bin/node $out/lib/zena/packages/cli/lib/cli.js "\$@"
            EOF
            chmod +x $out/bin/zena

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Zena programming language compiler";
            homepage = "https://github.com/nicolo-ribaudo/zena-lang";
            license = licenses.mit;
            mainProgram = "zena";
          };
        };
      in
      {
        packages = {
          default = zena;
          zena = zena;
        };

        apps = {
          default = flake-utils.lib.mkApp {
            drv = zena;
            name = "zena";
          };
          zena = flake-utils.lib.mkApp {
            drv = zena;
            name = "zena";
          };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            nodejs
            pkgs.wasmtime
            pkgs.wasm-tools
            pkgs.cloc
          ];

          shellHook = ''
            echo "Zena development environment"
            echo "Node.js version: $(node --version)"
            echo "npm version: $(npm --version)"
            echo "wasmtime version: $(wasmtime --version)"
            echo "wasm-tools version: $(wasm-tools --version)"
            echo ""
            echo "Run 'npm install' to install dependencies"
            echo "Run 'npm run build' to build the compiler"
            echo "Run 'npm test' to run tests"
          '';
        };
      }
    );
}
