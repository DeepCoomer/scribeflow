# Google Meet Bot — design (ticket 5.1)

Google exposes no free recording API for Meet (recordings require paid Workspace
editions and land in the host's Drive). Every commercial notetaker (Read.ai,
Fireflies, Recall.ai) does what we do: **join the meeting as a visible participant
with a browser and capture the audio the browser plays.**

This document is the implementable spec for tickets 5.2–5.5, produced by the 5.1
design review after studying Vexa and screenappai/meeting-bot (D34). Decisions
made during the review are D67–D72.

## Prior art: what we took (and rejected)

- **Vexa** ([Vexa-ai/vexa](https://github.com/Vexa-ai/vexa), bot under
  `core/meetings/services/bot/`) — confirmed the container shape (headful
  Chromium on Xvfb + PulseAudio, ~2 GB), the stealth config (playwright-extra +
  stealth plugin with the `iframe.contentWindow` and `media.codecs` evasions
  disabled), and contributed the **PID-1 signal-forwarding entrypoint** fix:
  a bash entrypoint that is PID 1 neither dies on SIGTERM nor forwards it, so
  every `docker stop` escalated to SIGKILL (exit 137) mid-capture and the
  graceful leave never ran. Their in-page capture path (per-participant
  `<audio>` elements, `RTCPeerConnection` hook) exists for *live streaming*
  transcription — rejected for us (D67): our pipeline is async, and in-page
  capture dies with the page.
- **screenappai/meeting-bot** ([screenappai/meeting-bot](https://github.com/screenappai/meeting-bot),
  `src/bots/GoogleMeetBot.ts`) — the Meet-specific field lessons:
  - The "Leave call" button **exists while still in the lobby** — admission must
    be detected by a participant-count signal, not button presence (D71).
  - Meet sometimes silently expires or redirects the ask-to-join request
    ("No one responded to your request"); a bounded re-request loop is needed.
  - Their Google lane joins **device-less** ("Continue without microphone and
    camera") with a near-normal launch profile — "Google Meet is sensitive to
    browser fingerprinting before admission" — and fake-device flags are
    reserved for platforms that need them (D68).
  - Playwright launches Chromium with `--mute-audio` by default —
    **`ignoreDefaultArgs: ['--mute-audio']` is mandatory** or PulseAudio
    captures silence (D67).
  - ffmpeg is stopped gracefully via stdin `q`, then SIGTERM after 15 s, then
    SIGKILL after 5 more — copied into our shutdown ladder.
  - Removal is detected via `"You've been removed from the meeting"` body text;
    redirects off `meet.google.com` while waiting mean the request was dropped.

## Container anatomy (one container per meeting)

```
Docker container (ephemeral, ~2 GB RAM, arm64)
├─ entrypoint.sh   PID-1 bash: starts Xvfb/PulseAudio, runs bot in background,
│                  forwards SIGTERM/SIGINT to it, waits (Vexa's exit-137 fix)
├─ Xvfb            virtual display :99, 1280x800x24 (Meet needs a real surface;
│                  headless Chromium is fingerprinted/blocked by Meet)
├─ PulseAudio      null sink "meet_out" set as default sink — Chromium's audio
│                  output lands there; no real device exists in the container
├─ Chromium        Playwright's bundled build (linux/arm64 exists — Google
│                  Chrome proper does not ship linux/arm64), headful on Xvfb
├─ bot.ts          Playwright script: join flow, lifecycle, health, control
│                  calls to the orchestrator
└─ ffmpeg          records the monitor source in rolling segments:
                   ffmpeg -f pulse -i meet_out.monitor -ac 1 -ar 16000
                          -c:a libopus -b:a 24k
                          -f segment -segment_time 300 -reset_timestamps 1
                          /rec/seg_%03d.ogg
```

The image is built for arm64 (Oracle Ampere VM); Apple Silicon dev machines are
the same arch, so local `docker build`/run is representative. A window manager
(fluxbox) is **not** included initially; add it in 5.2 only if Meet misbehaves
without one (Vexa ships it, screenapp doesn't). `x11vnc` + websockify are
included but started only when `BOT_DEBUG_VNC=1` (never in prod compose) — 5.6's
debugging pass will want to watch the bot live.

## Browser launch profile (D68)

- `playwright-extra` + `puppeteer-extra-plugin-stealth`, with the
  `iframe.contentWindow` and `media.codecs` evasions **disabled** (both prior
  arts converged on exactly this).
- `headless: false` on the Xvfb display.
- `handleSIGINT/SIGTERM/SIGHUP: false` — Playwright's own handlers close the
  browser the instant a signal lands, destroying the in-flight recording;
  shutdown ordering belongs to bot.ts.
- `ignoreDefaultArgs: ['--mute-audio', '--enable-automation']`.
- Args: `--no-sandbox --disable-setuid-sandbox` (container),
  `--disable-blink-features=AutomationControlled`,
  `--autoplay-policy=no-user-gesture-required`,
  `--window-size=1280,800`, first-run suppression flags. **No fake-device
  flags**: the bot joins device-less via "Continue without microphone and
  camera" — it physically cannot unmute, and the pre-admission fingerprint
  stays close to a normal browser.
- Context: viewport 1280×720, locale `en-US`; append `hl=en` to the Meet URL so
  every text selector matches one language (prior art instead multiplies
  selectors per locale — pinning the locale is simpler and we control the
  browser).
- Anonymous by default. A dedicated signed-in Google account (persistent
  profile volume or `storageState`) is the documented fallback for orgs that
  block anonymous joiners — config hook `BOT_STORAGE_STATE_PATH`, off by
  default.

## Join flow (5.2) — state machine

```
spawning → joining → lobby → recording → leaving → done
                └→ not_admitted | denied | blocked | invalid_url | failed
```

1. Orchestrator spawns the container with `BOT_CONFIG` (meeting id, Meet URL,
   display name, session token) in the environment.
2. `goto(url, waitUntil: 'domcontentloaded')`. Classify the landing page:
   redirected to `accounts.google.com` or a "Sign in" heading → **blocked**
   (meeting requires auth); "Check your meeting code" / invalid-link text →
   **invalid_url**; otherwise the pre-join screen.
3. Click "Continue without microphone and camera" if present; fill the first
   visible `input[type="text"]` with the display name (**"ScribeFlow
   Notetaker"**, non-negotiable prefix per D33); click the join button — try
   "Ask to join", then "Join now", then "Join anyway".
4. **Lobby wait** (state `lobby`, poll every 2 s, total budget
   `BOT_ADMISSION_TIMEOUT_S` = 300):
   - Admission is detected by a **participant signal**, not button presence
     (D71): `[data-avatar-count]` badge, or `button[aria-label^="People"]`
     whose label matches `People - \d+`, or in-call body text — while no
     lobby text ("Asking to join…", waiting-for-host text) is visible.
   - Denial text → terminal **denied**; never re-ask (D71).
   - Request-expired text ("No one responded to your request") or a redirect
     off `meet.google.com` → re-issue the join request, at most
     `BOT_JOIN_REQUEST_ATTEMPTS` = 3 total asks inside the admission window
     (prior art retries up to 10× — that's spam; a host who ignored two asks
     has answered).
   - Budget exhausted → terminal **not_admitted**.
5. On admission: dismiss "Got it" modals and mic/cam not-found toasts in a
   bounded loop (they stack); report `recording` to the orchestrator; start
   ffmpeg; if the tenant's announce setting is on, post the consent line to
   chat ("This meeting is being transcribed by ScribeFlow") — best-effort,
   failure is logged, never fatal.
6. Audio health check: 60 s after admission, sample RMS off `meet_out.monitor`
   (short `parec` reads). Flat silence → restart PulseAudio + ffmpeg once, then
   report unhealthy and keep recording (a silent recording still proves the
   lifecycle worked; the alert tells us why it's empty).

Every selector lives in one `selectors.ts` module (Meet's UI shifts a few times
a year — 5.6 exists for this); every terminal failure screenshots the page and
PUTs it to R2 under `tenant/{t}/meeting/{m}/bot-debug/` (same 30-day lifecycle).

## Leave conditions (5.4)

| Trigger                                                                  | Detection                                                          | Default |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------- |
| Alone after having seen another participant for `BOT_LONE_PARTICIPANT_S` | participant count ≤ 1 sustained                                    | 60 s    |
| Nobody ever joined within `BOT_NO_ONE_JOINED_S` of admission             | count never reached 2                                              | 600 s   |
| Removed by host                                                          | "You've been removed from the meeting" body text                   | —       |
| Kicked/redirected                                                        | URL leaves `meet.google.com`, page close/crash                     | —       |
| Hard cap `BOT_MAX_DURATION_S`                                            | wall clock since recording start                                   | 7200 s  |
| Orchestrator kill (`docker stop`)                                        | SIGTERM via entrypoint forwarding                                  | —       |

Participant count is polled every 5 s from the avatar badge (fallback: People
aria-label). The lone-participant default is 60 s — prior art uses 10 s, which
one flaky DOM read can trip; our old draft said 2 min, which records two minutes
of empty room on every meeting. All timers are config, not code.

**Graceful exit (every path):** click "Leave call" (best-effort) → stop ffmpeg
(stdin `q`; SIGTERM at 15 s; SIGKILL at +5 s) → upload the final segment →
report terminal state to the orchestrator → exit 0. The orchestrator's
`docker stop` grace is 60 s so this always has room to run. Exit is nonzero
only when the recording could not be flushed.

## Audio capture path (D67) and how recordings enter the pipeline (D69)

**Capture is outside the page**: PulseAudio null-sink monitor → ffmpeg, 16 kHz
mono Opus (~10 MB/h), 300 s rolling segments. Rejected: in-page
`getDisplayMedia` + `MediaRecorder` (both prior arts' Meet lane) — it dies with
the page's JS state, shuttles base64 chunks over an exposed function, and exists
there to serve needs we don't have (video, live streaming). ffmpeg survives page
weirdness and its output is a plain file.

**Segments are crash insurance, not pipeline chunks** (D69, superseding the
"skip the slicer" half of D32): `-f segment` produces *non-overlapping* files,
but the stitcher's dedup rules assume the 10 s overlap (D46), and diarization
needs the full concatenated file regardless. Retrofitting overlap or a
zero-overlap stitch mode would fork the racing engine's invariants for one
producer. Instead:

- As each segment closes, the bot requests a presigned PUT from the orchestrator
  (D70) and uploads it to
  `tenant/{t}/meeting/{m}/bot-segments/{idx}_{startedAtMs}.ogg` — the key
  carries the index and the wall-clock start, so no metadata store is needed.
  A crash loses ≤ 5 minutes.
- On any terminal bot state with ≥ 1 segment uploaded (clean leave **and**
  crash alike — one code path), the orchestrator publishes
  `meeting.finalize {v, tenant_id, meeting_id}` (job id
  `{meetingId}:finalize:0`). A handler in the **slicer worker** (it already has
  ffmpeg, R2, and the publish primitive, D51) lists the segment prefix, sorts
  by index, ffprobes durations, and concatenates — **inserting silence for any
  wall-clock gap** between segments (a crash + rejoin leaves a hole; padding it
  keeps every downstream timestamp absolute, invariant 4). The result is
  uploaded as the meeting's canonical `r2_key` and a plain `meeting.uploaded`
  is published.
- From there the **unchanged** pipeline runs: slice (with real overlap) →
  race → diarize → stitch → extract/embed. Re-slicing a file we already had in
  segments costs seconds of CPU and one ~30 MB round trip — nothing at our
  scale, and zero new invariants.

`meeting.finalize` is idempotent (deterministic job id, upsert of `r2_key`,
duplicate `meeting.uploaded` is already harmless per D45/D14) and rides the
normal retry ladder to the DLQ.

## Orchestrator (5.5)

Small Node service (`bot/orchestrator`) on the VM using dockerode.

- Consumes `bot.spawn {v, tenant_id, meeting_id, meet_url, display_name,
  requested_at}` from `q.bot_spawn` (published by the Phase 6 scheduler or the
  dashboard's "invite bot now" button). Queue has a 30-min message TTL and the
  orchestrator drops messages whose `requested_at` is stale — a bot must never
  join a meeting that already ended (D31).
- **Static semaphore `BOT_MAX_CONCURRENT`, default 1** (D72). The RAM budget
  affords 2 (infrastructure.md); the "2, or 1 while diarization is at peak"
  dynamic idea is rejected — coupling spawn decisions to pipeline load is
  complexity with no demo-scale payoff. Excess spawns wait on the queue.
- One session per meeting: skips the spawn if `bot_sessions` already has a
  non-terminal session for the meeting (deterministic job id
  `{meetingId}:bot:0`).
- **Control plane over HTTP, bot holds zero infra credentials** (D70): the
  container gets only its `BOT_CONFIG` + a random per-session token. It calls
  the orchestrator on the compose network: `POST /sessions/:id/heartbeat`
  (every 15 s: state, participant count, RMS), `POST /sessions/:id/event`
  (state transitions), `POST /sessions/:id/segment-url {idx, startedAtMs}` →
  presigned PUT. The orchestrator owns the R2 token, Postgres
  (`bot_sessions`, tenant-scoped repositories per invariant 2), and RabbitMQ
  (events fanout for SSE + `meeting.finalize`). This is also the smallest
  possible bot-container escape surface for 7.1.
- **Reaper**: container exited or heartbeat silent > 60 s → `docker inspect`,
  record outcome, force-remove the container, and publish `meeting.finalize`
  if any segments were uploaded. On unexpected death mid-meeting it attempts
  **one** automatic rejoin (fresh container, same session lineage; the host
  sees one new ask-to-join — that's one prompt, not spam; D71). The finalize
  job's silence padding absorbs the gap.
- Records every transition in `bot_sessions` (5.5 migration adds `tenant_id`,
  `last_heartbeat_at`, `outcome_detail` to the Phase 0 sketch) and publishes
  bot state to the events exchange so the dashboard shows it live. Meeting
  `status` itself is untouched until `meeting.uploaded` — the pipeline's state
  machine gains no new states.

## Config added in Phase 5 (all documented in `.env.example` per invariant 8)

| Variable                    | Default                | Used by      |
| --------------------------- | ---------------------- | ------------ |
| `BOT_MAX_CONCURRENT`        | 1                      | orchestrator |
| `BOT_ADMISSION_TIMEOUT_S`   | 300                    | bot          |
| `BOT_JOIN_REQUEST_ATTEMPTS` | 3                      | bot          |
| `BOT_LONE_PARTICIPANT_S`    | 60                     | bot          |
| `BOT_NO_ONE_JOINED_S`       | 600                    | bot          |
| `BOT_MAX_DURATION_S`        | 7200                   | bot          |
| `BOT_SEGMENT_S`             | 300                    | bot          |
| `BOT_DISPLAY_NAME`          | "ScribeFlow Notetaker" | bot          |
| `BOT_DEBUG_VNC`             | 0                      | bot          |
| `BOT_STORAGE_STATE_PATH`    | unset                  | bot          |
| `BOT_IMAGE`                 | scribeflow-bot:latest  | orchestrator |

Per-tenant (DB, not env): chat announcement on join (D33), on by default.

## Known failure modes & mitigations

| Failure                                     | Mitigation                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Meet UI selectors change (few times a year) | One `selectors.ts` module; screenshot-on-failure to R2; 5.6 reserves Fable time                 |
| Anonymous joins blocked by the org          | `blocked` outcome surfaced in dashboard; documented signed-in-profile fallback (D68)            |
| Not admitted / denied / request expired     | Distinct terminal outcomes in `bot_sessions`; ≤ 3 asks, denial is terminal (D71)                |
| Audio silence (PulseAudio misconfig)        | RMS probe 60 s post-admission; one restart of the audio chain, then alert (keep recording)      |
| Container crash mid-meeting                 | Segments already in R2; reaper publishes `meeting.finalize` (partial meeting); one rejoin (D71) |
| `docker stop` killing the recording         | PID-1 signal forwarding + 60 s stop grace + ffmpeg `q`/SIGTERM/SIGKILL ladder                   |
| Meeting runs past the hard cap              | Uploaded segments finalize into a partial meeting                                               |
| Playwright default args mute Chromium       | `ignoreDefaultArgs: ['--mute-audio']` — asserted by a launch-profile unit test                  |

## Consent & ethics (non-negotiable)

The bot is always a **visible, clearly named participant** — that's the mechanism
by which attendees know recording is happening, and admission is explicit consent
by the host. The per-tenant chat announcement ("This meeting is being transcribed
by ScribeFlow") covers two-party-consent jurisdictions. Never build a
hidden-capture mode. (D33, CLAUDE.md invariant 7.)

## Testing strategy for 5.2–5.4

No CI run ever joins a real Meet. Vexa ships a **mock meeting page** driven by
scenario scripts (`services/bot/mock/`) — copy that idea: a static local page
that mimics the pre-join form, lobby, admission, participant badge, removal
text, and end states, served in tests so the join flow and lifecycle state
machine run against Playwright for real. The capture chain gets a
container-level test (play a tone into `meet_out`, assert ffmpeg segments
contain it); the finalize handler gets unit tests with recorded fixtures
(gap-padding included), per the repo's no-live-calls rule. Real-Meet testing is
manual and is what 5.6 is reserved for.

## Ticket mapping

- **5.2** container image + entrypoint + launch profile + join flow through
  `recording`, mock-page tests.
- **5.3** capture chain: PulseAudio bringup, ffmpeg segments, presigned
  uploads, RMS health, plus the `meeting.finalize` handler in the slicer
  worker (it's the consumer of what 5.3 produces).
- **5.4** lifecycle: leave conditions, graceful shutdown ladder, chat
  announcement, removal/redirect detection.
- **5.5** orchestrator: spawn queue, semaphore, control-plane HTTP, reaper,
  rejoin, `bot_sessions` migration + SSE events.

## Zoom (Phase 8)

Zoom's web client permits guest joins, so the container design ports directly;
`bot.ts` isolates platform specifics behind a `platform: "meet" | "zoom"`
strategy interface from day one (5.2 defines it — both prior arts structure
exactly this way). Zoom also offers an official Meeting SDK with raw-audio
access as a cleaner long-term path, but it requires app review; the browser bot
avoids that gate.
