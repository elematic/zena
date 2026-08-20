# Container image for the Zena documentation site.
#
# This file lives in the package it builds, but every path below is relative to
# the REPO ROOT, which is the build context. Build it from the root with -f:
#
#   docker build -f packages/website/Dockerfile -t zena-website .
#
# The context has to be the root because building the site builds most of the
# toolchain: the site embeds the compiler and the language server so the
# playground can typecheck and run code in the browser.
#
# It is a multi-stage build. The builder needs nearly every workspace package;
# the runtime stage needs none of them. The built site is entirely static --
# esbuild bundles the client into /js/zena.js and there are no bare module
# specifiers -- so the final image is Node plus _site/ and a dependency-free
# static server. Nothing else is carried over.
#
# Note that Node and Rust are required for the builder stage: `zena-cli` builds
# via Cargo, which executes the bootstrap compiler to produce `lsp.wasm` for the
# language service and playground.
#
#   Build and run locally:  npm run docker:run
#   Deploy to Cloud Run:    npm run deploy

# Node 26 to match the repo's `engines: {node: '>=25.0.0'}` and the flake.
FROM node:26-slim AS builder

# Install build dependencies and Rust toolchain for zena-cli
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    build-essential \
    ca-certificates \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app

# Manifests first, so the npm install layer is reused whenever only source
# files change. Each workspace's package.json has to be present for `npm ci`
# to resolve the workspace tree, hence the file-by-file copy: a wildcard COPY
# would flatten them into one directory.
COPY package.json package-lock.json ./
COPY packages/codemirror/package.json packages/codemirror/
COPY packages/language-service/package.json packages/language-service/
COPY packages/playground/package.json packages/playground/
COPY packages/runtime/package.json packages/runtime/
COPY packages/stdlib/package.json packages/stdlib/
COPY packages/vscode-zena/package.json packages/vscode-zena/
COPY packages/website/package.json packages/website/
COPY packages/website-client/package.json packages/website-client/
COPY packages/wit-parser/package.json packages/wit-parser/
COPY packages/zena-cli/package.json packages/zena-cli/
COPY packages/zena-compiler/package.json packages/zena-compiler/
COPY packages/zena-formatter/package.json packages/zena-formatter/

RUN npm ci

# Sources. .dockerignore keeps ./target (~7GB), node_modules and build output
# out of the context.
COPY . .

# wireit walks the dependency graph from here: stdlib, runtime, zena-cli via
# cargo, then lsp.wasm via the Zena CLI, then esbuild and Eleventy.
#
# NODE_ENV is set on this command rather than with ENV, deliberately. The
# esbuild config in eleventy.config.js minifies and drops sourcemaps only when
# NODE_ENV is 'production', but setting it for the whole stage would make the
# `npm ci` above omit devDependencies -- which is where eleventy, esbuild and
# typescript live.
RUN NODE_ENV=production npm run build -w @zena-lang/website

FROM node:26-slim AS runtime

WORKDIR /app

# Only the generated site and the static server. No node_modules: the server
# has no dependencies.
COPY --from=builder /app/packages/website/_site ./_site
COPY --from=builder /app/packages/website/serve-static.js ./serve-static.js

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node

# Serving static files needs very little heap. The flag keeps V8 from sizing
# its heap against the host's total RAM, which Node cannot see is capped by the
# container. Keep it at ~75% of the Cloud Run memory setting (512Mi).
CMD ["node", "--max-old-space-size=384", "serve-static.js"]
