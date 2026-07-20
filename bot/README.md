# bot

Google Meet bot (Playwright + Xvfb + PulseAudio, Docker) and its orchestrator
(dockerode + a small Fastify control plane), built in tickets 5.2–5.5 — see
[docs/meet-bot.md](../docs/meet-bot.md) for the spec and
[docs/plan.md](../docs/plan.md) for status. 5.6 (Fable, reserved for real-Meet
selector fixes) is the only ticket left in this phase.

```
src/
  config.ts, selectors.ts, launchProfile.ts   bot runtime
  platforms/                                  meet/zoom strategy interface
  joinFlow.ts, lifecycle.ts, capture.ts        join/leave state machines + ffmpeg capture
  controlPlaneClient.ts, main.ts               bot entrypoint
  orchestrator/                                spawn/reap service (its own entrypoint)
tests/                                         mock-Meet-page + fake-docker/queue/db tests
Dockerfile                                     bot container image (arm64, Xvfb+PulseAudio+Chromium)
orchestrator.Dockerfile                        orchestrator image (small Node service)
entrypoint.sh                                  PID-1 signal-forwarding entrypoint (D67)
```

```sh
pnpm --filter @scribeflow/bot test         # vitest — mock-page + fake-infra tests
pnpm --filter @scribeflow/bot typecheck
pnpm bot            # (from bot/) run the bot process locally against BOT_CONFIG
pnpm orchestrator    # (from bot/) run the orchestrator locally
```

Copy `.env.example` to `.env` for local runs of either process — see that file
for which variables belong to which. On the VM both come from the single
`.env` `infra/compose.yml` injects (the orchestrator runs as its own compose
service; bot containers are spawned dynamically by dockerode, never declared
as a compose service themselves).
