# Container image for the Zena documentation site.
#
# Packages the pre-built site (_site/), the compiled Zena HTTP server component
# (server.wasm), and the zena-run host binary into a minimal runtime image.
#
#   Build locally:          npm run docker:build -w @zena-lang/website
#   Run locally:            npm run docker:run -w @zena-lang/website
#   Deploy to Cloud Run:    npm run deploy -w @zena-lang/website

FROM debian:trixie-slim

WORKDIR /app

COPY zena-run server.wasm ./
COPY _site ./_site

# Precompile server.wasm -> server.cwasm during the image build so container
# startup loads native code directly without invoking Cranelift.
RUN /app/zena-run --precompile /app/server.wasm

ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

USER www-data

CMD ["/app/zena-run", "--dir", "/app/_site::.", "/app/server.wasm"]
