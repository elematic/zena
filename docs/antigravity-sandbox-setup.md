# Antigravity Sandbox Setup Guide

This guide documents how to configure and run the Zena codebase inside the **Antigravity IDE**'s sandboxed terminal environment. The sandbox secures terminal tool execution by isolating network access, filesystem boundaries, and IPC mechanisms.

To get full builds, dependencies (`cargo build`), and test runs (`npm test`) working seamlessly inside the sandbox, follow the settings and approvals outlined below.

---

## 1. Directory Permissions & Sandbox Approvals

The macOS filesystem canonicalizes several root paths to their APFS physical volumes (e.g. `/Users` maps to `/System/Volumes/Data/Users`). When the IDE asks for sandbox permissions, **always provide the absolute, physical paths** to prevent permission failures.

Add the following locations to your IDE terminal's sandbox access approval list (replacing `<user>` with your username):

### Project Cache and Cargo Home

Allows Cargo to read/write shared compile caches and lock files securely within the repository directory.

- `/System/Volumes/Data/Users/<user>/Projects/Zena` (and its subdirectories)
- `/System/Volumes/Data/Users/<user>/Projects/Zena/.cargo`

### Direnv Allowance

Allows `direnv` to read and write its signature allowance database so it can load `.envrc` environment variables inside the sandboxed shell.

- `/System/Volumes/Data/Users/<user>/.local`
- `/System/Volumes/Data/Users/<user>/.local/share/direnv`

### Nix Daemon socket (optional/host)

Required if you want the sandboxed shell to access the global Nix daemon (e.g. for `use flake` evaluations).

- `/System/Volumes/Data/nix/var/nix/daemon-socket/socket`
- `/System/Volumes/Data/nix/var/nix/daemon-socket`

---

## 2. Proxy & SSL Interception Handling

To permit outbound traffic (e.g. fetching crates from `crates.io` or checking npm packages), the Antigravity sandbox transparently proxies port 443 TCP connections through a local intercepting proxy. This proxy presents a dynamically generated self-signed certificate.

Without proper trust configuration, Cargo will fail with:
`[60] SSL peer certificate or SSH remote key was not OK (self signed certificate in certificate chain)`

### The Solution: Dynamic CARGO_HTTP_CAINFO

The IDE exports the dynamic certificate location in the `$SSL_CERT_FILE` environment variable at shell startup. We map this dynamically to Cargo's CA bundle config via `.envrc`:

```bash
# Preserve IDE terminal sandbox proxy and cert configuration
export HTTP_PROXY=$HTTP_PROXY
export HTTPS_PROXY=$HTTPS_PROXY
export http_proxy=$http_proxy
export https_proxy=$https_proxy
export SSL_CERT_FILE=$SSL_CERT_FILE
export CURL_CA_BUNDLE=$CURL_CA_BUNDLE
export CARGO_HTTP_CAINFO=$SSL_CERT_FILE
```

This ensures Cargo automatically trusts the dynamic proxy certificate generated for the current session.

---

## 3. Nix-Pinned Toolchain (Local Environment Caching)

Because the macOS sandbox blocks Unix socket connection attempts to the Nix daemon, the Nix flake devShell cannot load live inside the sandboxed terminal.

To ensure all core development tools (such as `node`, `npm`, `wasmtime`, `wasm-tools`, `cargo`, and `rustc`) resolve to the exact local, version-aligned Nix flake binaries:

1. **Generate the local environment cache**:
   Run the following command once in your **unsandboxed integrated terminal** (or host shell):
   ```bash
   nix print-dev-env --extra-experimental-features "nix-command flakes" > .nix-env.rc
   ```
2. **Dynamic sourcing in `.envrc`**:
   The workspace `.envrc` automatically detects and sources `.nix-env.rc` if present, bypassing the daemon connection block completely:
   ```bash
   if [ -f .nix-env.rc ]; then
     source .nix-env.rc
   else
     use flake
   fi
   ```
3. **Keep the cache updated**:
   If `flake.nix` or `flake.lock` are updated on the project, simply regenerate the `.nix-env.rc` file by running the command in step 1 again. The `.nix-env.rc` file is already added to `.gitignore` so it will never be checked into the repository.
