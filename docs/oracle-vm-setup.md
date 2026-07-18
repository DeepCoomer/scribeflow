# Oracle VM Provisioning Log (ticket 1.8)

Working notes from actually provisioning the Always Free Ampere VM: the exact
configuration used, why each choice was made, and the gotchas hit along the
way. Keep this updated if the VM is ever re-created from scratch (lost
account, disaster recovery, a second demo instance). For the target
end-state (firewall rules, `docker compose up`, DNS), see `infra/README.md`
§Going live and `docs/infrastructure.md`.

## Status

**Blocked** as of 2026-07-18: account signup succeeded, but instance
creation repeatedly fails with `Out of capacity for shape
VM.Standard.A1.Flex in availability domain AD-1` in the `AP-MUMBAI-1`
region. Mumbai has only one Availability Domain, so the usual "try a
different AD" workaround isn't available here — the remaining options are
retrying over time (early-morning IST reportedly better odds, unconfirmed)
or scripting automated retries against the OCI CLI.

## Account signup

Hit Oracle's generic "We're unable to complete your sign up" rejection
several times before it went through. Root cause: **the address entered on
the Oracle account didn't exactly match the card's billing address** on
file with the bank. Fixed by copying the address verbatim from the bank's
own records, not a "corrected"/normalized version — house number and postal
code matter most (AVS-style checks), but match the whole address as closely
as possible regardless.

Note for next time: Oracle's rejection message explicitly flags repeated
signup attempts with the same identity as suspicious — space out retries
rather than immediately resubmitting with just a different card. Card
verification also produces a small temporary hold per attempt (not a real
charge); these clear bank-side on their own, typically within a few days to
~2 weeks.

## Instance configuration

| Setting                         | Value                                                        | Why                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Region                          | `AP-MUMBAI-1`                                                 | Set at account signup, not changeable after the fact                                                                                                   |
| Availability domain             | `AD-1` (only one in this region)                               | No alternative AD to retry against here                                                                                                                |
| Image                           | Canonical **Ubuntu 24.04**                                     | Matches every setup instruction in `docs/infrastructure.md` (`apt`, `ufw`, the `get.docker.com` install script) — avoid Oracle Linux, it defaults to `dnf`/`firewalld` |
| Shape                           | **VM.Standard.A1.Flex** — 2 OCPU / 12 GB memory                | Full Always Free Ampere allotment (D25) — confirm the console tags it "Always Free eligible" before creating; the AMD micro shape (`VM.Standard.E2.1.Micro`, 1 OCPU/1 GB) is a *different* Always Free option and far too small for this stack |
| Shielded instance               | Disabled (Secure Boot / Measured Boot / TPM all off)            | Not part of this project's documented threat model; avoids boot-compatibility risk. Real hardening (`ufw`, `fail2ban`, SSH-keys-only) is OS-level per the provisioning checklist |
| Confidential computing          | Disabled                                                       | Defends against an untrusted hypervisor — wrong threat model for a $0 portfolio project                                                                |
| Boot volume size                | 100 GB                                                          | Bumped from the 46.6 GB default; still well inside the 200 GB Always Free block-storage allotment — headroom for Docker images (Postgres, RabbitMQ, and eventually Python+Playwright/Chromium in Phase 5) |
| Boot volume performance         | Balanced / 10 VPU                                               | Confirmed as the *floor* of the selector (nothing lower offered) — that makes it the included baseline, not a paid upgrade                              |
| In-transit encryption           | Enabled                                                         | Free, no compatibility risk                                                                                                                             |
| Customer-managed encryption key | Disabled (Oracle-managed default)                               | OCI Vault key management is unnecessary complexity for this threat model                                                                                |
| Block volumes                   | None                                                            | Everything lives on the boot volume; Compose bind-mounts under the repo dir (`infra/.data/...`)                                                        |
| VCN / subnet                    | New VCN + new **public** subnet, auto-created, CIDR `10.0.0.0/24` | Must be public — Caddy needs to be internet-reachable on 80/443 (D39, no tunnel)                                                                        |
| Public IPv4 address             | Not auto-assigned at creation (toggle was greyed out)           | Attach a **reserved** public IP after creation instead (Instance → attached VNIC → Edit) — reserved, not ephemeral, so it survives reboots and the DNS A record stays valid |
| IPv6                            | Not assigned                                                    | Not needed — DNS, Caddy, and the firewall rules are all IPv4-only in this design                                                                        |
| SSH keys                        | Generated by the console at instance-creation time              | Private key downloaded once (Oracle never shows it again) — store at `~/.ssh/`, `chmod 400`, back up somewhere outside just `~/Downloads`               |

## Next steps once an instance actually provisions

1. Attach a **reserved** public IP (Instance → Networking → attached VNIC → Edit).
2. Add ingress rules for **80** and **443** to the VCN's default Security
   List (22 is open by default) — this is the *first* of Oracle's two
   firewall layers; `ufw` on the VM itself is the second, and both must
   allow these ports (the classic Oracle gotcha — see
   `docs/infrastructure.md`).
3. SSH in: `ssh -i ~/.ssh/<key> ubuntu@<PUBLIC_IP>`.
4. Follow `infra/README.md` §Going live from step 3 onward (harden, install
   Docker, clone the repo, configure `.env` in both `infra/` and `api/`,
   add the `scribeflow-api` DNS A record, `docker compose up -d`).
