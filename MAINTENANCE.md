# SensorPush to Google Home Connector - Maintenance Guide

## Overview

This service connects your SensorPush temperature/humidity sensors to Google Home, enabling voice queries like:
- "Hey Google, what's the temperature in the Office?"
- "Hey Google, what's the humidity in the Guitar Room?"

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Google Home    │────▶│   Cloudflare    │────▶│  DewberryNAS    │
│  (Voice Query)  │     │   (Proxy/SSL)   │     │  (Docker)       │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                                ┌─────────────────┐
                                                │  SensorPush API │
                                                │  (Cloud)        │
                                                └─────────────────┘
```

**Flow:**
1. User speaks to Google Home
2. Google sends request to `https://sensorpush.dogpose.com/fulfillment`
3. Cloudflare terminates SSL and proxies to your home IP on port 80
4. Firewalla forwards port 80 → DewberryNAS:3000
5. Container fetches readings from SensorPush API
6. Response returns through the chain to Google Home

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
| SSL Mode | Flexible |
| Proxy Status | Proxied (orange cloud) |
| Account Email | _see private Bear note_ |
| Zone ID | _see private Bear note_ |
| Account ID | _see private Bear note_ |
| API Token (DDNS) | injected as `${CF_API_TOKEN}` from `.env`; value in private Bear note |

### Network

| Item | Value |
|------|-------|
| Home Public IP | Dynamic (currently `108.48.81.55`) |
| Router | Firewalla Purple |
| Port Forward | TCP 80 → 192.168.1.4:3000 |
| NAS | DewberryNAS (`dewberrynas.lan` / `192.168.1.4`) |

---

## Credentials

> **Where credentials live:** Real values are kept in two places only — the `.env` file on the host running Docker, and a private Bear note (*"SensorPush to Google Home Connector - Maintenance Guide"*). They are NOT in this repo. The tables below name what's needed; copy `.env.example` to `.env` and fill in.

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

## Docker Deployment

### Location on NAS

```
/share/mountPoint/Container/sensorpush-google-home/
├── docker-compose-qnap.yml
├── src/
│   ├── index.js
│   └── sensorpush.js
├── package.json
├── package-lock.json
├── Dockerfile
└── .env
```

### Containers

| Container | Image | Purpose |
|-----------|-------|---------|
| `sensorpush-google-home` | `node:20-alpine` | Main server |
| `cloudflare-ddns` | `favonia/cloudflare-ddns` | Updates DNS when IP changes |

### Docker Compose File

File: `/share/mountPoint/Container/sensorpush-google-home/docker-compose-qnap.yml`

See the canonical `docker-compose-qnap.yml` in this repo. All secrets are read from the `.env` file in the same directory via `${VAR}` interpolation; the compose file itself contains no credentials.

> **Note:** This file used to describe an older deployment that volume-mounted `src/` and ran `npm install` on every start with the raw `node:20-alpine` image. The current setup uses `build: .` with the `Dockerfile`. After code changes you must rebuild: `docker compose -f docker-compose-qnap.yml up -d --build`.

---

## Server Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/sensors` | GET | Debug: list all sensors with readings |
| `/auth` | GET | OAuth authorization (redirects to Google) |
| `/token` | POST | OAuth token exchange |
| `/fulfillment` | POST | Google Smart Home fulfillment |

---

## Your Sensors

| Sensor Name | Type | Location |
|-------------|------|----------|
| Office | HT1 | Office |
| Living Room | HT1 | Living Room |
| Main BR | HT1 | Bedroom |
| Media Room | HT1 | Media Room |
| Garage | HT1 | Garage |
| Guitar Room | HT1 | Guitar Room |
| Guitar Closet | HT1 | Guitar Closet |
| Brondel | HT1 | Bathroom |
| Outdoor Version | HTP.xw | Outside |
| OM1 A SB HC S | HT1 | Guitar case |
| SCGC OM42 | HT1 | Guitar case |
| CJ-45-AT | HT1 | Guitar case |
| Soloist | HT1 | Guitar case |
| Eichelbaum OM | HT1 | Guitar case |
| Eichelbaum Nick Lucas | HT1 | Guitar case |
| Fairbanks F20 | HT.w | Guitar case |

---

## Maintenance Commands

### SSH to NAS

```bash
ssh msalit@dewberrynas.lan
```

### Set Docker Path (run after SSH)

```bash
export PATH=/share/CACHEDEV1_DATA/.qpkg/container-station/bin:$PATH
```

### View Running Containers

```bash
docker ps
```

### View Logs

```bash
# Main server logs
docker logs sensorpush-google-home

# Follow logs in real-time
docker logs -f sensorpush-google-home

# DDNS container logs
docker logs cloudflare-ddns
```

### Restart Containers

```bash
# Restart main server
docker restart sensorpush-google-home

# Restart DDNS
docker restart cloudflare-ddns

# Restart both via compose
cd /share/mountPoint/Container/sensorpush-google-home
docker compose -f docker-compose-qnap.yml restart
```

### Rebuild and Restart (after code changes)

```bash
cd /share/mountPoint/Container/sensorpush-google-home
docker compose -f docker-compose-qnap.yml up -d --force-recreate
```

### Stop Everything

```bash
cd /share/mountPoint/Container/sensorpush-google-home
docker compose -f docker-compose-qnap.yml down
```

---

## Testing

### Health Check

```bash
curl https://sensorpush.dogpose.com/health
```

### List All Sensors

```bash
curl https://sensorpush.dogpose.com/sensors
```

### Force Google Sync

Say: "Hey Google, sync my devices"

---

## Troubleshooting

### Voice Commands Not Working

1. Check server is running:
   ```bash
   curl https://sensorpush.dogpose.com/health
   ```

2. Check logs for errors:
   ```bash
   ssh msalit@dewberrynas.lan
   export PATH=/share/CACHEDEV1_DATA/.qpkg/container-station/bin:$PATH
   docker logs sensorpush-google-home | tail -50
   ```

3. Resync devices: "Hey Google, sync my devices"

4. Relink in Google Home app if needed

### IP Address Changed

The DDNS container should handle this automatically. Check its logs:

```bash
docker logs cloudflare-ddns
```

If needed, manually update in Cloudflare DNS dashboard.

### Container Won't Start

Check Docker logs:

```bash
docker logs sensorpush-google-home
```

Common issues:
- Port 3000 already in use
- SensorPush credentials changed
- Network issues reaching SensorPush API

### SensorPush Authentication Failed

If SensorPush password changes, update it in the host's `.env` file (alongside `docker-compose-qnap.yml`) and restart the container:

```bash
docker compose -f docker-compose-qnap.yml up -d --force-recreate sensorpush-google-home
```

---

## File Locations

### Local (Mac)

```
/Users/msalit/sensorpush-google-home/
├── src/
│   ├── index.js          # Main server code
│   └── sensorpush.js     # SensorPush API client
├── docker-compose.yml     # Original compose file
├── docker-compose-qnap.yml # QNAP-specific compose
├── Dockerfile
├── package.json
├── .env
├── logo.png              # Google Home app icon
├── README.md             # Original readme
└── MAINTENANCE.md        # This file
```

### NAS (DewberryNAS)

```
/share/mountPoint/Container/sensorpush-google-home/
```

Accessible via SMB at: `/Volumes/mountPoint/Container/sensorpush-google-home/`

---

## Updating the Code

1. Edit files locally in `/Users/msalit/sensorpush-google-home/src/`

2. Copy to NAS:
   ```bash
   cp ~/sensorpush-google-home/src/* /Volumes/mountPoint/Container/sensorpush-google-home/src/
   ```

3. Restart container:
   ```bash
   ssh msalit@dewberrynas.lan "export PATH=/share/CACHEDEV1_DATA/.qpkg/container-station/bin:\$PATH && docker restart sensorpush-google-home"
   ```

4. If traits changed, resync: "Hey Google, sync my devices"

---

## Security Notes

- OAuth tokens are stored in-memory (lost on restart, but Google re-authenticates automatically)
- All credentials live in the host's `.env` file (never in this repo); `.env` is in `.gitignore`
- Cloudflare API token has limited scope (DNS edit for dogpose.com only)
- No ports exposed directly to internet (Cloudflare proxy handles SSL)
- Firewalla IDS/IPS monitors incoming traffic

---

## Created

- **Date:** January 31, 2026
- **Author:** Built with Claude Code
