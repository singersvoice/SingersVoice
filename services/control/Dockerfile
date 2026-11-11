# sv-control: Hono + WebSocket on Node 22 (runs TypeScript directly, no build step).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY services/control/package.json services/control/
RUN npm ci --omit=dev --workspace services/control --include-workspace-root=false --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY packages/protocol ./packages/protocol
COPY services/control ./services/control
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "services/control/src/index.ts"]
