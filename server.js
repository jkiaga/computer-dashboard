const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { URL } = require('url');

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'devices.db');
const publicDir = path.join(__dirname, 'public');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);

// Schema (create + migrate)
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname TEXT NOT NULL,
    ip TEXT NOT NULL,
    mac TEXT,
    type TEXT NOT NULL CHECK(type IN ('domain', 'pos')),
    username TEXT,
    site TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    UNIQUE(hostname, type)
  );
  CREATE INDEX IF NOT EXISTS idx_devices_type ON devices(type);
  CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen);
  CREATE INDEX IF NOT EXISTS idx_devices_hostname ON devices(hostname);
  CREATE INDEX IF NOT EXISTS idx_devices_site ON devices(site);
`);

// Migrate older DBs that lack the site column
try {
  db.prepare('SELECT site FROM devices LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE devices ADD COLUMN site TEXT');
}

// ---- Mapping tables ----

const HOST_PREFIX_MAP = {
  HC: 'Hagen Central',
  DC: 'Dobel Central',
  BB: 'Bestbuy',
  RB: 'Renbo',
  TH: 'Town Hardware',
  HK: 'Hagen Kofi',
  DD: 'Wholesale',
  HB: 'Highlands Bakery'
};

const SUBNET_MAP = {
  '172.25.1': 'Bestbuy',
  '172.25.2': 'Hagen Central',
  '172.25.3': 'Renbo',
  '172.25.4': 'Town Hardware',
  '172.25.5': 'Hagen Kofi',
  '172.25.6': 'Dobel Central',
  '172.25.7': 'Wholesale',
  '172.25.8': 'Highlands Butchery',
  '172.25.9': 'Highlands Bakery'
};

// Canonical group list (shown in UI filter)
const POS_GROUPS = [
  'Hagen Central',
  'Dobel Central',
  'Bestbuy',
  'Renbo',
  'Town Hardware',
  'Hagen Kofi',
  'Wholesale',
  'Highlands Bakery',
  'Highlands Butchery'
];

function detectSite(hostname, ip) {
  // Prefer IP subnet
  if (ip) {
    const parts = String(ip).trim().split('.');
    if (parts.length >= 3) {
      const key = `${parts[0]}.${parts[1]}.${parts[2]}`;
      if (SUBNET_MAP[key]) return SUBNET_MAP[key];
    }
  }
  // Fall back to hostname prefix (first 2 letters)
  if (hostname) {
    const prefix = String(hostname).trim().toUpperCase().slice(0, 2);
    if (HOST_PREFIX_MAP[prefix]) return HOST_PREFIX_MAP[prefix];
  }
  return null;
}

function nowISO() {
  return new Date().toISOString();
}

function normalizeMac(mac) {
  if (!mac) return null;
  return String(mac).trim().toUpperCase().replace(/-/g, ':');
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function upsertDevice(type, body) {
  const { ip, mac, pos_name, hostname, user, username } = body;
  const name = (pos_name || hostname || '').trim();
  if (!name || !ip) {
    return { error: 'hostname (pos_name) and ip are required', status: 400 };
  }

  const now = nowISO();
  const macNorm = normalizeMac(mac);
  const userVal = user || username || null;
  const ipStr = String(ip).trim();
  const autoSite = detectSite(name, ipStr);

  const existing = db.prepare(
    'SELECT id, site, username FROM devices WHERE hostname = ? AND type = ?'
  ).get(name, type);

  if (existing) {
    // On update: refresh IP/MAC/last_seen.
    // Only auto-fill site if it is currently empty.
    // Never overwrite a manually set username or site.
    db.prepare(`
      UPDATE devices
      SET ip = ?,
          mac = COALESCE(?, mac),
          username = COALESCE(username, ?),
          site = COALESCE(site, ?),
          last_seen = ?
      WHERE id = ?
    `).run(ipStr, macNorm, userVal, autoSite, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO devices (hostname, ip, mac, type, username, site, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, ipStr, macNorm, type, userVal, autoSite, now, now);
  }

  console.log(`[${type}] ${name} → ${ipStr} site=${autoSite || '—'} (${macNorm || 'no-mac'})`);
  return { ok: true, message: `${type} device updated`, hostname: name, site: autoSite };
}

function serveStatic(req, res, urlPath) {
  let filePath = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml'
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(publicDir, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  try {
    // Domain update
    if (method === 'POST' && pathname === '/api/ip/domain') {
      const body = await readBody(req);
      const result = upsertDevice('domain', body);
      if (result.error) return json(res, result.status || 400, { ok: false, error: result.error });
      return json(res, 200, result);
    }

    // POS update
    if (method === 'POST' && pathname === '/api/ip/pos') {
      const body = await readBody(req);
      const result = upsertDevice('pos', body);
      if (result.error) return json(res, result.status || 400, { ok: false, error: result.error });
      return json(res, 200, result);
    }

    // List devices
    if (method === 'GET' && pathname === '/api/devices') {
      const type = (parsed.searchParams.get('type') || '').toLowerCase();
      const site = parsed.searchParams.get('site') || '';
      let rows;

      if (type === 'domain' || type === 'pos') {
        if (site) {
          rows = db.prepare(`
            SELECT id, hostname, ip, mac, type, username, site, first_seen, last_seen
            FROM devices WHERE type = ? AND site = ? ORDER BY last_seen DESC
          `).all(type, site);
        } else {
          rows = db.prepare(`
            SELECT id, hostname, ip, mac, type, username, site, first_seen, last_seen
            FROM devices WHERE type = ? ORDER BY last_seen DESC
          `).all(type);
        }
      } else {
        rows = db.prepare(`
          SELECT id, hostname, ip, mac, type, username, site, first_seen, last_seen
          FROM devices ORDER BY last_seen DESC
        `).all();
      }
      return json(res, 200, { ok: true, count: rows.length, devices: rows });
    }

    // Stats + groups
    if (method === 'GET' && pathname === '/api/stats') {
      const total = db.prepare('SELECT COUNT(*) as c FROM devices').get().c;
      const domain = db.prepare("SELECT COUNT(*) as c FROM devices WHERE type = 'domain'").get().c;
      const pos = db.prepare("SELECT COUNT(*) as c FROM devices WHERE type = 'pos'").get().c;

      // Per-site counts for POS
      const siteRows = db.prepare(`
        SELECT site, COUNT(*) as c FROM devices
        WHERE type = 'pos' AND site IS NOT NULL AND site != ''
        GROUP BY site
      `).all();
      const groups = {};
      for (const r of siteRows) groups[r.site] = r.c;

      return json(res, 200, {
        ok: true,
        total,
        domain,
        pos,
        groups,
        groupList: POS_GROUPS
      });
    }

    // PATCH username / site only
    if (method === 'PATCH' && pathname.startsWith('/api/devices/')) {
      const id = parseInt(pathname.split('/').pop(), 10);
      if (isNaN(id)) return json(res, 400, { ok: false, error: 'Invalid id' });

      const existing = db.prepare('SELECT id FROM devices WHERE id = ?').get(id);
      if (!existing) return json(res, 404, { ok: false, error: 'Device not found' });

      const body = await readBody(req);
      const updates = [];
      const params = [];

      if ('username' in body) {
        updates.push('username = ?');
        params.push(body.username === '' || body.username == null ? null : String(body.username).trim());
      }
      if ('site' in body) {
        updates.push('site = ?');
        params.push(body.site === '' || body.site == null ? null : String(body.site).trim());
      }

      if (updates.length === 0) {
        return json(res, 400, { ok: false, error: 'Provide username and/or site to update' });
      }

      params.push(id);
      db.prepare(`UPDATE devices SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      const updated = db.prepare(`
        SELECT id, hostname, ip, mac, type, username, site, first_seen, last_seen
        FROM devices WHERE id = ?
      `).get(id);

      return json(res, 200, { ok: true, device: updated });
    }

    // Delete
    if (method === 'DELETE' && pathname.startsWith('/api/devices/')) {
      const id = parseInt(pathname.split('/').pop(), 10);
      if (isNaN(id)) return json(res, 400, { ok: false, error: 'Invalid id' });
      const before = db.prepare('SELECT id FROM devices WHERE id = ?').get(id);
      if (!before) return json(res, 404, { ok: false, error: 'Device not found' });
      db.prepare('DELETE FROM devices WHERE id = ?').run(id);
      return json(res, 200, { ok: true, message: 'Device deleted' });
    }

    // Health
    if (method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true, time: nowISO() });
    }

    // Meta: group list
    if (method === 'GET' && pathname === '/api/groups') {
      return json(res, 200, { ok: true, groups: POS_GROUPS, hostPrefixes: HOST_PREFIX_MAP, subnets: SUBNET_MAP });
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    console.error('Request error:', err);
    json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Computers Dashboard running at http://${HOST}:${PORT}`);
  console.log(`  Domain endpoint: POST /api/ip/domain`);
  console.log(`  POS endpoint:    POST /api/ip/pos`);
  console.log(`  Database:        ${dbPath}`);
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
