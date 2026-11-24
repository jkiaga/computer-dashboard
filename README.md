# Computers Dashboard

Lightweight Node.js server that receives IP updates from domain & POS hosts and displays them in a modern web dashboard.

**No external npm dependencies** — uses Node.js built-in `node:sqlite` (requires Node ≥ 22.5).

## Quick Start

```bash
cd computers-dashboard
node server.js
```

Or with explicit host/port:

```bash
PORT=5000 HOST=0.0.0.0 node server.js
```

Then open: **http://localhost:5000**

## Endpoints (compatible with your existing scripts)

| Method | Path              | Description                    |
|--------|-------------------|--------------------------------|
| POST   | `/api/ip/domain`  | Domain host IP update          |
| POST   | `/api/ip/pos`     | POS host IP update             |
| GET    | `/api/devices`    | List all devices (`?type=pos`) |
| GET    | `/api/stats`      | Counts for badges              |
| DELETE | `/api/devices/:id`| Remove a device                |
| GET    | `/api/health`     | Health check                   |

### Expected POST body (from your PowerShell scripts)

```json
{
  "ip": "10.0.0.55",
  "mac": "AA-BB-CC-DD-EE-FF",
  "pos_name": "COMPUTERNAME"
}
```

Optional fields also accepted: `hostname`, `user`, `username`.

## Dashboard features

- Tabs: **All / Domain / POS** with live counts
- Search across hostname, IP, MAC, user
- Sortable columns
- Online / stale / offline status dots (based on last_seen)
- Auto-refresh every 15 seconds
- Delete devices
- Dark modern UI, lightweight (no heavy frameworks)

## Data

SQLite database stored at `data/devices.db`.

## Running as a service (optional)

Example systemd unit:

```ini
[Unit]
Description=Computers IP Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/computers-dashboard
ExecStart=/usr/bin/node server.js
Environment=PORT=5000
Environment=HOST=0.0.0.0
Restart=always

[Install]
WantedBy=multi-user.target
```

## Your PowerShell scripts

They already point to the correct endpoints:

- Domain → `http://<server-host>:5000/api/ip/domain`
- POS    → `http://<server-host>:5000/api/ip/pos`

No changes needed on the client scripts.
