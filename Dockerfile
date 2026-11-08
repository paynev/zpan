# syntax=docker/dockerfile:1.7

FROM node:24-slim AS builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    corepack enable \
 && pnpm install --frozen-lockfile

# Copy only what the JS build (vite + tsup) and the final server image consume.
# Keep in sync with the build inputs + the final-stage COPYs.
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY migrations ./migrations
COPY scripts ./scripts
COPY skills ./skills
# .git is excluded from the build context, so git describe cannot run here.
# The release workflow passes the tag via APP_VERSION and the commit SHA via
# APP_COMMIT; resolveAppVersion/resolveAppCommit read them.
ARG APP_VERSION=dev
ENV ZPAN_APP_VERSION=${APP_VERSION}
ARG APP_COMMIT=
ENV ZPAN_APP_COMMIT=${APP_COMMIT}
RUN pnpm build:node \
 && pnpm prune --prod --ignore-scripts

FROM node:24-slim
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && addgroup --system zpan \
 && adduser --system --ingroup zpan --home /home/zpan zpan \
 && mkdir -p /home/zpan/.local/share/zpan

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts/docker-entrypoint.sh /app/scripts/docker-entrypoint.sh

RUN mkdir -p /data /home/zpan/.config/zpan \
 && chown -R zpan:zpan /data /home/zpan

USER zpan

ENV NODE_ENV=production
ENV HOME=/home/zpan
ENV PORT=8222
# Lets the app report its deployment platform as "docker" (Cloud Run overrides
# this via K_SERVICE, which entry-node checks first).
ENV ZPAN_RUNTIME=docker
EXPOSE 8222

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "dist-server/entry-node.js"]
