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

        nodejs = pkgs.nodejs_latest;

        wasmtime =
          let
            suffix = {
              "x86_64-linux" = "x86_64-linux";
              "aarch64-linux" = "aarch64-linux";
              "x86_64-darwin" = "x86_64-macos";
              "aarch64-darwin" = "aarch64-macos";
            }.${system} or (throw "Unsupported system: ${system}");

            hash = {
              "x86_64-linux" = "1gypkwyz6mms85psgh33nfq2h68bpnicxjyhp2vdi6nx3qs8dk1a";
              "aarch64-linux" = "1xpisz5qf2bqscyr2bf1hj43vswlymkwv33jinfmywsygpxx2bwv";
              "x86_64-darwin" = "0qpp5dxpg0dvqya31br6vg4clam0fncygfn1y65488s7v48q87bq";
              "aarch64-darwin" = "09fdppfwqr0pzh338r6disvw94848ghcdkciv9f298s2xavdljxb";
            }.${system} or "";
          in
          pkgs.stdenv.mkDerivation rec {
            pname = "wasmtime";
            version = "46.0.0";

            src = pkgs.fetchurl {
              url = "https://github.com/bytecodealliance/wasmtime/releases/download/v${version}/wasmtime-v${version}-${suffix}.tar.xz";
              sha256 = hash;
            };

            dontBuild = true;
            dontConfigure = true;

            nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];
            # The release binary links against libgcc_s.so.1; give autoPatchelf
            # the gcc runtime libs to resolve it against.
            buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.stdenv.cc.cc.lib ];

            installPhase = ''
              mkdir -p $out/bin
              find . -type f -name "wasmtime" -exec cp {} $out/bin/ \;
              chmod +x $out/bin/wasmtime
            '';
          };

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
            wasmtime
            pkgs.wasm-tools
            pkgs.cloc
            pkgs.hyperfine
            pkgs.cargo
            pkgs.rustc
            pkgs.rustfmt
            pkgs.rust-analyzer
          ];

          shellHook = ''
            unset DEVELOPER_DIR
            echo "Zena development environment"
            echo "Node.js version: $(node --version)"
            echo "npm version: $(npm --version)"
            echo "wasmtime version: $(wasmtime --version)"
            echo "wasm-tools version: $(wasm-tools --version)"
            echo "rustc version: $(rustc --version)"
            echo ""
            echo "Run 'npm install' to install dependencies"
            echo "Run 'npm run build' to build the compiler"
            echo "Run 'npm test' to run tests"
          '';
        };
      }
    );
}
