# Image for the policy-republisher / policy-bundle-age-check Cloud Run jobs
# (scripts/republish-policy-bundle.ts). Build context is a STAGED directory that
# deploy-policy-republisher.sh assembles from registryV2/: package files plus
# the three scripts the republisher imports. No policy source and no signing key
# are baked in — the job re-signs the live payload and mounts the key from
# Secret Manager at runtime.
ARG NODE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
RUN chown -R node:node /app
USER node
ENTRYPOINT ["node_modules/.bin/tsx", "scripts/republish-policy-bundle.ts"]
