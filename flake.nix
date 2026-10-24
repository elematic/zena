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
        #
        # Copied rather than symlinked: the check that reads this tree is a
        # Zena program under WASI, and cap-std refuses to follow a symlink to
        # an absolute path, so a linkFarm root reads as empty to it.
        witCorpus = pkgs.runCommand "zena-wit-corpus" { } ''
          mkdir -p $out
          ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList
            (name: src: ''
              cp -R --no-preserve=mode,ownership ${pkgs.fetchzip {
                url = src.url;
                hash = src.nixHash;
              }} $out/${name}
            '')
            witCorpusPin.sources)}
        '';

        wasmtime =
          let
            suffix = {
              "x86_64-linux" = "x86_64-linux";
              "aarch64-linux" = "aarch64-linux";
              "x86_64-darwin" = "x86_64-macos";
              "aarch64-darwin" = "aarch64-macos";
            }.${system} or (throw "Unsupported system: ${system}");

            hash = {
              "x86_64-linux" = "03f4y0vimbkh635jxzvza1x25i9r90hjy6b99pisw86a7vxs0czm";
              "aarch64-linux" = "1xbr8ji1zqdapv77jpavkqv7lnaqd95m2jvs1l9fn9wldyydq4w7";
              "x86_64-darwin" = "03kd9a1zp77vyykvfb2vrlyzvqqjqgkn1p63kp9ihnmsws3kk2xj";
              "aarch64-darwin" = "0iyg62js6j0vpv5v6i6aia37x4rxmh4354wy1c6g99f8lpqqrmrn";
            }.${system} or "";
          in
          pkgs.stdenv.mkDerivation rec {
            pname = "wasmtime";
            version = "48.0.5";

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

          inherit nodejs;

          # Read the per-package URLs and integrity hashes from
          # package-lock.json rather than maintaining a separate fixed-output
          # npmDepsHash, which went stale even when a commit only added a
          # workspace under packages/.
          npmDeps = pkgs.importNpmLock {
            npmRoot = ./.;
          };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;

          # Don't run dependency install scripts. buildNpmPackage runs `npm
          # rebuild` after the install, which executes any it finds: esbuild's
          # install.js and @vscode/vsce-sign's postinstall.js each reach for a
          # platform binary, and ignore-sync runs husky. The hermetic sandbox
          # has no network, and nothing the compiler or its test suite imports
          # uses any of the three. Without this the build only ever succeeded
          # by substituting a cached output.
          npmRebuildFlags = [ "--ignore-scripts" ];

          # `npm run build` compiles the Rust crates (packages/zena-cli,
          # packages/zena-run, packages/zenafx, and the packages/zena-runtime
          # library they share, `cargo build --release`). Vendor their crates
          # from Cargo.lock so cargo runs offline in the sandbox;
          # cargoSetupHook wires up CARGO_HOME + the vendored registry.
          cargoDeps = pkgs.rustPlatform.importCargoLock {
            lockFile = ./Cargo.lock;
            outputHashes = {
              "frame-buffer-wasmtime-0.3.0" = "sha256-H4aCxBhb0L59/9JY1L0ZMIjFEsULOd/6sDdk0HKLP4E=";
              "surface-wasmtime-0.3.0" = "sha256-H4aCxBhb0L59/9JY1L0ZMIjFEsULOd/6sDdk0HKLP4E=";
              "wasi-gfx-runtime-shared-0.3.0" = "sha256-H4aCxBhb0L59/9JY1L0ZMIjFEsULOd/6sDdk0HKLP4E=";
              "wasi-webgpu-wasmtime-0.3.0" = "sha256-H4aCxBhb0L59/9JY1L0ZMIjFEsULOd/6sDdk0HKLP4E=";
            };
          };

          nativeBuildInputs = [
            pkgs.cargo
            pkgs.rustc
            pkgs.rustPlatform.cargoSetupHook
            # zenafx's text stack (parley -> fontique) links the system
            # fontconfig on Linux, found through pkg-config at build time.
            pkgs.pkg-config
          ];
          buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.fontconfig ];

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

            # Standalone runtime binaries that run compiled modules:
            mkdir -p $out/bin
            cp target/release/zena-run $out/bin/zena-run
            cp target/release/zfx $out/bin/zfx

            # The zena command is zena-cli (Rust/wasmtime host) running the
            # CLI module the build produced
            # (packages/zena-cli/out/zena.wasm), which has the compiler in
            # it. ZENA_REPO_ROOT locates the module and the stdlib; it
            # defaults to the installed tree and can be overridden to point
            # at a checkout.
            cat > $out/bin/zena << EOF
            #!${pkgs.bash}/bin/bash
            export ZENA_REPO_ROOT="\''${ZENA_REPO_ROOT:-$out/lib/zena}"
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

          # The install phase is inherited rather than stubbed out, so this
          # one derivation covers packaging too and `checks` needs only this
          # one. See the comment on `checks`.
        });
        # On Darwin, `stage:docker` cross-compiles `zena-run` to
        # `x86_64-unknown-linux-gnu` via `cargo zigbuild`. Nixpkgs' default
        # `pkgs.rustc` only carries the native Darwin sysroot, so we pair the
        # prebuilt official rustc with the official `x86_64-unknown-linux-gnu`
        # `rust-std` tarball and `zig 0.14` (zig 0.16 has an ELF section-symbol
        # regression on zstd-sys).
        darwinLinuxStd = pkgs.fetchzip {
          url = "https://static.rust-lang.org/dist/rust-std-${pkgs.rustc.version}-x86_64-unknown-linux-gnu.tar.xz";
          hash = "sha256-vOns6L8nwZKocWFJaE1yb3nc6ugDwJJNRacdmAxdl2A=";
        };

        darwinPrebuiltRustc = pkgs.rust.packages.prebuilt.rustc-unwrapped;

        darwinCrossSysroot = pkgs.runCommand "rustc-sysroot-${pkgs.rustc.version}" { } ''
          mkdir -p $out/lib/rustlib
          ln -s ${darwinPrebuiltRustc}/bin $out/bin
          for item in ${darwinPrebuiltRustc}/lib/*; do
            if [ "$(basename "$item")" != "rustlib" ]; then
              ln -s "$item" $out/lib/
            fi
          done
          for item in ${darwinPrebuiltRustc}/lib/rustlib/*; do
            if [ "$(basename "$item")" != "x86_64-unknown-linux-gnu" ]; then
              ln -s "$item" $out/lib/rustlib/
            fi
          done
          ln -s ${darwinLinuxStd}/rust-std-x86_64-unknown-linux-gnu/lib/rustlib/x86_64-unknown-linux-gnu \
            $out/lib/rustlib/x86_64-unknown-linux-gnu
        '';

        darwinCrossRustc = pkgs.writeShellScriptBin "rustc" ''
          has_sysroot=0
          is_linux_target=0
          prev_target=0
          for arg in "$@"; do
            if [ "$prev_target" = 1 ]; then
              case "$arg" in
                *linux*) is_linux_target=1 ;;
              esac
              prev_target=0
            fi
            case "$arg" in
              --sysroot|--sysroot=*) has_sysroot=1 ;;
              --target) prev_target=1 ;;
              --target=*linux*) is_linux_target=1 ;;
              --) break ;;
            esac
          done
          extra=()
          if [ "$has_sysroot" = 0 ]; then
            extra+=(--sysroot "${darwinCrossSysroot}")
          fi
          if [ "$is_linux_target" = 0 ]; then
            extra+=(-L "${pkgs.libiconv}/lib")
          fi
          exec "${darwinPrebuiltRustc}/bin/rustc" "''${extra[@]}" "$@"
        '';

        darwinCargoZigbuild = pkgs.writeShellScriptBin "cargo-zigbuild" ''
          export PATH="${pkgs.zig_0_14}/bin:$PATH"
          export RUSTC="${darwinCrossRustc}/bin/rustc"
          unset RUSTFLAGS
          exec "${pkgs.cargo-zigbuild}/bin/.cargo-zigbuild-wrapped" "$@"
        '';
      in
      {
        packages = {
          default = zena;
          zena = zena;
        };

        # Only the test derivation. `zena-tests` is `zena` with the suite
        # appended, so listing both made `nix flake check` run the entire
        # toolchain build twice, concurrently, for one build's worth of
        # signal. On the deprioritised homelab CI guest that doubled peak
        # memory and was enough to get the job killed mid-build.
        checks = {
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
          zfx = flake-utils.lib.mkApp {
            drv = zena;
            name = "zfx";
          };
        };

        devShells.default = pkgs.mkShell {
          nativeBuildInputs = [ pkgs.pkg-config ];
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
            # Keeps packages/workspace-hack in step with Cargo.lock, so
            # every binary resolves the same features for the crates they
            # share (`cargo hakari generate`, see DEVELOPMENT.md).
            pkgs.cargo-hakari
          ] ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
            pkgs.libiconv
            pkgs.zig_0_14
            darwinCargoZigbuild
          ]
            # zenafx's text stack links the system fontconfig on Linux.
            ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.fontconfig ];

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

        # Node and nothing else, for work that needs neither Rust nor
        # wasmtime. `npm run format:check` runs prettier out of node_modules,
        # and the default shell's closure is 3.02 GB across 159 paths because
        # it carries rustc, LLVM and gcc, so CI's format job was downloading a
        # Rust toolchain to run a formatter. mkShellNoCC rather than mkShell,
        # which would put a C compiler and binutils back in.
        devShells.format = pkgs.mkShellNoCC {
          buildInputs = [ nodejs ];
        };

        # The Firebase emulators, for `npm run emulators:start` (a wireit
        # service that enters this shell itself) and the suites that depend
        # on it. firebase-tools' closure is 1.4 GiB and the JDK's 618 MiB,
        # so they stay out of the default shell, which CI downloads.
        devShells.emulators = pkgs.mkShellNoCC {
          buildInputs = [ pkgs.firebase-tools pkgs.jdk21_headless ];
        };
      }
    );
}
