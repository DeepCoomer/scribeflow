# infra

Local dev and VM deployment for the backing services (Postgres, RabbitMQ,
ClickHouse), the API container, and the Caddy HTTPS ingress. See
[docs/infrastructure.md](../docs/infrastructure.md) for the full cost/RAM
budget and [docs/decisions.md](../docs/decisions.md) D25–D26 + D39–D40 for
the reasoning behind each choice here.

## Local dev (tickets 0.2 / 0.4 / 0.5 verification)

```sh
cp infra/.env.example infra/.env      # edit passwords if you care, local-only
cp api/.env.example api/.env          # DATABASE_URL already matches compose's mapped port (55432, not 5432 — see compose.yml)
docker compose -f infra/compose.yml up -d postgres rabbitmq clickhouse
pnpm --filter @scribeflow/api db:generate   # first time / after schema changes
pnpm --filter @scribeflow/api db:migrate
pnpm dev:api                          # runs the API on the host, against the containers
curl localhost:3000/health
```

RabbitMQ and ClickHouse aren't consumed by any code yet (Phase 1+) — they're
started here so the full target stack is exercised from day one and so
`docker compose config` / `up` stay proof that the compose file is correct,
not aspirational.

## Building the api container

```sh
docker compose -f infra/compose.yml build api
docker compose -f infra/compose.yml up -d api
```

## Going live — do this at the end of Phase 1 (tickets 1.7 / 1.8)

Both halves are manual account steps; full reasoning in D39/D40. There is no
point doing 1.8 before a real pipeline exists — the only exception is the
Oracle account **signup**, which is worth doing early because Always Free
capacity can take days of retries.

### Frontend on Vercel (ticket 1.7, ~10 minutes, any time)

1. vercel.com → Add New Project → import the GitHub repo.
2. Root Directory: `web/`. Framework preset: Vite. Deploy.
3. Project → Settings → Domains → add `scribeflow.deepcoomer.dev`; create the
   CNAME record Vercel shows you at your DNS provider. Vercel provisions TLS.

### API on the Oracle VM (ticket 1.8, end of Phase 1)

1. Create the Ampere A1 instance (2 OCPU / 12 GB, Ubuntu 24.04 ARM) in the
   Oracle Cloud console. Always Free capacity errors in a region are common —
   retry, or try a different Availability Domain.
2. Open ports in **both** firewall layers (missing the first is the classic
   Oracle gotcha):
   - VCN Security List: allow ingress TCP 80 + 443 (SSH 22 is there by default)
   - on the VM: `ufw allow 22,80,443/tcp` with default-deny inbound
3. Harden: SSH keys only, unattended-upgrades, fail2ban.
4. Install Docker + the compose plugin; `git clone` this repo; copy
   `.env.example` → `.env` in both `infra/` and `api/` with real secrets.
5. At your DNS provider, add an A record:
   `scribeflow-api.deepcoomer.dev` → the VM's public IP.
6. `docker compose -f infra/compose.yml up -d` — Caddy (see
   `infra/caddy/Caddyfile`) obtains the Let's Encrypt certificate on first
   request and renews it automatically; there is no other TLS setup.
7. Verify from anywhere: `curl https://scribeflow-api.deepcoomer.dev/health`.
