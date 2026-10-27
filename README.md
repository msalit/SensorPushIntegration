# SensorPushIntegration

Idiosyncratic integration platform to connect SensorPush Gateway content to home automation.

The first integration here is a **Google Home** bridge: a small Node/Express service that exposes [SensorPush](https://www.sensorpush.com/) temperature/humidity sensors as Google Smart Home (Cloud-to-cloud) devices, so you can ask:

> "Hey Google, what's the temperature in the Office?"
> "Hey Google, what's the humidity in the Guitar Room?"

It implements the Google Smart Home OAuth flow, SYNC/QUERY/EXECUTE/DISCONNECT, and proxies sensor reads to the SensorPush Cloud API.

**Apple Home is not served by this repo.** The sensors reach Apple Home through **Homebridge** on tankNAS (`homebridge` container, plugin `homebridge-sensorpush`), which polls the SensorPush cloud independently with its own copy of the SensorPush credentials. See `MAINTENANCE.md` → "Apple Home (Homebridge)".

> ⚠️ **Open security findings (2026-10-26).** The OAuth endpoints and `/sensors` are reachable from the internet without effective auth. Remediation is in progress — see `MAINTENANCE.md` → "Security status".

---

## Architecture

```
Google Home  →  Cloudflare edge  →  Cloudflare Tunnel (cloudflared on tankNAS, outbound-only)  →  sensorpush-google-home:3000  →  SensorPush API
```

Since **2026-09-29** the public hostname `sensorpush.dogpose.com` is served by a **Cloudflare Tunnel** — nothing listens on the WAN, and the old Firewalla port-forward (TCP 80 → NAS:3000) and the `cloudflare-ddns` container for this hostname are no longer needed. A separate container (`cloudflare-ddns-vpn`) maintains a DNS-only record for an unrelated WireGuard endpoint and must keep running.

### Where it runs

Since **2026-07-03** this runs as a **TrueNAS custom app named `sensorpush`** on **tankNAS** (`192.168.186.156`). `cloudflared` is *not* part of that app — it is a plain `docker compose` project (`~/compose/cloudflared.yml` on the box).

It previously ran on the QNAP **DewberryNAS** (`192.168.1.4`); those containers are stopped and that path is retired. If you are reading an older note that says "SSH to dewberrynas," it is out of date — see `MAINTENANCE.md`.

## Layout

```
.
├── src/
│   ├── index.js          # Express server, OAuth, Smart Home handlers
│   └── sensorpush.js     # SensorPush API client (cache, retry, auth)
├── Dockerfile
├── docker-compose.yml         # Generic compose, for local dev
├── docker-compose-qnap.yml    # LEGACY — the retired DewberryNAS deployment
├── package.json
├── .env.example          # Copy to .env and fill in real values
├── docs/                 # design docs (apple-home-integration-plan.md — superseded by Homebridge)
└── MAINTENANCE.md        # Deployed-environment runbook
```

> The **live** container definition is not in this repo. It lives in the NAS Migration repo at
> `~/AI_Projects/NAS Migration/compose/sensorpush.yml`, because it is a TrueNAS custom app
> deployed alongside the other tankNAS workloads. This repo is the source of truth for the
> *Node service*; that file is the source of truth for *how it is deployed*.

## Quick start (local)

```bash
cp .env.example .env       # then edit .env with real credentials
docker compose up -d --build
curl http://localhost:3000/health
```

## Deploying

Authoritative deployment, credential, and recovery docs are in three places:

1. **`MAINTENANCE.md`** in this repo — architecture, endpoints, sensor list, command cheat sheet.
2. **`~/AI_Projects/NAS Migration/`** — the tankNAS program docs (`HANDOFF.md`) and the live
   compose file (`compose/sensorpush.yml`).
3. **Bear notes** (private):
   - *SensorPush to Google Home Connector - Maintenance Guide* — credentials, infrastructure config, full reference.
   - *SensorPush Google Home — Keeping It Running* — operational runbook.

The Bear notes hold the values that don't belong in source control (SensorPush password, Cloudflare API token, Google OAuth client secret). On tankNAS those live in `/mnt/tank/appdata/sensorpush/.env` (mode 600).

## Endpoints

| Endpoint        | Method | Purpose                                     | Internet exposure (target) |
|-----------------|--------|---------------------------------------------|----------------------------|
| `/ping`         | GET    | Liveness (always 200)                       | Behind Cloudflare Access   |
| `/health`       | GET    | Deep check: SensorPush API, token, cache    | Behind Cloudflare Access   |
| `/sensors`      | GET    | Debug: list all sensors with current readings | Behind Cloudflare Access |
| `/auth`         | GET    | OAuth authorization (Google account linking) | Public — Google must reach it |
| `/token`        | POST   | OAuth token exchange                        | Public — Google must reach it |
| `/fulfillment`  | POST   | Google Smart Home fulfillment               | Public — Google must reach it |

On the LAN all endpoints stay reachable at `http://192.168.186.156:3000` (the HomeOps `sensorpush-watch` job reads `http://127.0.0.1:3000/sensors` on tank).

## Edit → deploy loop (tankNAS)

The deployed copy of the *code* lives on tankNAS at `/mnt/tank/appdata/sensorpush/build/`. It is a
**plain copy, not a git clone** — so deploying means pushing files up, rebuilding the image on the
box, and redeploying the app.

```bash
# 1. On the Mac: commit and push
cd ~/SensorPushIntegration
git add -A && git commit -m "..." && git push

# 2. Copy the build context up (Dockerfile + package*.json + src/)
rsync -av --delete \
  Dockerfile package.json package-lock.json src \
  truenas:/mnt/tank/appdata/sensorpush/build/

# 3. Rebuild the image on the box and redeploy the app
ssh truenas
sudo docker build -t sensorpush-google-home:local /mnt/tank/appdata/sensorpush/build
midclt call app.redeploy sensorpush

# 4. Verify (from the box — /health is behind Cloudflare Access from outside)
curl -s http://127.0.0.1:3000/health
```

Deploy `sensorpush` with `midclt`, **not** `docker compose -f sensorpush.yml up -d` — the latter would
create a second, unmanaged compose project alongside the TrueNAS app.

If the Google Smart Home device traits changed, resync: "Hey Google, sync my devices."

See `MAINTENANCE.md` for the full runbook, including relocation/new-network bring-up.
