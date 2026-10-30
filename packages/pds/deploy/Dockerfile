# The package host's image: the server, pds.wasm, built from
# zena/main.zena; the zena-run host binary, which runs it; and the web app
# (packages/pds-web), which the server serves from /web.
#
#   Build locally:          npm run docker:build -w @zena-lang/pds
#   Deploy to Cloud Run:    npm run deploy -w @zena-lang/pds (deploy/deploy.sh)
#
# Its configuration comes from the environment (pds:service), which
# deploy.sh sets. zena-run brings its own TLS roots, so the image needs no
# CA certificates for the Google APIs it calls.

FROM debian:trixie-slim

WORKDIR /app

COPY zena-run pds.wasm ./
COPY web ./web

# Compiled to native code at build time, so a cold start loads it directly
# rather than running Cranelift.
RUN /app/zena-run --precompile /app/pds.wasm

ENV HOST=0.0.0.0
ENV PORT=8080
ENV PDS_WEB_DIR=/web
# The server reads URLs other people chose (the PDS a DID document names),
# so zena-run connects only to public addresses, and refuses a public
# name pointed at a private one. The metadata server, which is link-local,
# gives the service its Google credentials.
ENV ZENA_DENY_PRIVATE_EGRESS=1
ENV ZENA_ALLOW_EGRESS=metadata.google.internal
EXPOSE 8080

USER www-data

CMD ["/app/zena-run", "--dir", "/app/web::/web", "/app/pds.wasm"]
