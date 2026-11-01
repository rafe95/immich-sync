# --- build: install everything, build the frontend ---------------------------
# Runs on the builder's own platform: the frontend bundle is architecture-independent, so a multi-arch
# build does not emulate the whole frontend build under QEMU.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY core/package.json core/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# --- runtime: backend + core sources, built frontend --------------------------
FROM oven/bun:1.4.2-alpine
LABEL org.opencontainers.image.title="immich-sync" \
      org.opencontainers.image.description="Copy and move photos between Immich servers, with scheduled and batch jobs." \
      org.opencontainers.image.source="https://github.com/rafe95/immich-sync" \
      org.opencontainers.image.url="https://github.com/rafe95/immich-sync" \
      org.opencontainers.image.version="" \
      org.opencontainers.image.revision="" \
      org.opencontainers.image.created="" \
      org.opencontainers.image.licenses=""
# The empty values above replace labels inherited from the Bun base image; the release workflow
# fills in version, revision and created. The licence is not chosen yet.
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/frontend/dist
COPY package.json bun.lock ./
COPY core/package.json core/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN bun install --frozen-lockfile --production
COPY core/src core/src
COPY backend/src backend/src
COPY --from=build /app/frontend/dist frontend/dist
# Sources copied from a host with restrictive permissions (e.g. 600) must stay readable by the non-root user.
RUN chmod -R a+rX /app
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["bun", "backend/src/index.ts"]
