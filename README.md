# SensorPushIntegration

Idiosyncratic integration platform to connect SensorPush Gateway content to home automation.

The first integration here is a **Google Home** bridge: a small Node/Express service that exposes [SensorPush](https://www.sensorpush.com/) temperature/humidity sensors as Google Smart Home (Cloud-to-cloud) devices, so you can ask:

> "Hey Google, what's the temperature in the Office?"
> "Hey Google, what's the humidity in the Guitar Room?"

It implements the Google Smart Home OAuth flow, SYNC/QUERY/EXECUTE/DISCONNECT, and proxies sensor reads to the SensorPush Cloud API.

---

## Architecture

```
Google Home  →  Cloudflare (proxy + SSL)  →  Home IP:80  →  Firewalla port-forward  →  NAS:3000  →  SensorPush API
```

A second container (`cloudflare-ddns`) keeps the public DNS record pointed at the home IP. A third (`cloudflare-ddns-vpn`) maintains a DNS-only record for an unrelated WireGuard endpoint.

## Layout

```
.
├── src/
│   ├── index.js          # Express server, OAuth, Smart Home handlers
│   └── sensorpush.js     # SensorPush API client (cache, retry, auth)
├── Dockerfile
├── docker-compose.yml         # Generic compose (env interpolation)
├── docker-compose-qnap.yml    # NAS-specific compose (3 containers)
├── package.json
├── .env.example          # Copy to .env and fill in real values
└── MAINTENANCE.md        # Deployed-environment runbook
```

## Quick start (local)

```bash
cp .env.example .env       # then edit .env with real credentials
docker compose up -d --build
curl http://localhost:3000/health
```

## Deploying

Authoritative deployment, credential, and recovery docs are in two places:

1. **`MAINTENANCE.md`** in this repo — architecture, endpoints, sensor list, command cheat sheet.
2. **Bear notes** (private):
   - *SensorPush to Google Home Connector - Maintenance Guide* — credentials, infrastructure config, full reference.
   - *SensorPush Google Home — Keeping It Running* — operational runbook (post-firmware recovery, monitoring, rebuild from scratch).

The Bear notes hold the values that don't belong in source control (SensorPush password, Cloudflare API token, Google OAuth client secret). Put those in `.env` on the host before `docker compose up`.

## Endpoints

| Endpoint        | Method | Purpose                                     |
|-----------------|--------|---------------------------------------------|
| `/ping`         | GET    | Liveness (always 200)                       |
| `/health`       | GET    | Deep check: SensorPush API, token, cache    |
| `/sensors`      | GET    | Debug: list all sensors with current readings |
| `/auth`         | GET    | OAuth authorization (Google account linking) |
| `/token`        | POST   | OAuth token exchange                        |
| `/fulfillment`  | POST   | Google Smart Home fulfillment               |

## Edit → deploy loop (NAS)

The deployed copy lives on the QNAP NAS at `/share/mountPoint/Container/sensorpush-google-home/` (SMB-mounted on the Mac as `/Volumes/mountPoint/Container/sensorpush-google-home/`).

```bash
# On the Mac, after committing to git:
ssh msalit@dewberrynas.lan
export PATH=/share/CACHEDEV1_DATA/.qpkg/container-station/bin:$PATH
cd /share/mountPoint/Container/sensorpush-google-home
git pull
docker compose -f docker-compose-qnap.yml up -d --build
curl https://sensorpush.dogpose.com/health
```

(Once the NAS copy is converted to a git clone of this repo — see `MAINTENANCE.md`.)
