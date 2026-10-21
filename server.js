'use strict';

const express = require('express');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const { Readable, Transform } = require('node:stream');

// ---------------------------------------------------------------------------
// Configuration (all via environment variables)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const ROOT_DIR = path.resolve(process.env.ROOT_DIR || '/data');
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const AUTH_REQUIRED = Boolean(AUTH_USER && AUTH_PASS);
const BLOCK_PRIVATE_IPS = (process.env.BLOCK_PRIVATE_IPS || 'false') === 'true';
const MAX_CONCURRENT_JOBS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '3', 10));
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // kill a job that makes no progress for 15 min

// qBittorrent wrapper (Web API v2 of the qbittorrent-filmy container).
// The server's qbt-speed-schedule.sh sets that client's global DL limit
// (0 = unlimited); we mirror the effective limit onto our own downloads so
// both clients respect the same schedule. Empty QBT_PASS disables it all.
const QBT_API_URL = process.env.QBT_API_URL || 'http://qbittorrent-filmy:8081/api/v2';
const QBT_USER = process.env.QBT_USER || '';
const QBT_PASS = process.env.QBT_PASS || '';
const QBT_ENABLED = Boolean(QBT_USER && QBT_PASS);

// ntfy push notifications (self-hosted container, reached via Docker DNS).
// Fired fire-and-forget after a job ends; a dead ntfy must never break a job.
// Empty NTFY_TOPIC disables it. NTFY_USER/NTFY_PASS = basic auth for servers
// with login enabled (our setup is deny-all, so the admin account is used).
const NTFY_URL = (process.env.NTFY_URL || 'http://ntfy').replace(/\/+$/, '');
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_USER = process.env.NTFY_USER || '';
const NTFY_PASS = process.env.NTFY_PASS || '';
const NTFY_ENABLED = Boolean(NTFY_TOPIC);

fs.mkdirSync(ROOT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// In-memory job store
// ---------------------------------------------------------------------------
/** @type {Map<string, Job>} */
const jobs = new Map();
/** Names reserved by in-flight downloads (relative paths under ROOT_DIR) */
const reserved = new Set();
const MAX_FINISHED_KEPT = 20;

class Job extends Error {}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Job('empty URL');
  const url = new URL(raw.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Job(`unsupported protocol: ${url.protocol} (only http/https allowed)`);
  }
  if (!url.hostname) throw new Job('missing hostname');
  // strip userinfo from what we store/log/fetch against (avoid leaking credentials)
  const u = new URL(url.href);
  u.username = '';
  u.password = '';
  return u.href;
}

function isPrivateIp(ip) {
  if (ip === '::1') return true;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) {
    const [a, b, c] = v4.split('.').map(Number);
    if (a === 0 || a === 255) return true;
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && c >= 64 && c <= 127) return true; // CGNAT
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
  return false;
}

async function maybeBlockSsrf(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  let ip = host;
  if (net_isIp(host)) {
    if (isPrivateIp(ip)) throw new Job(`private IP (${ip}) blocked by SSRF filter`);
    return;
  }
  ({ address: ip } = await dns.lookup(host)); // v4-preferred
  if (isPrivateIp(ip)) throw new Job(`private IP (${ip}) blocked by SSRF filter`);
}

const net_mod = require('node:net');
function net_isIp(s) { return net_mod.isIP(s) !== 0; }

async function resolveDestDir(dest) {
  const clean = (typeof dest === 'string' ? dest : '')
    .replace(/\\/g, '/').trim()
    .replace(/^\/+/, '').replace(/\/+$/, '');
  const dir = path.resolve(ROOT_DIR, clean);
  if (dir !== ROOT_DIR && !dir.startsWith(ROOT_DIR + path.sep)) {
    throw new Job('destination points outside the download root');
  }
  await fsp.mkdir(dir, { recursive: true });
  // guard against symlink escapes out of ROOT_DIR
  const realRoot = await fsp.realpath(ROOT_DIR);
  const realDir = await fsp.realpath(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new Job('destination escapes the download root via a symlink');
  }
  return dir;
}

function sanitizeName(name) {
  name = path.posix.basename(String(name));
  name = name.replace(/[\x00-\x1f]/g, '');
  if (name.length === 0 || name === '.' || /^\.{2,}$/.test(name)) return '';
  if (name.length > 180) {
    const dot = name.lastIndexOf('.');
    if (dot > 3 && name.length - dot <= 10) {
      name = name.slice(0, 170) + name.slice(dot);
    } else {
      name = name.slice(0, 180);
    }
  }
  return name;
}

function filenameFromContentDisposition(header) {
  if (!header) return '';
  let m = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;&#]+)/i);
  if (m) {
    try { return sanitizeName(decodeURIComponent(m[1].trim())); } catch { /* ignore */ }
  }
  m = header.match(/filename\s*=\s*"?([!"#$%&'()*+,\-.0-9A-Z\\^_`\xa1-\xff]+)"?/i);
  if (m) return sanitizeName(Buffer.from(m[1], 'latin1').toString('utf8'));
  return '';
}

function uniqueFinalPath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  if (!fs.existsSync(path.join(dir, name)) && !reserved.has(path.join(dir, name))) {
    return path.join(dir, name);
  }
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate)) && !reserved.has(path.join(dir, candidate))) {
      return path.join(dir, candidate);
    }
  }
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------
function newJob(url, dir) {
  const id = crypto.randomUUID();
  const job = {
    id,
    url,
    dir,
    state: 'active',           // active | done | error | cancelled
    partPath: path.join(dir, `${id}.part`),
    finalPath: null,
    totalBytes: null,
    receivedBytes: 0,
    fileSize: null,             // relative to ROOT_DIR, after completion
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    lastActivity: Date.now(),
    cancelRequested: false,
    controller: new AbortController(),
  };
  jobs.set(id, job);
  return job;
}

function pruneFinished() {
  const finished = [...jobs.values()]
    .filter(j => j.state !== 'active')
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  for (const j of finished.slice(MAX_FINISHED_KEPT)) {
    jobs.delete(j.id);
    if (j.finalPath && reserved.has(j.dir + path.sep + j.finalPath)) reserved.delete(j.dir + path.sep + j.finalPath);
  }
}

function serializeJob(job) {
  return {
    id: job.id,
    url: job.url,
    state: job.state,
    receivedBytes: job.receivedBytes,
    totalBytes: job.totalBytes,
    file: job.fileSize || null,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Fire-and-forget ntfy POST (5 s timeout, errors only logged). */
function notifyNtfy(title, message, { priority = null, tags = '' } = {}) {
  if (!NTFY_ENABLED) return;
  const headers = { Title: title };
  if (priority) headers.Priority = String(priority);
  if (tags) headers.Tags = tags;
  if (NTFY_USER && NTFY_PASS) {
    headers.Authorization = 'Basic ' + Buffer.from(`${NTFY_USER}:${NTFY_PASS}`).toString('base64');
  }
  fetch(`${NTFY_URL}/topic/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: 'POST',
    body: message,
    headers,
    signal: AbortSignal.timeout(5000),
  }).then((r) => {
    if (!r.ok) console.warn(`ntfy notification rejected (HTTP ${r.status}): ${title}`);
  }).catch((e) => {
    console.warn(`ntfy notification failed: ${e.message} (${title})`);
  });
}

/** Push a notification for a finished job. Cancels are skipped (user-initiated). */
function announceJob(job) {
  if (job.state === 'cancelled') return;
  if (job.state === 'done') {
    notifyNtfy('Download finished', `${job.fileSize} (${humanBytes(job.receivedBytes)})`, { tags: 'white_check_mark' });
  } else {
    const rel = path.relative(ROOT_DIR, job.dir);
    const where = rel ? `${rel}/` : '';
    notifyNtfy('Download failed', `${where}${job.finalPath || ''}${job.error ? ` - ${job.error}` : ''}`, { priority: 4, tags: 'warning' });
  }
}

// ---------------------------------------------------------------------------
// qBittorrent client (API v2) + shared download-speed cap
// ---------------------------------------------------------------------------
const qbt = { sid: null, reachable: false, limitBps: 0, fails: 0 };

async function qbtLogin() {
  const r = await fetch(`${QBT_API_URL}/auth/login`, {
    method: 'POST',
    body: new URLSearchParams({ username: QBT_USER, password: QBT_PASS }),
  });
  if (!r.ok) throw new Error(`qBittorrent login HTTP ${r.status}`);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('qBittorrent login: no session cookie');
  qbt.sid = cookie;
}

async function qbtFetch(pathname, opts = {}) {
  const doFetch = () => fetch(`${QBT_API_URL}${pathname}`, {
    ...opts,
    headers: Object.assign({}, opts.headers, { Cookie: qbt.sid || '' }),
  });
  let r = await doFetch();
  if (!qbt.sid || r.status === 403 || r.status === 401) {
    await qbtLogin(); // first run or expired session -> retry once with a fresh cookie
    r = await doFetch();
  }
  return r;
}

/** Effective DL limit of the qBittorrent container, in bytes/s (0 = unlimited). */
async function refreshQbtLimit() {
  if (!QBT_ENABLED) return;
  try {
    const r = await qbtFetch('/app/preferences');
    if (!r.ok) throw new Error(`preferences HTTP ${r.status}`);
    const p = await r.json();
    let limit = Number(p.dl_limit) || 0;
    const modeR = await qbtFetch('/transfer/speedLimitsMode');
    if ((await modeR.text()).trim() === '1') limit = Number(p.alt_dl_limit) || 0;
    qbt.limitBps = limit;
    qbt.reachable = true;
    qbt.fails = 0;
  } catch {
    qbt.fails += 1;
    if (qbt.fails >= 2) qbt.limitBps = 0; // qb unreachable for a while -> stop throttling
  }
}

setInterval(refreshQbtLimit, 30 * 1000).unref();

// Slot queue shared by ALL active jobs: chunks are served no faster than
// qbt.limitBps bytes/s in total. readyAt = when the current chunk's "time slot"
// is paid for; each chunk advances it by n/limit, so long-term rate == limit.
const throttle = { readyAt: Date.now(), chain: Promise.resolve() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function takeThrottled(n) {
  const step = async () => {
    const limit = qbt.limitBps;
    if (!limit || n <= 0) return;
    const wait = throttle.readyAt - Date.now();
    if (wait > 0) await sleep(wait); // idle gaps clamp readyAt, so at most one chunk of catch-up
    throttle.readyAt = Math.max(throttle.readyAt, Date.now());
    throttle.readyAt += (n / limit) * 1000;
  };
  const p = throttle.chain.then(step);
  throttle.chain = p.catch(() => {});
  return p;
}

class Throttle extends Transform {
  _transform(chunk, enc, cb) {
    takeThrottled(chunk.length).then(() => cb(null, chunk)).catch(cb);
  }
}

async function runJob(job) {
  const relReserve = (name) => path.relative(ROOT_DIR, name);
  let limiter; // declared before the try so the outer finally can destroy() it
  try {
    if (BLOCK_PRIVATE_IPS) {
      await maybeBlockSsrf(new URL(job.url).hostname);
    }
    let res;
    try {
      res = await fetch(job.url, { redirect: 'follow', signal: job.controller.signal });
    } catch (e) {
      if (job.cancelRequested || job.controller.signal.aborted) throw new Job('cancelled');
      throw e;
    }
    if (!res.ok) throw new Job(`HTTP ${res.status} ${res.statusText}`.trim());

    const finalUrl = new URL(res.url);
    if (finalUrl.protocol !== 'http:' && finalUrl.protocol !== 'https:') {
      throw new Job(`redirected to unsupported protocol: ${finalUrl.protocol}`);
    }

    // --- pick target file name --------------------------------------------
    let name = filenameFromContentDisposition(res.headers.get('content-disposition'));
    if (!name) {
      const base = path.posix.basename(finalUrl.pathname);
      name = sanitizeName(base || '');
    }
    if (!name) name = `download-${new Date(job.startedAt).toISOString().replace(/[:.]/g, '-')}`;

    const finalPath = uniqueFinalPath(job.dir, name);
    job.finalPath = path.basename(finalPath);
    reserved.add(path.join(job.dir, job.finalPath));

    const cl = res.headers.get('content-length');
    if (cl !== null && Number.isFinite(parseInt(cl, 10))) job.totalBytes = parseInt(cl, 10);

    const out = fs.createWriteStream(job.partPath);
    try {
      const src = Readable.fromWeb(res.body);
      limiter = new Throttle(); // caps combined rate at qBittorrent's current DL limit
      await new Promise((resolve, reject) => {
        src.on('data', (chunk) => {
          job.receivedBytes += chunk.length;
          job.lastActivity = Date.now();
        });
        src.pipe(limiter).pipe(out);
        out.on('finish', resolve);
        out.on('close', () => reject(new Job('write stream closed early')));
        src.on('error', reject);
        limiter.on('error', reject);
        out.on('error', reject);
      });
    } catch (e) {
      if (job.cancelRequested || job.controller.signal.aborted) throw new Job('cancelled');
      throw e;
    } finally {
      out.end();
    }

    // atomic rename into place
    await fsp.rename(job.partPath, finalPath);
    job.fileSize = relReserve(finalPath);
    job.state = 'done';
  } catch (e) {
    if (job.cancelRequested || (job.controller.signal.aborted && job.error !== 'timeout')) {
      job.state = 'cancelled';
      job.error = e.message === 'cancelled' ? null : (job.error || e.message);
    } else {
      job.state = 'error';
      job.error = e.name === 'AbortError' ? (job.error || 'aborted') : e.message;
    }
    await fsp.unlink(job.partPath).catch(() => {});
  } finally {
    if (limiter) limiter.destroy();
    if (job.finalPath) reserved.delete(path.join(job.dir, job.finalPath));
    job.finishedAt = Date.now();
    announceJob(job); // ntfy push: finished / failed (cancels skipped)
    pruneFinished();
  }
}

// idle watchdog: abort downloads that stop producing data entirely
setInterval(() => {
  for (const job of jobs.values()) {
    if (job.state === 'active' && Date.now() - job.lastActivity > IDLE_TIMEOUT_MS) {
      job.error = 'timeout: no data received';
      job.controller.abort();
    }
  }
}, 30 * 1000).unref();

// ---------------------------------------------------------------------------
// App & security middleware
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' })); // 4mb: base64 .torrent uploads live in JSON bodies

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!req.path.startsWith('/api')) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'"
    );
  }
  next();
});

// HTTP Basic auth (login + hasło). Deliberately no WWW-Authenticate challenge
// header, so browsers use the in-page login form instead of the native dialog.
function sha(s) { return crypto.createHash('sha256').update(s).digest(); }

function basicMatches(req) {
  const m = (req.headers['authorization'] || '').match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  // both sides are sha256 digests -> equal length, timingSafeEqual is safe
  return crypto.timingSafeEqual(sha(user), sha(AUTH_USER)) &&
         crypto.timingSafeEqual(sha(pass), sha(AUTH_PASS));
}

// auth for everything under /api except status + health (status reveals only whether auth is on)
app.use('/api', (req, res, next) => {
  if (!AUTH_REQUIRED || req.path === '/status' || basicMatches(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/status', (req, res) => {
  res.json({ authRequired: AUTH_REQUIRED, rootDir: '/' });
});

/** List directories (relative to ROOT_DIR) for the destination picker. */
app.get('/api/dirs', async (req, res) => {
  const out = [];
  const walk = async (dir, rel, depth) => {
    if (depth > 4 || out.length >= 300) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { return; }
    const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const name of subdirs) {
      if (name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      out.push(childRel);
      // skip symlinked dirs in the listing to keep paths predictable
      try {
        const st = await fsp.stat(path.join(dir, name));
        if (!st.isSymbolicLink()) await walk(path.join(dir, name), childRel, depth + 1);
      } catch { /* ignore */ }
    }
  };
  await walk(ROOT_DIR, '', 0);
  res.json(out);
});

// resolve a relative path (relative to ROOT_DIR), guarding against escapes
function resolveRel(rel) {
  const clean = (typeof rel === 'string' ? rel : '')
    .replace(/\\/g, '/').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const abs = path.resolve(ROOT_DIR, clean);
  if (abs !== ROOT_DIR && !abs.startsWith(ROOT_DIR + path.sep)) throw new Job('outside root');
  return { abs, rel: clean };
}

/** Browse a folder: list subdirs + files (name, size, mtime). */
app.get('/api/files', async (req, res) => {
  try {
    const { abs, rel } = resolveRel(req.query.p);
    let st;
    try { st = await fsp.stat(abs); } catch { return res.status(404).json({ error: 'folder not found' }); }
    if (!st.isDirectory()) return res.status(400).json({ error: 'not a folder' });

    const entries = await fsp.readdir(abs, { withFileTypes: true });
    const files = [], dirs = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.endsWith('.part')) continue; // skip hidden + in-flight downloads
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        dirs.push({ path: relPath });
      } else if (e.isFile()) {
        try {
          const s = await fsp.stat(path.join(abs, e.name));
          files.push({ name: e.name, path: relPath, size: s.size, mtime: s.mtimeMs });
        } catch { /* ignore */ }
      }
    }
    dirs.sort((a, b) => a.path.localeCompare(b.path));
    files.sort((a, b) => b.mtime - a.mtime); // newest first
    res.json({ path: rel, files, dirs });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Delete a single file from the download root. */
app.delete('/api/file', async (req, res) => {
  try {
    const { abs } = resolveRel(req.query.p);
    if (abs === ROOT_DIR) return res.status(400).json({ error: 'cannot delete root' });
    const st = await fsp.stat(abs);
    if (!st.isFile()) return res.status(400).json({ error: 'not a file' });
    await fsp.unlink(abs);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    res.status(500).json({ error: e.message });
  }
});

/** Delete a folder recursively from the download root. */
app.delete('/api/dir', async (req, res) => {
  try {
    const { abs } = resolveRel(req.query.p);
    if (abs === ROOT_DIR) return res.status(400).json({ error: 'cannot delete root' });
    await fsp.rm(abs, { recursive: true });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// qBittorrent wrapper endpoints (jobs are handed to the real client container)
// ---------------------------------------------------------------------------
app.get('/api/qbt/status', (req, res) => {
  res.json({ enabled: QBT_ENABLED, reachable: qbt.reachable, limitBps: qbt.limitBps });
});

// Both v4.x and >=5.x state names (5.x renamed pausedDL->stoppedDL etc.).
const QBT_ACTIVE_STATES = new Set([
  'downloading', 'forcedDL', 'metaDL', 'forcedMetaDL',
  'stalledDL', 'queuedDL', 'pausedDL', 'stoppedDL',
  'checking', 'checkingDL', 'checkingResumeData', 'allocating', 'moving',
  'error', 'missingFiles',
]);

/** Torrents that are not finished/seeding (the "currently downloading" view). */
app.get('/api/qbt/torrents', async (req, res) => {
  if (!QBT_ENABLED) return res.json([]);
  try {
    const r = await qbtFetch('/torrents/info');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const arr = await r.json();
    res.json(arr.filter((t) => QBT_ACTIVE_STATES.has(t.state)).map((t) => ({
      hash: t.hash, name: t.name, state: t.state, progress: t.progress || 0,
      dlspeed: t.dlspeed || 0, size: t.size || 0, downloaded: t.downloaded || 0,
    })));
  } catch {
    res.status(502).json({ error: 'qBittorrent unreachable' });
  }
});

/** Add a torrent by magnet link (b.magnet) or .torrent file (b.b64 + b.filename). */
app.post('/api/qbt/torrents', async (req, res) => {
  if (!QBT_ENABLED) return res.status(503).json({ error: 'qBittorrent not configured' });
  const b = req.body || {};
  const fd = new FormData();
  if (typeof b.magnet === 'string' && b.magnet.trim()) {
    // v4.x Web API expects `mt`; >=5.x renamed the parameter to `urls`. Send both.
    const mt = b.magnet.trim();
    fd.append('mt', mt);
    fd.append('urls', mt);
  } else if (typeof b.b64 === 'string' && b.b64.length) {
    const buf = Buffer.from(b.b64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'empty .torrent payload' });
    fd.append('torrents', new Blob([buf]), String(b.filename || 'upload.torrent'));
  } else {
    return res.status(400).json({ error: 'provide a magnet link or a .torrent file' });
  }
  try {
    const r = await qbtFetch('/torrents/add', { method: 'POST', body: fd });
    const text = (await r.text()).trim();
    if (!r.ok) return res.status(400).json({ error: text || `qBittorrent HTTP ${r.status}` });
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: 'qBittorrent unreachable' });
  }
});

async function qbtTorrentAction(req, res, endpointPrimary, endpointFallback) {
  const hashes = (req.body && Array.isArray(req.body.hashes)) ? req.body.hashes : [];
  if (!hashes.length) return res.status(400).json({ error: 'no torrent hashes given' });
  const hit = async (endpoint, hash) => {
    // v4.x reads the query string; >=5.x only parses form fields on POST. Send both.
    const r = await qbtFetch(`${endpoint}?hashes=${encodeURIComponent(hash)}`, {
      method: 'POST',
      body: new URLSearchParams({ hashes: hash }),
    });
    return { r, text: (await r.text()).trim() };
  };
  try {
    for (const h of hashes) {
      let { r, text } = await hit(endpointPrimary, h);
      if (!r.ok && text.includes('Endpoint does not exist')) {
        // qBittorrent >=5 renamed pause/resume to stop/start; fall back for older builds
        ({ r, text } = await hit(endpointFallback, h));
      }
      if (!r.ok) return res.status(400).json({ error: text || `qBittorrent HTTP ${r.status}` });
    }
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: 'qBittorrent unreachable' });
  }
}

app.post('/api/qbt/pause', (req, res) => qbtTorrentAction(req, res, '/torrents/stop', '/torrents/pause'));
app.post('/api/qbt/resume', (req, res) => qbtTorrentAction(req, res, '/torrents/start', '/torrents/resume'));

app.post('/api/jobs', async (req, res) => {
  try {
    const body = req.body || {};
    let url;
    try { url = validateUrl(body.url); } catch (e) { return res.status(400).json({ error: e.message }); }
    let dir;
    try { dir = await resolveDestDir(body.dest); } catch (e) { return res.status(400).json({ error: e.message }); }

    const active = [...jobs.values()].filter((j) => j.state === 'active').length;
    if (active >= MAX_CONCURRENT_JOBS) {
      return res.status(429).json({ error: `max ${MAX_CONCURRENT_JOBS} concurrent downloads reached` });
    }

    const job = newJob(url, dir);
    runJob(job); // fire and forget; state lives in the jobs map
    res.status(201).json(serializeJob(job));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/jobs', (req, res) => {
  const all = [...jobs.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  res.json(all.map(serializeJob));
});

app.delete('/api/jobs/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.state === 'active') {
    job.cancelRequested = true;
    job.controller.abort();
    return res.json(serializeJob(job));
  }
  // finished/cancelled/error history entry: remove the file and clear the entry
  if (job.finalPath) await fsp.unlink(path.join(job.dir, job.finalPath)).catch(() => {});
  jobs.delete(req.params.id);
  res.json({ ok: true });
});

// static UI + SPA fallback
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api|healthz).*/, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

app.listen(PORT, () => {
  console.log(`download-manager listening on :${PORT}`);
  console.log(`root dir: ${ROOT_DIR}`);
  if (!AUTH_REQUIRED) console.warn('WARNING: AUTH_USER/AUTH_PASS not set - API is open to the world');
  else console.log(`auth: basic login+pass required (user: ${AUTH_USER})`);
  console.log(`SSRF filter (private IPs): ${BLOCK_PRIVATE_IPS ? 'on' : 'off'}`);
  if (QBT_ENABLED) {
    console.log(`qBittorrent wrapper: ${QBT_API_URL} (user: ${QBT_USER})`);
    refreshQbtLimit().then(() => console.log(`qBittorrent DL limit now: ${qbt.limitBps || 'unlimited'} B/s`));
  } else {
    console.log('qBittorrent wrapper: not configured (QBT_USER/QBT_PASS empty)');
  }
  console.log(`ntfy notifications: ${NTFY_ENABLED ? `${NTFY_URL}/topic/${NTFY_TOPIC}` : 'off (NTFY_TOPIC empty)'}`);
});
