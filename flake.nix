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

          npmDepsHash = "sha256-JWWaf3MFCMi7f+U0zuG7Sr2zIXBwJz5DqgQH0Ga7Pjo=";

          # Don't compile native addons. buildNpmPackage runs `npm rebuild`
          # after the install, which tries to build keytar's native binding
          # (`prebuild-install || node-gyp rebuild`) — pulled in transitively
          # for the VS Code extension's credential storage. It needs network
          # (prebuild-install) or pkg-config + libsecret (node-gyp), neither of
          # which exists in the hermetic sandbox, and nothing the compiler or
          # its test suite imports actually uses it. Without this the build only
          # ever succeeded by substituting a cached output.
          npmRebuildFlags = [ "--ignore-scripts" ];

          # `npm run build` compiles the Rust self-hosted CLI
          # (packages/zena-cli, `cargo build --release`). Vendor its crates
          # from Cargo.lock so cargo runs offline in the sandbox; cargoSetupHook
          # wires up CARGO_HOME + the vendored registry. (No git sources in the
          # lockfile, so no per-crate outputHashes are needed.)
          cargoDeps = pkgs.rustPlatform.importCargoLock {
            lockFile = ./Cargo.lock;
          };

          nativeBuildInputs = [
            nodejs
            pkgs.cargo
            pkgs.rustc
            pkgs.rustPlatform.cargoSetupHook
          ];

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

        # Hermetic test suite: reuse the compiler's vendored npm deps and build,
        # then run the full `npm test` (all package suites via wireit) with
        # wasmtime + wasm-tools on PATH so the WASI/self-hosted suites actually
        # execute rather than being skipped (run-wasmtime.js only *warns* when
        # `which wasmtime` fails). `nix flake check` builds this, so CI gets a
        # real test signal, not just "the compiler compiles".
        zena-tests = zena.overrideAttrs (old: {
          pname = "zena-tests";

          nativeBuildInputs = old.nativeBuildInputs ++ [
            wasmtime
            pkgs.wasm-tools
          ];

          # Run the suite after the existing build phase. wireit rebuilds into a
          # fresh .wireit cache inside the sandbox, so this is self-contained.
          postBuild = ''
            npm test
          '';

          # We only care that the tests passed; nothing downstream consumes the
          # output, so keep it minimal instead of packaging the CLI.
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            echo "zena test suite passed" > $out/result
            runHook postInstall
          '';
        });
      in
      {
        packages = {
          default = zena;
          zena = zena;
        };

        checks = {
          inherit zena;
          test = zena-tests;
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
          ] ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];

          # Every Rust binary on darwin links -liconv, but cargo invokes the
          # system `cc` as the linker, which reads neither NIX_LDFLAGS nor
          # finds libiconv in the nix apple-sdk SDKROOT. Point rustc at the
          # nix libiconv explicitly.
          env = pkgs.lib.optionalAttrs pkgs.stdenv.isDarwin {
            RUSTFLAGS = "-L${pkgs.libiconv}/lib";
          };

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
