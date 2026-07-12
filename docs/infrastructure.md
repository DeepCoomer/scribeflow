# Infrastructure & Cost Plan (target: $0/month)

## Monthly cost table

| Item                                     | Provider / plan                                                                                                                 | Cost      | Hard limits to respect                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| VM (everything server-side)              | Oracle Cloud **Always Free** Ampere A1                                                                                          | $0        | **2 OCPU / 12 GB RAM / 200 GB disk** (reduced from 4/24 in June 2026), 10 TB egress |
| Transcription                            | Groq free tier — `whisper-large-v3-turbo` (your key)                                                                            | $0        | 20 req/min, 2,000 req/day, ~7,200 audio-seconds/hour, 100 MB/req                    |
| LLM (action items, summaries, sentiment) | Groq free tier — `llama-3.3-70b-versatile` (same key)                                                                           | $0        | per-day token caps; batch-friendly                                                  |
| Object storage                           | Cloudflare R2                                                                                                                   | $0        | 10 GB stored, 1M class-A ops/mo, **zero egress fees**                               |
| Frontend hosting                         | Vercel Hobby (D40)                                                                                                              | $0        | non-commercial use; fine for a portfolio                                            |
| DNS + TLS                                | DNS records at existing provider (domain `deepcoomer.dev` already owned); TLS via Vercel (web) + Caddy/Let's Encrypt (API, D39) | $0        | —                                                                                   |
| Google Calendar API                      | Google Cloud free quota                                                                                                         | $0        | ample; OAuth app stays in "testing" mode (≤100 test users)                          |
| Diarization                              | pyannote.audio self-hosted (HF gated model, free license acceptance)                                                            | $0        | CPU speed ≈ real time                                                               |
| Email (optional)                         | Resend free                                                                                                                     | $0        | 100/day                                                                             |
| **Total**                                |                                                                                                                                 | **$0/mo** |                                                                                     |

Domain renewal for `deepcoomer.dev` is the only pre-existing cost; no new spend.

## What the free limits mean in practice

- **Groq audio budget:** ~2 hours of audio per clock-hour. Ten 1-hour meetings a day
  is ~130 chunk requests — far inside 2,000/day. This is portfolio scale with head-room.
- **R2 10 GB:** a 1-hour meeting re-encoded to 16 kHz mono Opus ≈ 30 MB → ~300
  meeting-hours stored. Lifecycle rule: delete raw audio 30 days after the transcript
  is final (keep transcripts/metrics forever — they live in Postgres).
- **12 GB RAM budget on the VM:**

  | Service                                     | Reserved |
  | ------------------------------------------- | -------- |
  | Postgres                                    | 1 GB     |
  | RabbitMQ                                    | 0.75 GB  |
  | API + Caddy ingress                         | 0.75 GB  |
  | Python workers (transcribe/stitch/extract)  | 1.5 GB   |
  | pyannote diarizer (peak)                    | 2 GB     |
  | 2 Meet-bot containers (Chromium + Xvfb × 2) | 4 GB     |
  | Headroom / page cache                       | 2 GB     |

  Dropping ClickHouse (D42) freed 3 GB, which buys the **second concurrent
  bot-recorded meeting**. The orchestrator enforces the cap with a semaphore
  (2, or 1 while diarization is at peak); extra meetings queue. Fine for a
  demo/small team; scale-out path is "add a host, point it at RabbitMQ."

## DNS & subdomains (D39/D40)

Two plain records at wherever `deepcoomer.dev`'s DNS already lives — no
nameserver migration, no extra vendor:

| Hostname                        | Record | Points to                                |
| ------------------------------- | ------ | ---------------------------------------- |
| `scribeflow.deepcoomer.dev`     | CNAME  | Vercel (dashboard + landing)             |
| `scribeflow-api.deepcoomer.dev` | A      | Oracle VM public IP (Caddy on 443 → api) |

**TLS:** Vercel manages the web cert; Caddy on the VM obtains and renews the
API's Let's Encrypt cert automatically (`infra/caddy/Caddyfile`). The flat
naming (`scribeflow-api`, not `api.scribeflow`) is kept from D28 for brevity
even though the original Cloudflare cert constraint no longer applies.

**Firewall:** with the tunnel gone the VM's IP is public, so only 22/80/443
are open — and remember Oracle has **two** firewall layers (the VCN Security
List and ufw); both must allow the ports.

## Fallback ladder (if a free tier disappears)

1. **Oracle signup fails / gets reclaimed** (known to happen): Hetzner CAX11
   (2 vCPU ARM, 4 GB, ~€3.8/mo — same open-port + Caddy setup, just a new A
   record); heavy pieces (pyannote, bot) can also run on your Mac exposed via
   a Cloudflare Tunnel or Tailscale Funnel if it ever comes to that.
2. **Groq free tier tightens:** whisper.cpp with CoreML on your Apple Silicon Mac is
   faster than real time and free forever; the transcriber worker keeps the same
   interface with a `TRANSCRIBE_BACKEND=groq|local` switch — build this switch from
   day one (it's ~50 lines and de-risks the whole plan).
3. **LLM tier tightens:** Google Gemini Flash free tier, or Ollama (Llama 3.1 8B /
   Qwen) on the Mac for extraction.
4. **R2 outgrown:** Backblaze B2 (10 GB free) as second bucket, or aggressive
   lifecycle deletion.

## Provisioning checklist (Phase 0)

1. Oracle Cloud account → Ampere A1 instance (2 OCPU/12 GB), Ubuntu 24.04 ARM.
   Tip: if capacity errors occur, retry with a small automation script; capacity in
   `us-phoenix-1`/`us-ashburn-1` fluctuates.
2. Harden: SSH keys only, ufw default-deny inbound with 22/80/443 allowed
   (mirror in the VCN Security List), unattended-upgrades, fail2ban.
3. Install Docker + Compose; single `infra/compose.yml` for
   postgres, rabbitmq, api, workers, caddy.
4. DNS: CNAME `scribeflow` → Vercel, A `scribeflow-api` → VM IP (exact steps
   in `infra/README.md` §Going live).
5. R2: create bucket `scribeflow`, scoped API token (that bucket only), CORS for
   `scribeflow.deepcoomer.dev`.
6. Groq: store the existing key as a secret; set alert logging when a 429 is seen.
7. Hugging Face: accept pyannote model licenses, store HF token for model download
   (baked into the worker image at build time, not at runtime).
8. Google Cloud project: OAuth consent (testing mode), Calendar API enabled,
   client credentials as secrets.
9. Backups: nightly `pg_dump` → R2 (counts inside the 10 GB; keep 7 days).

## Secrets & config

All secrets live in a single `.env` on the VM (git-ignored) injected via Compose;
a committed `.env.example` documents every variable. No secrets in Vercel —
the frontend is fully static and talks only to the API.
