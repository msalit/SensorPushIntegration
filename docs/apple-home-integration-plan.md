# Apple Home / HomeKit Integration — Plan

**Status:** Approved (2026-05-02). Implementation deferred until **after** the QNAP firmware updates and the `mountPoint → dewberryMount/eatonMount` share-rename project.

## Decisions

| Decision | Resolution |
|---|---|
| Polling interval | **120s** (2 min). Keeps API rate at 0.5 req/min, well under the 1 req/min SensorPush limit. |
| Architecture | **Single combined service** — extend the existing Node service to expose HomeKit alongside Google Home. No separate Homebridge container. |
| Sequencing | **After** the share-rename. Avoids updating path references twice. |
| Local working dir | **Renamed** `~/sensorpush-google-home/` → `~/SensorPushIntegration/` to match the GitHub repo. |

## Why combined service over off-the-shelf Homebridge plugin

The verified [`homebridge-sensorpush`](https://www.npmjs.com/package/homebridge-sensorpush) plugin works, but running it alongside the existing gateway means **two independent SensorPush API clients** from one public IP. Combined load risks running into the 1-req-per-minute rate limit, especially when both services hit the API in the same window.

Going combined gives us:
- One SensorPushClient instance with the existing 60s cache, retries, auth mutex, auto-reauth.
- Predictable API rate of exactly 0.5 req/min (single 120s background poller).
- One codebase, one container, one place to apply future API changes.
- HomeKit characteristics get pushed updates each poll cycle, so the Home app stays fresh without the iOS device polling.

Tradeoff: +1–2 days of work vs. ~1 hour to drop in the plugin. Worth it given this is meant to be maintainable long-term.

## Constraints worth knowing

1. **No HomeKit cloud-to-cloud API.** HomeKit pairs locally over Bonjour/mDNS using the HomeKit Accessory Protocol (HAP). The bridge must run on the home LAN; remote access requires an Apple Home hub (HomePod / Apple TV / iPad) on the same network.
2. **mDNS needs host networking.** The container must run with `network_mode: host` (or macvlan) so HAP advertisements reach the LAN. Today the container uses bridge networking with port 3000 mapped — switching to host networking is a deployment change that needs validation alongside the existing Google Home + Cloudflare path. Firewalla port-forward (TCP 80 → NAS:3000) keeps working unchanged because the container still binds 3000 directly on the host.
3. **HAP pairing state must persist** across container restarts. Means a persistent volume (`./homekit/`).
4. **One Home hub on the network** is required for any iOS device to reach the bridge while away from home (HomePod / Apple TV / iPad with Home Hub enabled).

## Architecture

```
                  ┌─────────────────────────────────────────────┐
                  │  sensorpush-google-home (single container)  │
                  │                                             │
                  │  ┌────────────────────┐                     │
                  │  │ SensorPushClient   │  ← 120s poll        │
                  │  │   (cache, retry,   │                     │
                  │  │    auth, etc.)     │                     │
                  │  └─────────┬──────────┘                     │
                  │            │                                │
                  │     latest readings (in-memory)             │
                  │      ┌─────┴─────┐                          │
                  │      ▼           ▼                          │
                  │  ┌───────┐  ┌────────────────┐              │
                  │  │ Google│  │  HAP bridge    │              │
                  │  │ /sync │  │ (hap-nodejs)   │ ←─ mDNS      │
                  │  │ /query│  │  16 accessories│   on LAN     │
                  │  └───┬───┘  └────────────────┘              │
                  └──────│──────────────────│───────────────────┘
                         ▼                  ▼
                   sensorpush.dogpose.com   iOS Home app /
                   (via Cloudflare)         Siri (local)
```

## Implementation steps (when we get to it)

### 1. Refactor SensorPushClient to support push-style updates

Today the client fetches lazily on demand. Add a small extension:
- `client.startPolling({ intervalMs: 120000, onUpdate: (sensorsWithReadings) => ... })`
- Internally just calls `getAllSensorsWithReadings()` on a timer; uses the existing cache/retry path.
- Subscribers (Google + HomeKit) register their `onUpdate` callbacks.

Keep the on-demand `getAllSensorsWithReadings()` for Google's QUERY handler — the cache will already be warm from the poller.

### 2. Add HomeKit module (`src/homekit.js`)

- Depends on `hap-nodejs`.
- Creates a single HAP `Bridge` accessory.
- For each SensorPush sensor, creates a child `Accessory` with:
  - `Service.TemperatureSensor` (CurrentTemperature in Celsius)
  - `Service.HumiditySensor` (CurrentRelativeHumidity)
  - `Service.BatteryService` if voltage/battery is reported by the sensor type
  - `Service.AccessoryInformation` (manufacturer "SensorPush", model = sensor type, serial = SensorPush sensor ID)
- On each poll cycle, calls `service.updateCharacteristic(...)` for each sensor — pushes to iOS without iOS having to ask.
- `onGet` handlers also return the latest cached value so manual refreshes from the Home app are instant.
- Persistent state directory: `./homekit/` — bridge identity, paired controller keys, accessory cache.

### 3. Wire it up in `src/index.js`

- Read new config: `HOMEKIT_PIN` (8-digit pairing code, e.g. `031-45-154`), `HOMEKIT_USERNAME` (synthetic MAC for the bridge, persistent), `HOMEKIT_NAME` (display name, default "SensorPush").
- Add to `.env.example` with placeholder values.
- After SensorPushClient initialization, start the 120s poller.
- Create the HAP bridge, register accessories, publish on port 51826.
- Hook the poller's `onUpdate` to push values to HomeKit characteristics.
- Continue serving the Google `/auth`, `/token`, `/fulfillment` endpoints unchanged.

### 4. Container/network changes

- `docker-compose-qnap.yml` for the `sensorpush-google-home` service:
  - Switch to `network_mode: host`.
  - Remove the `ports:` mapping (host networking exposes ports directly).
  - Add a volume mount: `./homekit:/app/homekit` for HAP persistence.
  - Add env vars: `HOMEKIT_PIN`, `HOMEKIT_USERNAME`, `HOMEKIT_NAME`.
- Healthcheck still works; `localhost:3000/ping` resolves the same way under host networking.
- The cloudflare-ddns / cloudflare-ddns-vpn services already use host networking — no change.
- Add `homekit/` to `.gitignore`.

### 5. Add `hap-nodejs` to package.json

```bash
npm install hap-nodejs
```

`hap-nodejs` is pure JS — it ships its own ciao mDNS implementation (the same library Homebridge uses), so no special Alpine packages are needed in the Docker image.

### 6. Pair from iPhone

1. iOS Home app → "+" → Add Accessory → "More options…" → bridge appears (advertised over mDNS as the configured name).
2. Enter the 8-digit PIN from `.env` / Bear note.
3. Assign each of the 16 sensors to a Home/Room.

### 7. Validate

- All 16 sensors appear in Home app with current temp + humidity.
- "Hey Siri, what's the temperature in the Office?" returns a fresh value.
- Voice queries via Google Home still work in parallel.
- `docker logs -f sensorpush-google-home` shows poll cycles every 120s, no 429s.
- Pull the Wi-Fi briefly: characteristics show last cached value (not "Not Responding") — the existing 15-min stale-data window covers this.

### 8. Document

- New "Apple Home" section in `MAINTENANCE.md`: pairing PIN location, how to re-pair, what to do if mDNS stops working.
- Add Apple Home pairing PIN to the private Bear maintenance note (alongside SensorPush + Cloudflare credentials).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Switching to `network_mode: host` breaks Cloudflare → Firewalla → :3000 path | Test in two steps: (1) flip to host networking, verify Google Home still works, (2) then add HomeKit. Rollback is one compose edit. |
| HomeKit pairing lost on rebuild | Persistent `./homekit/` volume mount; back up with the rest of the NAS share. |
| Bridge identity changes after rebuild → iOS treats as new device | Persist `HOMEKIT_USERNAME` (synthetic MAC) in `.env`, never regenerate. |
| HAP-NodeJS API changes between versions | Pin major version in package.json; test before bumping. |
| mDNS doesn't propagate on the QNAP network | Confirm Firewalla allows mDNS (default yes); fall back to macvlan if host networking has issues. |
| Polling 120s is too laggy for "Siri, what's the temperature" | Keep 120s; temp/humidity change slowly. If you notice, drop to 90s and watch rate-limit logs. |

## What changes in the repo

```
SensorPushIntegration/
├── src/
│   ├── homekit.js               # NEW — HAP bridge + accessories
│   ├── index.js                 # MODIFIED — start poller, wire HomeKit
│   └── sensorpush.js            # MODIFIED — add startPolling()
├── docker-compose-qnap.yml      # MODIFIED — network_mode: host, homekit volume, env vars
├── docker-compose.yml           # MODIFIED — same shape as qnap
├── package.json                 # MODIFIED — add hap-nodejs
├── .env.example                 # MODIFIED — HOMEKIT_PIN, HOMEKIT_USERNAME, HOMEKIT_NAME
├── .gitignore                   # MODIFIED — add homekit/
├── homekit/                     # NEW — gitignored, runtime HAP state
└── MAINTENANCE.md               # MODIFIED — Apple Home section
```

## Questions for later (when we start implementation)

- Single combined HAP bridge vs. two child bridges (one per "category") — single is simpler and matches Homebridge defaults.
- Should we expose the guitar-case sensors at all in HomeKit, or filter them out of HomeKit but keep them in Google? Probably keep all 16 — Home app rooms can hide them.
- Battery service: the SensorPush API reports `battery_voltage` per reading; need to map to a 0-100% characteristic. HT1 typical voltage range ~2.4–3.0V; we can do a simple linear map.
