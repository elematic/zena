# Container image for the Zena documentation site.
#
# Packages the pre-built site (_site/) and static server into a minimal runtime image.
# Build on the host first: npm run build -w @zena-lang/website
#
#   Build locally:          npm run docker:build
#   Run locally:            npm run docker:run
#   Deploy to Cloud Run:    npm run deploy

FROM node:26-slim

WORKDIR /app

# Only the generated site and the static server. No node_modules: the server
# has no dependencies.
COPY _site ./_site
COPY serve-static.js ./serve-static.js

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node

# Serving static files needs very little heap. The flag keeps V8 from sizing
# its heap against the host's total RAM, which Node cannot see is capped by the
# container. Keep it at ~75% of the Cloud Run memory setting (512Mi).
CMD ["node", "--max-old-space-size=384", "serve-static.js"]
