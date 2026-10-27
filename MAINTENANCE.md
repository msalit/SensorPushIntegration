# SensorPush to Google Home Connector — Maintenance Guide

**Last verified: 2026-08-13** (app `RUNNING` on tankNAS, 16 sensors, `tokenValid: true`)
**Updated 2026-10-26:** Cloudflare Tunnel architecture, Homebridge/Apple Home, security status. tankNAS
IP, TrueNAS version, app state and container states re-checked on the box that day.

## Overview

This service connects your SensorPush temperature/humidity sensors to Google Home, enabling voice queries like:
- "Hey Google, what's the temperature in the Office?"
- "Hey Google, what's the humidity in the Guitar Room?"

---

## ⚠️ Where this runs (changed 2026-07-03)

The connector **moved off the QNAP DewberryNAS onto tankNAS (TrueNAS SCALE)** on 2026-07-03 as part
of the NAS migration program. DewberryNAS's `sensorpush` and `cloudflare-ddns` containers are
**stopped** and that deployment is retired.

| | Old (retired) | Current |
|---|---|---|
| Host | DewberryNAS (QNAP TS-233) | **tankNAS** (UGREEN DXP4800, TrueNAS CE 25.10.7) |
| IP | 192.168.1.4 | **192.168.186.156** (Oakland LAN; was 192.168.1.170 in McLean) |
| Deploy model | `docker compose -f docker-compose-qnap.yml` | **TrueNAS custom app** named `sensorpush` |
| Code location | `/share/mountPoint/Container/sensorpush-google-home/` | **`/mnt/tank/appdata/sensorpush/build/`** |
| Secrets | that dir's `.env` | **`/mnt/tank/appdata/sensorpush/.env`** (mode 600) |
| Compose source of truth | `docker-compose-qnap.yml` (this repo) | **`~/AI_Projects/NAS Migration/compose/sensorpush.yml`** |

`docker-compose-qnap.yml` in this repo is kept for reference only. Do not deploy from it.

---

## Architecture

```
SensorPush cloud ──► sensorpush-google-home ──► cloudflared (tunnel) ──► Cloudflare ──► Google Home
       │              (TrueNAS app, :3000)        (outbound-only)
       │
       └───────────► homebridge (homebridge-sensorpush, LAN only) ──► Apple Home (HomePods / Apple TV)
```

**Google flow (since 2026-09-29):**
1. User speaks to Google Home
2. Google sends request to `https://sensorpush.dogpose.com/fulfillment`
3. Cloudflare terminates TLS and sends the request down the **Cloudflare Tunnel**, which `cloudflared`
   on tankNAS holds open outbound — nothing listens on the WAN
4. `cloudflared` forwards to `http://sensorpush-google-home:3000` over the Docker network
   `ix-sensorpush_default`
5. Container fetches readings from the SensorPush API
6. Response returns through the chain to Google Home

The tunnel's public hostname is configured in the Cloudflare dashboard (Zero Trust → Networks →
Tunnels → "tank" → Public Hostname). The old path (WAN:80 → Firewalla port-forward → tank:3000,
kept current by `cloudflare-ddns`) is retired.

**Apple flow:** independent of this service — see "Apple Home (Homebridge)" below.

---

## Infrastructure

### Domain & DNS

| Item | Value |
|------|-------|
| Domain | `dogpose.com` |
| Subdomain | `sensorpush.dogpose.com` |
| Registrar | Name.com |
| DNS Provider | Cloudflare (nameservers changed from Name.com) |
| Cloudflare Nameservers | `art.ns.cloudflare.com`, `gwen.ns.cloudflare.com` |

### Cloudflare Settings

| Setting | Value |
|---------|-------|
| Public hostname | Cloudflare Tunnel "tank" → `http://sensorpush-google-home:3000` (DNS record is a tunnel CNAME, managed by Cloudflare) |
| Tunnel token | `TUNNEL_TOKEN` in `/mnt/tank/appdata/sensorpush/.env`; value in private Bear note |
| Cloudflare Access | **Live 2026-10-26:** whole hostname behind Access (One-time PIN, owner email); a second app **Bypasses** `/auth`, `/token`, `/fulfillment` for Google. Don't change without re-testing Google linking and the HomeOps heartbeat (`GET /token` → 404). |
| SSL Mode / Proxy | Legacy settings from the port-forward era (Flexible, proxied); not used by the tunnel path |
| Account Email | _see private Bear note_ |
| Zone ID | _see private Bear note_ |
| Account ID | _see private Bear note_ |
| API Token (DDNS) | injected as `${CF_API_TOKEN}` from `.env`; value in private Bear note |

### Network

> **These values change when the household moves.** See "Relocation bring-up" below.

| Item | Value |
|------|-------|
| Home Public IP | Dynamic — irrelevant to the Google path since the tunnel (2026-09-29) |
| Router | Firewalla Purple |
| Port Forward | **None needed.** Retired with the move to Cloudflare Tunnel (2026-09-29) |
| NAS | tankNAS (`192.168.186.156`) |
| SensorPush gateways | 2 units; each supports WiFi **and** wired RJ-45 |

---

## Credentials

> **Where credentials live:** Real values are kept in two places only — `/mnt/tank/appdata/sensorpush/.env`
> on tankNAS (mode 600), and a private Bear note (*"SensorPush to Google Home Connector - Maintenance
> Guide"*). They are NOT in this repo, and NOT in the NAS Migration repo — `compose/sensorpush.yml`
> uses `${...}` placeholders that are interpolated at deploy time.

### SensorPush API

| Item | Value |
|------|-------|
| Email | `${SENSORPUSH_EMAIL}` |
| Password | `${SENSORPUSH_PASSWORD}` |
| Auth Method | OAuth (email + password → access token) |

### Google Smart Home OAuth

| Item | Value |
|------|-------|
| Client ID | `${OAUTH_CLIENT_ID}` (default `sensorpush-google-home`) |
| Client Secret | `${OAUTH_CLIENT_SECRET}` |
| Authorization URL | `https://sensorpush.dogpose.com/auth` |
| Token URL | `https://sensorpush.dogpose.com/token` |

### Google Cloud Project

| Item | Value |
|------|-------|
| Console | [console.home.google.com](https://console.home.google.com) |
| Project Type | Cloud-to-cloud Integration |
| Fulfillment URL | `https://sensorpush.dogpose.com/fulfillment` |

---

## Deployment on tankNAS

### Access

```bash
ssh truenas          # alias in ~/.ssh/config → 192.168.186.156
```

The SSH key `~/.ssh/id_ed25519_nas` is **passphrase-protected**, with the passphrase in the Apple
Keychain. `~/.ssh/config` has `UseKeychain yes` + `AddKeysToAgent yes` on the `truenas` block, so a
cold Mac reboot no longer breaks access. (Historic failure mode: an empty agent surfaced as a
confusing "Permission denied (publickey)".)

- `msalit` is FULL_ADMIN. **`sudo` requires a password** — it's in Keychain item `nas-truenas`.
- `midclt` (middleware CLI) runs as root over SSH **without** sudo — prefer it.
- The `docker` CLI **does** need sudo (`sudo docker ps`).
- **Do not use the TrueNAS REST API.** It's deprecated (removed in 26.04) and raises a
  `RESTAPIUsage` alert email on every call. Use `midclt` over SSH, or the WebSocket JSON-RPC API
  (`wss://192.168.186.156/api/current`).

### File layout on the box

```
/mnt/tank/appdata/sensorpush/
├── .env                  # mode 600 — all secrets
└── build/                # Docker build context — a COPY of this repo, not a git clone
    ├── Dockerfile
    ├── package.json
    ├── package-lock.json
    └── src/
```

### Containers

| Container | Image | Purpose |
|-----------|-------|---------|
| `sensorpush-google-home` | `sensorpush-google-home:local` (built on-box) | Main server, port 3000 |
| `cloudflare-ddns-vpn` | `favonia/cloudflare-ddns:1.17.0` | Keeps `vpn.dogpose.com` → WAN IP (DNS-only, WireGuard). **Keep.** |

`cloudflare-ddns` (for `sensorpush.dogpose.com`) was **removed from the app on 2026-10-26**. The tunnel
owns that record as a CNAME; if the container ever reappears, it logs Cloudflare error 81054 trying to
create an A record. Stop it.

Not part of the `sensorpush` app, but on the request path:

| Container | How it runs | Notes |
|-----------|-------------|-------|
| `cloudflared` | Plain `docker compose` project (`~/compose/cloudflared.yml` on the box), joined to the external network `ix-sensorpush_default` | `TUNNEL_TOKEN` is interpolated from `/mnt/tank/appdata/sensorpush/.env`. Running `docker compose` **without** `--env-file /mnt/tank/appdata/sensorpush/.env` leaves the token empty and crash-loops the tunnel (happened 2026-10-26). |

The main image uses `pull_policy: never` — it is built locally and must never be pulled from a registry.

### Deploying a code change

```bash
# 1. On the Mac: commit and push
cd ~/SensorPushIntegration
git add -A && git commit -m "..." && git push

# 2. Push the build context up
rsync -av --delete \
  Dockerfile package.json package-lock.json src \
  truenas:/mnt/tank/appdata/sensorpush/build/

# 3. Rebuild + redeploy on the box
ssh truenas
sudo docker build -t sensorpush-google-home:local /mnt/tank/appdata/sensorpush/build
midclt call app.redeploy sensorpush

# 4. Verify (on the box — from outside, /health is behind Cloudflare Access)
curl -s http://127.0.0.1:3000/health
```

Use `midclt`, **not** `docker compose -f sensorpush.yml up -d`, for the `sensorpush` app — plain
compose would create a second, unmanaged project next to the TrueNAS app.

### Changing the container definition (ports, env, volumes)

The app's live compose holds the **secret values inline**. `/mnt/tank/appdata/sensorpush/.env` is
*not* read by the app; it's the record of the values (and `cloudflared`'s source for
`TUNNEL_TOKEN`). `~/AI_Projects/NAS Migration/compose/sensorpush.yml` is a placeholder mirror.

1. Back up: `midclt call app.config sensorpush > <backup dir>/app-config.json` (mode 600; contains secrets).
2. On the box, load that dict, change it (pull secret values from `.env`, never type them into a
   command line you'll print), and submit it with
   `app.update sensorpush {"custom_compose_config_string": <json>}` as a job. The 2026-10-26 change
   used a small Python script with `truenas_api_client.Client`.
3. Update the mirror in the NAS Migration repo and commit.

Never `docker compose -f sensorpush.yml up`. It would create a second, unmanaged project. Runbook:
`~/AI_Projects/HomeOps/runbooks/tank-tunnel-and-sensorpush.md`.

### Environment (in the app config; values also in `.env`)

| Variable | Purpose |
|---|---|
| `SENSORPUSH_EMAIL`, `SENSORPUSH_PASSWORD` | SensorPush cloud login |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | Must match the Google Home Developer Console account-linking settings |
| `OAUTH_OWNER_PASSWORD` | Password entered on the `/auth` page when linking in the Google Home app. Copy in Mac Keychain item `sensorpush-oauth-owner`. |
| `OAUTH_PROJECT_ID` | `sensorpush-home-72375`; builds the `redirect_uri` allowlist |
| `TOKEN_STORE_PATH` | `/data/tokens.json`. `/data` is `/mnt/tank/appdata/sensorpush/data` on the host. |

The service refuses to start if any of the first six is missing.

### App control

```bash
midclt call app.query '[["name","=","sensorpush"]]'   # state, config
midclt call app.redeploy sensorpush
midclt call app.stop sensorpush
midclt call app.start sensorpush
```

### Logs

```bash
ssh truenas
sudo docker logs sensorpush-google-home
sudo docker logs -f sensorpush-google-home     # follow
sudo docker logs cloudflare-ddns
```

---

## Server Endpoints

| Endpoint | Method | Description | Internet exposure (target) |
|----------|--------|-------------|----------------------------|
| `/ping` | GET | Liveness (always 200) — used by the container healthcheck | Behind Cloudflare Access |
| `/health` | GET | Deep check: SensorPush API, token validity, cache age | Behind Cloudflare Access |
| `/sensors` | GET | Debug: list all sensors with readings | Behind Cloudflare Access |
| `/auth` | GET | OAuth authorization | Public (Google) |
| `/token` | POST | OAuth token exchange | Public (Google) |
| `/fulfillment` | POST | Google Smart Home fulfillment | Public (Google) |

All endpoints remain reachable on the LAN / from the box (`http://127.0.0.1:3000/...`). The HomeOps
`sensorpush-watch` job depends on `http://127.0.0.1:3000/sensors` on tank.

---

## Your Sensors

16 sensors. Names below are the **live** names from the SensorPush API (verified 2026-08-13) — these
are what get sent to Google in SYNC, so renaming a sensor in the SensorPush app changes its Google
Home name. The device ID is the SensorPush sensor ID and is **stable across renames**, so renaming
will not orphan or duplicate devices in Google Home (just resync afterward).

### Rooms

| Sensor Name | Type | Location | Sensor ID |
|-------------|------|----------|-----------|
| Office | HT1 | Office | `417183.18944998561627694007` |
| Living Room | HT1 | Living Room | `417191.2828295351410649294` |
| Master  Bedroom | HT1 | Bedroom | `195970.266391386057082916` |
| Media Room | HT1 | Media Room | `313298.2691765103993624206` |
| Garage | HT1 | Garage | `301247.1259071782793615305` |
| Guitar Room | HT1 | Guitar Room | `407570.137191662834444552` |
| Guitar Closet | HT1 | Guitar Closet | `212794.2912047864102128500` |
| Brondel | HT1 | Bathroom | `371472.3072755440936574589` |
| Outdoor Version | HTP.xw | Outside | `16781526.6959716773245122267` |

> Note: the bedroom sensor is named `Master  Bedroom` with a **double space**. Earlier revisions of
> this doc called it "Main BR" — that was wrong.

### Guitar cases

| Sensor Name | Type | Sensor ID |
|-------------|------|-----------|
| OM1 A SB HC S | HT1 | `191817.31348507782594307173` |
| SCGC OM42 | HT1 | `409747.183942185926913368` |
| CJ-45-AT | HT1 | `425724.33764379803618728482` |
| Soloist | HT1 | `425749.21359927402727249719` |
| Eichelbaum OM | HT1 | `425762.41016360264242800862` |
| Eichelbaum Nick Lucas | HT1 | `425560.19987395602824180402` |
| Fairbanks F20 | HT.w | `16854443.23750445091811748787` |

**Known-stale sensors as of 2026-08-13** (suspect battery):
- **Fairbanks F20** — last reported **2026-05-10**, over three months silent.
- **Eichelbaum Nick Lucas** — last reported **2026-08-09**.

---

## Relocation bring-up (new home / new network)

**Context:** relocating McLean VA → Oakland CA, August 2026. New network infrastructure, again
built on a **Firewalla Purple**.

### What survives the move automatically
- **Google path.** Since 2026-09-29 the Cloudflare Tunnel is outbound-only, so a new WAN IP, router
  or subnet needs no DNS update and no port-forward — `cloudflared` just reconnects.
- **Google account linking.** Tied to the domain, not the IP. Should survive.
- **Sensor identity.** Device IDs are SensorPush sensor IDs; they don't change.

### What must be redone by hand
1. **tankNAS DHCP reservation** on the new router (LAN-side tooling and `~/.ssh/config` depend on it).
   *(Historic: before the tunnel, the Firewalla TCP 80 → tankNAS:3000 port-forward was the item most
   likely to be forgotten. It is no longer needed.)*
2. **SensorPush gateways back online.** Both units have RJ-45 — **prefer wired**. Wired needs no
   provisioning (DHCP) and skips the BLE WiFi-credential dance entirely. Without a gateway online,
   sensors buffer locally and the cloud goes stale, so `/health` can report `status: ok` while
   `/sensors` returns hours-old readings.
3. **Sensor placement + renames.** New house, new rooms. Rename in the SensorPush app, then
   "Hey Google, sync my devices" to pull the new names through.
4. **Update this doc** with the new WAN IP, tankNAS LAN IP, and the room list.

### Verification sequence

```bash
dig +short sensorpush.dogpose.com                    # should resolve (Cloudflare IPs)
ssh truenas 'curl -s http://127.0.0.1:3000/health'   # expect 16 sensors, tokenValid: true
ssh truenas 'curl -s http://127.0.0.1:3000/sensors'  # check `observed` timestamps are FRESH
```
(From outside, `/health` and `/sensors` are behind Cloudflare Access once Phase 0 is done.)
Then a voice test: *"Hey Google, what's the temperature in the Office?"*

`/health` passing is **not** sufficient — it proves the service can reach the SensorPush cloud, not
that the gateways are relaying. Always check `observed` timestamps in `/sensors`.

---

## Troubleshooting

### Voice commands not working

1. Check the service: `ssh truenas 'curl -s http://127.0.0.1:3000/health'`
2. Check the tunnel: `ssh truenas 'sudo docker logs --tail 50 cloudflared'` and the tunnel's status
   in the Cloudflare dashboard (Zero Trust → Networks → Tunnels → "tank").
3. Check logs:
   ```bash
   ssh truenas
   sudo docker logs sensorpush-google-home | tail -50
   ```
4. Resync devices: "Hey Google, sync my devices"
5. Relink in the Google Home app if needed.

### Readings are stale but /health is OK

The service can talk to the SensorPush cloud, but a **gateway** isn't relaying. Check gateway power
and network, and confirm both gateways show online in the SensorPush app.

### IP address changed

No action needed for the Google path — the tunnel is outbound-only. (`cloudflare-ddns-vpn` still
tracks the WAN IP for `vpn.dogpose.com`; if it isn't updating, check `CF_API_TOKEN` in
`/mnt/tank/appdata/sensorpush/.env`.)

### Tunnel down / cloudflared crash-looping

Usually `TUNNEL_TOKEN` was not interpolated. Re-run the compose with the env file:

```bash
cd ~/compose && sudo docker compose --env-file /mnt/tank/appdata/sensorpush/.env -f cloudflared.yml up -d
```

### Container won't start

```bash
midclt call app.query '[["name","=","sensorpush"]]'
ssh truenas 'sudo docker logs sensorpush-google-home'
```

Common issues: port 3000 in use, SensorPush credentials changed, image missing (rebuild it —
`pull_policy: never` means a missing image will not be fetched).

### SensorPush authentication failed

Update the password in `/mnt/tank/appdata/sensorpush/.env`, then:

```bash
midclt call app.redeploy sensorpush
```

**The SensorPush password is also stored in Homebridge** (`/mnt/tank/appdata/homebridge/config.json`,
SensorPush platform). Change it in both places, or Apple Home goes stale while Google keeps working.

---

## File Locations

### Local (Mac)

```
/Users/msalit/SensorPushIntegration/        # github.com/msalit/SensorPushIntegration
├── src/                  # Node service — source of truth for the CODE
├── docs/                 # design docs (apple-home-integration-plan.md — superseded)
├── docker-compose.yml         # local dev
├── docker-compose-qnap.yml    # LEGACY, retired deployment
├── .env / .env.example
├── README.md
└── MAINTENANCE.md        # this file

/Users/msalit/AI_Projects/NAS Migration/
└── compose/sensorpush.yml     # source of truth for the DEPLOYMENT
```

### tankNAS

```
/mnt/tank/appdata/sensorpush/   # .env (incl. TUNNEL_TOKEN) + build context
/mnt/tank/appdata/homebridge/   # Homebridge config.json (contains SensorPush credentials), auth.json
~/compose/cloudflared.yml       # tunnel compose (plain docker compose, not a TrueNAS app)
```

---

## Apple Home (Homebridge)

Apple Home gets the sensors from **Homebridge**, not from this service. Verified on the box 2026-10-26:

| Item | Value |
|------|-------|
| Container | `homebridge` (plain container on tank, network `homebridge_default`) |
| Version | Homebridge 2.4.0 |
| Plugin | `homebridge-sensorpush` ^1.0.3 (only plugin installed) |
| Data source | SensorPush cloud **directly**, with its own copy of the SensorPush email/password in `config.json` |
| Poll interval | `pollingInterval: 300000` in config (presumably ms = 5 min — unit not confirmed against plugin docs) |
| HAP port | 51737 (HomeKit pairing/traffic, LAN only) |
| Config UI | `http://192.168.186.156:8581` — form login (account created 2026-09-29), no TLS |
| Internet exposure | None — not on the Cloudflare Tunnel; remote access goes via the HomePods / Apple TV home hub |

Consequences:
- The Google security work (Cloudflare Access, OAuth hardening, re-linking Google) does **not** affect
  Apple Home. After any change here, still confirm the sensors show in the Home app.
- **Two SensorPush API clients** poll the same account (this service, on demand with a 60s cache; and
  Homebridge, on its interval). Watch both containers' logs for HTTP 429s.
- The Homebridge UI can install plugins (= run code on tank) — treat its login as a high-value
  credential and restrict who on the LAN can reach :8581 during the segmentation work.
- LAN segmentation must keep mDNS between Homebridge and the HomePods / Apple TV working.

`docs/apple-home-integration-plan.md` (a native `hap-nodejs` bridge inside this service) is
**superseded** by this Homebridge setup and should not be implemented as written.

---

## Related work

- **Apple Home / HomeKit** — delivered by Homebridge (above). The in-repo plan is superseded.
- **NAS Migration program** — `~/AI_Projects/NAS Migration/HANDOFF.md` is the authority on tankNAS.
- **Security review 2026-10-26** — `~/AI_Projects/2026 October Security Review/`.

---

## Security status (2026-10-26)

Findings measured from the public internet on 2026-10-26, and their status:

| # | Issue | Fix | Status |
|---|-------|-----|--------|
| 1 | `/sensors`, `/health`, `/ping` readable by anyone (sensor names, temps, occupancy pattern). Express also served `/Sensors`, `/sensors/`. | Cloudflare Access on the whole host; Bypass only for Google's 3 paths | **Fixed 2026-10-26** (all variants → 302 to Access) |
| 2 | `/auth` auto-approved any caller; no `client_id` / `redirect_uri` check (also an open redirect) | Validate client + response_type + Google redirect allowlist; owner-password login, throttled | **Fixed 2026-10-26** |
| 3 | `/token` didn't check `client_id` / `client_secret` or bind codes to `redirect_uri`; codes/tokens never expired | Client auth (body or Basic); single-use 10-min codes bound to redirect_uri; 1-h access tokens | **Fixed 2026-10-26** |
| 4 | `/fulfillment` never checked the bearer token | 401 unless an unexpired issued access token; DISCONNECT revokes all | **Fixed 2026-10-26** |
| 5 | OAuth client secret printed to the log at startup; auth codes and (via actions-on-google `debug: true`) bearer tokens logged too; secret silently randomized if env unset | Removed; fail fast on missing env | **Fixed 2026-10-26.** Old log lines remain in the pre-fix container's history; consider rotating `OAUTH_CLIENT_SECRET` (requires updating the Google console). |
| 6 | Tokens held in memory: a restart invalidated Google's tokens (seen 2026-10-03: refresh failed after restart, re-link needed) | Persist SHA-256 hashes to `/mnt/tank/appdata/sensorpush/data/tokens.json` | **Fixed 2026-10-26** |
| 7 | `cloudflared` image is `:latest` (unpinned) | Pin a version | Open (low) |

Tests: `npm test` (node:test, starts the server with dummy credentials; covers the above).

**Still true:**
- Credentials live in `/mnt/tank/appdata/sensorpush/.env` (mode 600), never in a repo — **except**
  the SensorPush password is also in Homebridge's `config.json` (see Apple Home section).
- No inbound ports on the WAN — the tunnel is outbound-only.
- Cloudflare API token (DDNS) is scoped to DNS edit for dogpose.com.

---

## History

- **2026-01-31** — Built (with Claude Code), deployed on QNAP DewberryNAS.
- **2026-07-03** — Migrated to tankNAS as TrueNAS custom app `sensorpush`; Firewalla repointed to
  192.168.1.170:3000; DewberryNAS containers stopped.
- **2026-08-13** — Docs corrected to match the tankNAS deployment; relocation section added.
- **2026-09-29** — Google path moved to a Cloudflare Tunnel (`cloudflared`); WAN port-forward and
  `cloudflare-ddns` for this hostname retired. Homebridge (with `homebridge-sensorpush`) set up on tank
  for Apple Home.
- **2026-10-26** — External security review: OAuth endpoints and debug paths found open to the
  internet (see "Security status"). Docs updated for tunnel, Homebridge, and new LAN IP. Same day:
  Cloudflare Access added; OAuth hardened and tokens persisted (new env + `/data` volume via
  `app.update`); `cloudflare-ddns` removed from the app. Rollback image `sensorpush-google-home:pre-20261026`;
  backups in `/mnt/tank/appdata/sensorpush/backup-20261026/`. Google Home re-link required once.
