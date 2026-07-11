# Multi-arch base — builds and runs on both the Oracle Ampere ARM VM and
# x86 dev machines without a Dockerfile fork.
FROM node:22-alpine AS base
WORKDIR /repo
RUN corepack enable

# Full workspace manifest is needed even for an api-only install: pnpm
# resolves the lockfile against every package in pnpm-workspace.yaml.
FROM base AS manifests
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY bot/package.json ./bot/

FROM manifests AS deps
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY api ./api
RUN pnpm --filter @scribeflow/api build

FROM manifests AS prod-deps
RUN pnpm install --prod --frozen-lockfile --filter @scribeflow/api...

FROM node:22-alpine AS runtime
WORKDIR /repo/api
ENV NODE_ENV=production
COPY --from=prod-deps /repo/node_modules /repo/node_modules
COPY --from=prod-deps /repo/api/node_modules ./node_modules
COPY --from=build /repo/api/dist ./dist
COPY --from=build /repo/api/package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/index.js"]
