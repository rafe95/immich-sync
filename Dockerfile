# --- build: install everything, build the frontend ---------------------------
FROM oven/bun:1.4.2-alpine AS build
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
WORKDIR /app
ENV NODE_ENV=production \
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
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["bun", "backend/src/index.ts"]
