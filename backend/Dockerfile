# Build context: repository root (needs shared/contracts and database/migrations).
#   docker build -f backend/Dockerfile -t aviator-backend .
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/contracts/package.json shared/contracts/
COPY backend/package.json backend/
# The lockfile lists every workspace; their manifests must exist even though they are not installed.
COPY admin-web/package.json admin-web/
COPY extension/package.json extension/
RUN npm ci --workspace @aviator/backend --workspace @aviator/contracts --include-workspace-root=false --ignore-scripts
COPY shared/contracts shared/contracts
COPY backend backend
RUN npm run build -w @aviator/contracts && npm run build -w @aviator/backend \
 && npm prune --omit=dev --workspace @aviator/backend --workspace @aviator/contracts

FROM node:24-alpine
ENV NODE_ENV=production MIGRATIONS_DIR=/app/database/migrations
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/contracts/package.json ./shared/contracts/package.json
COPY --from=build /app/shared/contracts/dist ./shared/contracts/dist
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
COPY database/migrations ./database/migrations
USER app
WORKDIR /app/backend
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/v1/health >/dev/null || exit 1
CMD ["node", "dist/src/server.js"]
