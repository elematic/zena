# The image of both services: the App View, registry.wasm, built from
# zena/main.zena, and padstone, pds.wasm, built from
# packages/pds/zena/main.zena; the zena-run host binary, which runs them;
# and the web app (packages/pds-web), which the App View serves from /web.
# It runs the App View; padstone's service runs pds.wasm instead
# (deploy.sh).
#
#   Build locally:          npm run docker:build -w @zena-lang/registry
#   Deploy to Cloud Run:    npm run deploy -w @zena-lang/registry (deploy/deploy.sh)
#
# Their configuration comes from the environment (registry:service and
# pds:service), which deploy.sh sets. zena-run brings its own TLS roots, so
# the image needs no CA certificates for the Google APIs it calls.

FROM debian:trixie-slim

WORKDIR /app

COPY zena-run registry.wasm pds.wasm ./
COPY web ./web

# Compiled to native code at build time, so a cold start loads them
# directly rather than running Cranelift.
RUN /app/zena-run --precompile /app/registry.wasm && /app/zena-run --precompile /app/pds.wasm

ENV HOST=0.0.0.0
ENV PORT=8080
ENV APP_VIEW_WEB_DIR=/web
# The servers read URLs other people chose (the PDS a DID document names),
# so zena-run connects only to public addresses, and refuses a public
# name pointed at a private one. The metadata server, which is link-local,
# gives the service its Google credentials.
ENV ZENA_DENY_PRIVATE_EGRESS=1
ENV ZENA_ALLOW_EGRESS=metadata.google.internal
EXPOSE 8080

USER www-data

CMD ["/app/zena-run", "--dir", "/app/web::/web", "/app/registry.wasm"]
