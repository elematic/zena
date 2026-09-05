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

        # Real-world WIT the parser is checked against (see
        # packages/wit-parser/wit-corpus.json, which is the single source of
        # truth for the URLs — dev/fetch-wit-corpus.js reads the same file for
        # checkouts that are not using Nix).
        #
        # Third-party WIT with its own license, so it is fetched rather than
        # vendored. fetchzip hashes the unpacked tree, which is what we want:
        # GitHub regenerates archives and the gzip framing changes even when no
        # file does.
        witCorpusPin = builtins.fromJSON
          (builtins.readFile ./packages/wit-parser/wit-corpus.json);

        # One root holding every pinned source as <root>/<name>, matching the
        # layout dev/fetch-wit-corpus.js produces, so the checks address a
        # source the same way however it arrived.
        witCorpus = pkgs.linkFarm "zena-wit-corpus" (pkgs.lib.mapAttrsToList
          (name: src: {
            inherit name;
            path = pkgs.fetchzip {
              url = src.url;
              hash = src.nixHash;
            };
          })
          witCorpusPin.sources);

        wasmtime =
          let
            suffix = {
              "x86_64-linux" = "x86_64-linux";
              "aarch64-linux" = "aarch64-linux";
              "x86_64-darwin" = "x86_64-macos";
              "aarch64-darwin" = "aarch64-macos";
            }.${system} or (throw "Unsupported system: ${system}");

            hash = {
              "x86_64-linux" = "13vn1zdq6fdvmy461dh1s06wzrc361fksdx01dkk68rpp90qcvj4";
              "aarch64-linux" = "130a2swwgnf2klfbds9hcdrznq798dn9f78qqrdyw74swiw142yy";
              "x86_64-darwin" = "0ri5f3h8sdnh921bm2fd16zncw1mxanjcfm3b917icr1d9hl2i5q";
              "aarch64-darwin" = "0x7lvn3vgn83mgpl6mciw412irqlcaigpdxfl6rpi19b63ck06j2";
            }.${system} or "";
          in
          pkgs.stdenv.mkDerivation rec {
            pname = "wasmtime";
            version = "47.0.4";

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

          npmDepsHash = "sha256-QwfgUfBjaX+BH7lrUFg9vyG5TAxMMJspvLoSD8dpDVY=";

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
            cp package.json $out/lib/zena/
            cp target/release/zena-cli $out/lib/zena/zena-cli

            # The zena command is zena-cli (Rust/wasmtime host) running the
            # compiler the build produced. ZENA_REPO_ROOT locates the stdlib
            # and source files, ZENA_COMPILER_WASM the compiler; both default
            # to the installed tree and can be overridden to point at a
            # checkout (zena-cli only compiles files under ZENA_REPO_ROOT).
            mkdir -p $out/bin
            cat > $out/bin/zena << EOF
            #!${pkgs.bash}/bin/bash
            export ZENA_REPO_ROOT="\''${ZENA_REPO_ROOT:-$out/lib/zena}"
            export ZENA_COMPILER_WASM="\''${ZENA_COMPILER_WASM:-$out/lib/zena/packages/zena-compiler/zena/out/cli.wasm}"
            exec $out/lib/zena/zena-cli "\$@"
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

          # The sandbox has no network, so the wit-parser's real-WIT check
          # cannot fetch its corpus — hand it the same fetchzip'd tree the dev
          # shell uses. Without this the check fails closed, by design.
          ZENA_WASI_WIT = "${witCorpus}";

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
          env = {
            # Where packages/wit-parser's real-WIT check finds its corpus, so a
            # Nix shell never needs the network or a fetch step.
            ZENA_WASI_WIT = "${witCorpus}";
          } // pkgs.lib.optionalAttrs pkgs.stdenv.isDarwin {
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
            echo "WASI WIT corpus: $ZENA_WASI_WIT"
          '';
        };
      }
    );
}
