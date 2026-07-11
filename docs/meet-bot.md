# Google Meet Bot

Google exposes no free recording API for Meet (recordings require paid Workspace
editions and land in the host's Drive). Every commercial notetaker (Read.ai,
Fireflies, Recall.ai) does what we'll do: **join the meeting as a visible participant
with a headless browser and capture the audio the browser plays.**

## Prior art to study before building (ticket 5.1)

- **Vexa** ([github.com/Vexa-ai/vexa](https://github.com/Vexa-ai/vexa)) — Apache 2.0,
  self-hosted meeting-bot API for Meet/Teams/Zoom, Docker Compose deployable. The
  closest existing implementation of our design; read their bot container and
  audio-capture code first. Building our own is still the right call for the
  portfolio (the bot _is_ the flagship), but their solutions to Meet's UI quirks
  will save days.
- **screenappai/meeting-bot** ([github.com/screenappai/meeting-bot](https://github.com/screenappai/meeting-bot)) —
  TypeScript + Playwright universal meeting bot, MIT-style. Good reference for
  join-flow selectors and lifecycle handling.

## Container anatomy (one container per meeting)

```
Docker container (ephemeral, ~2 GB RAM)
├─ Xvfb            virtual display :99 (Meet requires a rendering surface)
├─ PulseAudio      virtual sink "meet_out" — Chromium's audio output device
├─ Chromium        launched by Playwright, non-headless mode on Xvfb
│                  (headless Chromium is fingerprinted/blocked by Meet)
├─ bot.ts          Playwright script: join flow, lifecycle, health
└─ ffmpeg          records the PulseAudio monitor source:
                   ffmpeg -f pulse -i meet_out.monitor -ac 1 -ar 16000
                          -c:a libopus -f segment -segment_time 300 out_%03d.ogg
```

Recording in 5-minute segments (not one big file) means:

- segments upload to R2 as the meeting runs → a crash loses ≤5 minutes;
- the pipeline's racing engine gets its chunks **for free** — bot-recorded meetings
  skip the slicer and go straight to parallel transcription (diarization still runs
  on the concatenated file).

## Join flow

1. Orchestrator receives `bot.spawn {meeting_id, meet_url, display_name}`.
2. Playwright: open `meet_url` → dismiss mic/cam permission prompts (fake devices via
   `--use-fake-device-for-media-stream`) → set name **"ScribeFlow Notetaker"** →
   click "Ask to join".
3. Wait for admission (poll for in-call UI, timeout 5 min → report `not_admitted`).
4. On admission: mute mic/cam, start ffmpeg, POST `bot.joined` state.
5. Leave conditions: participant count == 1 for >2 min, "removed from meeting" UI,
   scheduled end + 15 min grace, or hard cap (2 h). Then: stop ffmpeg, flush last
   segment to R2, publish `meeting.uploaded`, exit 0 → orchestrator reaps container.

## Orchestrator

Small Node service on the VM using dockerode:

- Consumes `bot.spawn` from RabbitMQ (published by the calendar scheduler or a
  manual "invite bot now" button that takes a Meet URL).
- **Concurrency semaphore = 1** (RAM budget, see infrastructure.md); excess spawns
  wait in the queue with a TTL so a bot never joins a meeting that already ended.
- Health-checks containers (bot heartbeats via a mounted socket or HTTP); kills
  zombies; records every transition in `bot_sessions`.

## Known failure modes & mitigations

| Failure                                               | Mitigation                                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Meet UI selectors change (happens a few times a year) | Selector table in one config file; screenshot-on-failure uploaded to R2 for debugging; ticket 5.6 reserves Fable time for this                  |
| Bot detected / join blocked on anonymous guests       | Sign the bot's Chromium into a dedicated Google account (persistent browser profile volume); some Workspace orgs block anonymous joiners anyway |
| Not admitted                                          | Timeout → notify meeting owner in dashboard; never retry-join (spammy)                                                                          |
| Audio device silence (PulseAudio misconfig)           | Bot samples RMS level 60 s after joining; silence → restart ffmpeg, then alert                                                                  |
| Meeting runs past 2 h cap                             | Segments already uploaded are processed as a partial meeting                                                                                    |

## Consent & ethics (non-negotiable)

The bot is always a **visible, clearly named participant** — that's the mechanism by
which attendees know recording is happening, and admission is explicit consent by the
host. Add a per-tenant setting for the bot to post a chat message on join ("This
meeting is being transcribed by ScribeFlow") for two-party-consent jurisdictions.
Never build a hidden-capture mode.

## Zoom (Phase 8)

Zoom's web client permits guest joins, so the container design ports directly; only
`bot.ts`'s join flow and selectors change (`platform: "meet" | "zoom"` strategy
interface from day one — ticket 5.2 should define it). Zoom also offers an official
Meeting SDK with raw-audio access as a cleaner long-term path, but it requires app
review; the browser bot avoids that gate.
