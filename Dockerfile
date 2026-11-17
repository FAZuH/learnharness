# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=cache,target=/root/.npm \
    npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY --from=deps /src/node_modules ./node_modules
COPY . .
RUN npm run plugins:setup \
 && npm run build \
 && node scripts/build-server.mjs

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    LH_DATA_DIR=/data \
    LH_AUTH_FILE=/data/auth.json
RUN groupadd --system --gid 1001 appuser \
 && useradd --system --uid 1001 --gid appuser --create-home appuser \
 && mkdir -p /data \
 && chown 1001:1001 /data
COPY --from=build --chown=1001:1001 /src/.next/standalone/ /app/
EXPOSE 3000
LABEL org.opencontainers.image.source=https://github.com/amosblomqvist/learnharness
USER 1001:1001
CMD ["node", "server.js"]
