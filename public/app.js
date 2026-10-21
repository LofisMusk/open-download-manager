'use strict';

const state = {
  authRequired: false,
  user: localStorage.getItem('dm_user') || '',
  pass: localStorage.getItem('dm_pass') || '',
  libDir: '', // current folder in the library view (relative to root)
  lastSpeed: {}, // id -> { bytes, ts } for speed display
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (state.user) {
    const auth = Buffer_from(`${state.user}:${state.pass}`, 'base64');
    headers['Authorization'] = `Basic ${auth}`;
  }
  const res = await fetch(path, Object.assign({}, options, { headers }));
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401) {
    clearAuth();
    if (state.authRequired) showLogin();
    throw new Error('auth failed');
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function Buffer_from(str, enc) {
  // base64 of utf-8 string (btoa breaks on non-ASCII logins/passwords)
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function clearAuth() {
  state.user = '';
  state.pass = '';
  localStorage.removeItem('dm_user');
  localStorage.removeItem('dm_pass');
  document.getElementById('logout').style.display = 'none';
}

// ---------------------------------------------------------------------------
// Auth UI: full-screen login before the main interface
// ---------------------------------------------------------------------------
const loginScreen = document.getElementById('login-screen');
const appEl = document.getElementById('app');

function showLogin() {
  loginScreen.hidden = false;
  appEl.hidden = true;
  document.getElementById('auth-error').textContent = '';
  const u = document.getElementById('user');
  if (u) u.focus();
}

function showApp() {
  loginScreen.hidden = true;
  appEl.hidden = false;
}

document.getElementById('logout').addEventListener('click', (e) => {
  e.preventDefault();
  clearAuth();
  showLogin();
});

const authForm = document.getElementById('auth-form');
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = document.getElementById('user').value.trim();
  const pass = document.getElementById('pass').value;
  if (!user || !pass) return;
  document.getElementById('auth-error').textContent = '';
  try {
    state.user = user;
    state.pass = pass;
    localStorage.setItem('dm_user', user);
    localStorage.setItem('dm_pass', pass);
    await api('/api/jobs'); // real authenticated call -> proves the pair is valid
    showApp();
    refreshDirs();
    refreshJobs();
  } catch (err) {
    clearAuth();
    document.getElementById('auth-error').textContent =
      err.message === 'auth failed' ? 'Wrong username or password' : err.message;
  }
});

// ---------------------------------------------------------------------------
// Destination folders datalist
// ---------------------------------------------------------------------------
async function refreshDirs() {
  try {
    const dirs = await api('/api/dirs');
    const list = document.getElementById('dest-list');
    list.innerHTML = '';
    for (const d of dirs) {
      const opt = document.createElement('option');
      opt.value = d;
      list.appendChild(opt);
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Add a job
// ---------------------------------------------------------------------------
document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = document.getElementById('url').value.trim();
  const dest = document.getElementById('dest').value.trim();
  const btn = document.getElementById('add-btn');
  btn.disabled = true;
  try {
    await api('/api/jobs', { method: 'POST', body: JSON.stringify({ url, dest }) });
    document.getElementById('url').value = '';
    refreshJobs();
    refreshDirs();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Job list rendering
// ---------------------------------------------------------------------------
function humanBytes(n) {
  if (n == null || Number.isNaN(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function speed(id, bytes) {
  const now = Date.now();
  const prev = state.lastSpeed[id];
  state.lastSpeed[id] = { bytes, ts: now };
  if (!prev || !bytes || bytes < prev.bytes) return '';
  const dt = (now - prev.ts) / 1000;
  if (dt <= 0) return '';
  const perSec = (bytes - prev.bytes) / dt;
  return `${humanBytes(perSec)}/s`;
}

function renderJobs(jobs) {
  const section = document.getElementById('jobs');
  section.innerHTML = jobs.length === 0 ? '' : `<h2 style="margin:0 0 8px; font-size:1rem">Downloads</h2>`;

  for (const job of jobs) {
    const el = document.createElement('div');
    el.className = 'job';

    let pctText = '', barStyle = '';
    if (job.state === 'active') {
      const sp = speed(job.id, job.receivedBytes);
      if (job.totalBytes > 0) {
        const pct = Math.min(100, (job.receivedBytes / job.totalBytes) * 100);
        pctText = `${pct.toFixed(1)}%`;
        barStyle = `width:${pct}%`;
      } else {
        pctText = 'size unknown';
      }
      const label = sp ? `${humanBytes(job.receivedBytes)} · ${sp}` : humanBytes(job.receivedBytes);
      el.innerHTML = `
        <div class="job-line">
          <div class="job-url"></div>
          <div>
            <span class="badge badge-active">downloading</span>
            <button data-cancel="${job.id}">Cancel</button>
          </div>
        </div>
        <div class="bar"><div class="fill" style="${barStyle}"></div></div>
        <div class="job-meta"><span>${label}</span><span>${pctText}</span></div>`;
    } else {
      const badges = {
        done: '<span class="badge badge-done">done</span>',
        cancelled: '<span class="badge badge-cancelled">cancelled</span>',
        error: `<span class="badge badge-error" title="${job.error || ''}">error</span>`,
      };
      const size = job.receivedBytes > 0 ? humanBytes(job.receivedBytes) : '';
      el.innerHTML = `
        <div class="job-line">
          <div class="job-url"></div>
          ${badges[job.state] || ''}
          <button class="lib-del" data-rmjob="${job.id}" title="Remove from history and delete the file">🗑</button>
        </div>
        <div class="job-meta"><span>${size}</span><span>${job.file ? 'saved to ' + job.file : ''}</span><span>${job.error || ''}</span></div>`;
    }

    const urlEl = el.querySelector('.job-url');
    urlEl.textContent = job.url;
    section.appendChild(el);
  }

  for (const btn of section.querySelectorAll('[data-cancel]')) {
    btn.addEventListener('click', async () => {
      try { await api('/api/jobs/' + btn.dataset.cancel, { method: 'DELETE' }); refreshJobs(true); }
      catch (err) { alert(err.message); }
    });
  }

  for (const btn of section.querySelectorAll('[data-rmjob]')) {
    btn.addEventListener('click', async () => {
      const j = jobs.find((x) => x.id === btn.dataset.rmjob);
      const what = j ? (j.file || j.url) : '';
      const msg = j && j.file
        ? `Delete file "${j.file}" and remove it from history?`
        : `Remove "${what}" from history?`;
      if (!confirm(msg)) return;
      try { await api('/api/jobs/' + btn.dataset.rmjob, { method: 'DELETE' }); refreshJobs(true); }
      catch (err) { alert(err.message); }
    });
  }
}

async function refreshJobs() {
  if (state.authRequired && !state.user) return; // login screen is showing
  let jobs;
  try {
    jobs = await api('/api/jobs');
  } catch (err) {
    if (err.message === 'auth failed') return;
    jobs = [];
  }
  renderJobs(jobs);
  updateSpeedCap();
  if (!panelLib.hidden) refreshLibrary({ silent: true }); // keep library in sync while visible
  if (!panelQbt.hidden) refreshQbt(); // live torrent list + pause/resume
}

// ---------------------------------------------------------------------------
// Tabs + library (browse subfolders, delete files/folders)
// ---------------------------------------------------------------------------
const tabDl = document.getElementById('tab-dl');
const tabLib = document.getElementById('tab-lib');
const tabQbt = document.getElementById('tab-qbt');
const panelDl = document.getElementById('panel-dl');
const panelLib = document.getElementById('panel-lib');
const panelQbt = document.getElementById('panel-qbt');

function switchTab(which) {
  tabDl.classList.toggle('active', which === 'dl');
  tabLib.classList.toggle('active', which === 'lib');
  tabQbt.classList.toggle('active', which === 'qbt');
  panelDl.hidden = which !== 'dl';
  panelLib.hidden = which !== 'lib';
  panelQbt.hidden = which !== 'qbt';
  if (which === 'lib') refreshLibrary();
  if (which === 'qbt') { updateSpeedCap(); refreshQbt(); }
}

tabDl.addEventListener('click', () => switchTab('dl'));
tabLib.addEventListener('click', () => switchTab('lib'));
tabQbt.addEventListener('click', () => switchTab('qbt'));

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

async function refreshLibrary(opts = {}) {
  const crumb = document.getElementById('lib-breadcrumb');
  const content = document.getElementById('lib-content');
  // silent mode (background polling): don't wipe an already-rendered list
  if (!opts.silent || !content.children.length) {
    content.innerHTML = '<div class="lib-empty">Loading…</div>';
  }

  // breadcrumb
  const parts = state.libDir ? state.libDir.split('/') : [];
  let html = `<span class="crumb${parts.length === 0 ? ' current' : ''}" data-p="">~</span>`;
  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    html += `<span class="sep">/</span><span class="crumb${i === parts.length - 1 ? ' current' : ''}" data-p="${esc(acc)}">${esc(parts[i])}</span>`;
  }
  crumb.innerHTML = html;
  crumb.querySelectorAll('.crumb[data-p]').forEach((el) => {
    if (el.classList.contains('current')) return;
    el.addEventListener('click', () => { state.libDir = el.dataset.p || ''; refreshLibrary(); });
  });

  let data;
  try {
    data = await api('/api/files?p=' + encodeURIComponent(state.libDir));
  } catch (err) {
    if (err.message === 'auth failed') return;
    content.innerHTML = `<div class="lib-empty">${esc(err.message)}</div>`;
    return;
  }

  if (!data.dirs.length && !data.files.length) {
    content.innerHTML = '<div class="lib-empty">Folder is empty</div>';
    return;
  }

  let rows = '';
  for (const d of data.dirs) {
    const name = d.path.split('/').pop();
    rows += `
      <div class="lib-row">
        <span>📁</span>
        <a class="lib-open" data-dir="${esc(d.path)}">${esc(name)}</a>
        <button class="lib-del" data-rmdir="${esc(d.path)}" title="Delete folder with its contents">🗑</button>
      </div>`;
  }
  for (const f of data.files) {
    rows += `
      <div class="lib-row">
        <span>📄</span>
        <span class="lib-name">${esc(f.name)}</span>
        <span class="lib-size">${humanBytes(f.size)}</span>
        <span class="lib-date">${fmtDate(f.mtime)}</span>
        <button class="lib-del" data-rmfile="${esc(f.path)}" title="Delete file">🗑</button>
      </div>`;
  }
  content.innerHTML = rows;

  content.querySelectorAll('[data-dir]').forEach((el) => {
    el.addEventListener('click', () => { state.libDir = el.dataset.dir; refreshLibrary(); });
  });
  content.querySelectorAll('[data-rmdir]').forEach((el) => {
    el.addEventListener('click', async () => {
      const p = el.dataset.rmdir;
      if (!confirm(`Delete folder "${p}", including all its contents?`)) return;
      try { await api('/api/dir?p=' + encodeURIComponent(p), { method: 'DELETE' }); refreshLibrary(); }
      catch (err) { alert(err.message); }
    });
  });
  content.querySelectorAll('[data-rmfile]').forEach((el) => {
    el.addEventListener('click', async () => {
      const p = el.dataset.rmfile;
      if (!confirm(`Delete file "${p}"?`)) return;
      try { await api('/api/file?p=' + encodeURIComponent(p), { method: 'DELETE' }); refreshLibrary(); }
      catch (err) { alert(err.message); }
    });
  });
}

// ---------------------------------------------------------------------------
// qBittorrent tab (wrapper around the qbittorrent-filmy container)
// ---------------------------------------------------------------------------
const QBT_STATE_LABELS = {
  downloading: 'downloading', forcedDL: 'downloading',
  metaDL: 'fetching metadata', forcedMetaDL: 'fetching metadata',
  checking: 'checking', checkingDL: 'checking', checkingResumeData: 'checking',
  allocating: 'allocating', stalledDL: 'queued', queuedDL: 'queued',
  pausedDL: 'paused', stoppedDL: 'paused', moving: 'moving files',
  error: 'error', missingFiles: 'missing files',
};

const QBT_PAUSED_STATES = new Set(['pausedDL', 'stoppedDL']);

/** Show the effective DL cap (mirrors the server's qBittorrent schedule). */
async function updateSpeedCap() {
  const el = document.getElementById('speedcap');
  try {
    const s = await api('/api/qbt/status');
    if (s.enabled && s.limitBps > 0) {
      el.hidden = false;
      el.textContent = `Download speed cap: ${humanBytes(s.limitBps)}/s — mirrors the qBittorrent schedule` +
        (s.reachable ? '' : ' (qBittorrent offline, using last known value)');
    } else {
      el.hidden = true;
    }
  } catch (err) {
    if (err.message !== 'auth failed') el.hidden = true;
  }
}

async function refreshQbt() {
  const list = document.getElementById('qbt-list');
  let data;
  try {
    data = await api('/api/qbt/torrents');
  } catch (err) {
    if (err.message === 'auth failed') return;
    list.innerHTML = `<div class="lib-empty">${esc(err.message)}</div>`;
    return;
  }
  if (!data.length) {
    list.innerHTML = '<div class="lib-empty">No active torrents</div>';
    return;
  }

  let html = '';
  for (const t of data) {
    const label = QBT_STATE_LABELS[t.state] || t.state;
    const isPaused = QBT_PAUSED_STATES.has(t.state);
    const badgeCls = (t.state === 'downloading' || t.state === 'forcedDL') ? 'badge-active'
      : t.state === 'error' || t.state === 'missingFiles' ? 'badge-error'
      : isPaused ? 'badge-cancelled'
      : 'badge-muted';
    const pct = Math.max(0, Math.min(100, t.progress * 100));
    let metaText;
    if (t.size > 0) {
      metaText = `${humanBytes(t.downloaded)} / ${humanBytes(t.size)} · ${pct.toFixed(1)}%`;
      if (t.dlspeed > 0) metaText += ` · ${humanBytes(t.dlspeed)}/s`;
    } else {
      metaText = t.state === 'metaDL' ? 'getting info…' : `${pct.toFixed(1)}%`;
    }
    const btn = isPaused
      ? `<button class="btn-sm" data-qbt-resume="${t.hash}">Resume</button>`
      : `<button class="btn-sm" data-qbt-pause="${t.hash}">Pause</button>`;
    html += `
      <div class="qbt-row">
        <div class="qbt-line">
          <span class="qbt-name"></span>
          <span class="badge ${badgeCls}">${label}</span>
          ${btn}
        </div>
        <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
        <div class="job-meta"><span>${metaText}</span></div>
      </div>`;
  }
  list.innerHTML = html;

  // names set via textContent (may contain <, &, …)
  let i = 0;
  for (const el of list.querySelectorAll('.qbt-name')) el.textContent = data[i++].name;

  for (const btn of list.querySelectorAll('[data-qbt-pause],[data-qbt-resume]')) {
    btn.addEventListener('click', async () => {
      const isPause = btn.hasAttribute('data-qbt-pause');
      const h = isPause ? btn.dataset.qbtPause : btn.dataset.qbtResume;
      try {
        await api('/api/qbt/' + (isPause ? 'pause' : 'resume'), {
          method: 'POST', body: JSON.stringify({ hashes: [h] }),
        });
        refreshQbt();
      } catch (err) { alert(err.message); }
    });
  }
}

// add a torrent from a magnet link or an uploaded .torrent file
document.getElementById('qbt-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('qbt-error');
  const magnet = document.getElementById('qbt-magnet').value.trim();
  const fileInput = document.getElementById('qbt-file');
  const btn = document.getElementById('qbt-add-btn');
  errEl.textContent = '';
  if (!magnet && !fileInput.files.length) {
    errEl.textContent = 'Paste a magnet link or choose a .torrent file';
    return;
  }
  btn.disabled = true;
  try {
    let body;
    if (magnet.startsWith('magnet:')) {
      body = JSON.stringify({ magnet });
    } else if (fileInput.files.length) {
      const f = fileInput.files[0];
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      body = JSON.stringify({ b64: btoa(bin), filename: f.name });
    } else {
      errEl.textContent = 'Paste a magnet link or choose a .torrent file';
      return;
    }
    await api('/api/qbt/torrents', { method: 'POST', body });
    document.getElementById('qbt-magnet').value = '';
    fileInput.value = '';
    refreshQbt();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Init & polling
// ---------------------------------------------------------------------------
(async function init() {
  try {
    const status = await api('/api/status');
    state.authRequired = status.authRequired;
    if (!state.authRequired) {
      showApp(); // no AUTH_PASS configured - open interface
    } else if (state.user) {
      // saved credentials from a previous visit - verify them
      try { await api('/api/jobs'); showApp(); } catch { /* login screen re-shown by api() */ }
    } else {
      showLogin();
    }
  } catch (err) {
    console.error('init failed:', err.message);
    showApp(); // don't leave a blank page if the status call itself fails
  }
  refreshDirs();
  refreshJobs();
  setInterval(() => refreshJobs(), 1500);
})();
