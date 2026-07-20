# Small Node service (ticket 5.5) — dockerode talks to the host's Docker
# socket, nothing else infra-shaped runs in this image (no Xvfb/Chromium;
# that's bot/Dockerfile, a completely different, much heavier image built
# from the same package).
FROM node:22-alpine AS manifests
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY bot/package.json ./bot/

FROM manifests AS deps
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY bot ./bot
RUN pnpm --filter @scribeflow/bot build

FROM manifests AS prod-deps
RUN pnpm install --prod --frozen-lockfile --filter @scribeflow/bot...

FROM node:22-alpine AS runtime
WORKDIR /repo/bot
ENV NODE_ENV=production
COPY --from=prod-deps /repo/node_modules /repo/node_modules
COPY --from=prod-deps /repo/bot/node_modules ./node_modules
COPY --from=build /repo/bot/dist ./dist
COPY --from=build /repo/bot/package.json ./package.json
EXPOSE 8080
CMD ["node", "dist/orchestrator/index.js"]
