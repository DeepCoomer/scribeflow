# arm64 (Oracle Ampere VM); Apple Silicon dev machines are the same arch, so
# local `docker build`/run is representative (docs/meet-bot.md — Container
# anatomy). Headful Chromium on Xvfb, PulseAudio null sink, ffmpeg capture.
FROM node:22-bookworm-slim AS manifests
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

FROM node:22-bookworm-slim AS runtime
# Xvfb (virtual display Meet needs — headless Chromium is fingerprinted/
# blocked), PulseAudio (null sink), ffmpeg (segment capture), x11vnc +
# websockify (BOT_DEBUG_VNC=1 only, never started in prod compose).
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    pulseaudio \
    pulseaudio-utils \
    ffmpeg \
    x11vnc \
    novnc \
    websockify \
    fonts-liberation \
    ca-certificates \
    dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo/bot
ENV NODE_ENV=production DISPLAY=:99

COPY --from=prod-deps /repo/node_modules /repo/node_modules
COPY --from=prod-deps /repo/bot/node_modules ./node_modules
COPY --from=build /repo/bot/dist ./dist
COPY --from=build /repo/bot/package.json ./package.json

# Playwright's bundled Chromium build (linux/arm64 exists — Google Chrome
# proper does not ship linux/arm64, docs/meet-bot.md).
RUN npx --yes playwright install --with-deps chromium

COPY bot/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /rec

ENTRYPOINT ["/entrypoint.sh"]
