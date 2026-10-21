// Smoke test: boots the real server and exercises a download end-to-end.
// No external network needed - the app downloads from a local file server.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3900 + Math.floor(Math.random() * 100);
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'odm-test-'));
const PAYLOAD = Buffer.from('open-download-manager smoke test payload\n'.repeat(20));

// tiny file server the app will download from
const fileSrv = http.createServer((req, res) => {
  if (req.url === '/file.txt') {
    res.setHeader('content-length', String(PAYLOAD.length));
    res.end(PAYLOAD);
  } else {
    res.statusCode = 404;
    res.end('nope');
  }
});
await new Promise((r) => fileSrv.listen(0, '127.0.0.1', r));
const srcBase = `http://127.0.0.1:${fileSrv.address().port}`;

const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), ROOT_DIR: ROOT, AUTH_USER: 'admin', AUTH_PASS: 'pass' },
  stdio: 'inherit',
});

const auth = { Authorization: 'Basic ' + Buffer.from('admin:pass').toString('base64') };
const api = (p) => `http://127.0.0.1:${PORT}${p}`;

let createdJobId = null;
try {
  // wait for the server to come up
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await sleep(200);
    try { up = (await fetch(api('/healthz'))).ok; } catch { /* not yet */ }
  }
  assert.ok(up, 'server did not start');

  // unauthenticated request is rejected
  assert.equal((await fetch(api('/api/jobs'))).status, 401);

  // successful download (also exercises nested destination creation)
  const created = await fetch(api('/api/jobs'), {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${srcBase}/file.txt`, dest: 'sub/dir' }),
  });
  assert.equal(created.status, 201);
  const job = await created.json();
  let finished;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const list = await (await fetch(api('/api/jobs'), { headers: auth })).json();
    finished = list.find((j) => j.id === job.id);
    if (finished && finished.state !== 'active') break;
  }
  assert.equal(finished?.state, 'done', `expected done, got ${JSON.stringify(finished)}`);
  assert.ok(finished.finishedAt > 0, 'finishedAt not set');
  const written = await fs.readFile(path.join(ROOT, finished.file));
  assert.ok(written.equals(PAYLOAD), 'downloaded file content mismatch');

  // failed download (HTTP 404 source) ends in error state
  const bad = await fetch(api('/api/jobs'), {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${srcBase}/missing.txt`, dest: '' }),
  });
  assert.equal(bad.status, 201);
  createdJobId = (await bad.json()).id;
  let badFinished;
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const list = await (await fetch(api('/api/jobs'), { headers: auth })).json();
    badFinished = list.find((j) => j.id === createdJobId);
    if (badFinished && badFinished.state !== 'active') break;
  }
  assert.equal(badFinished?.state, 'error', `expected error, got ${JSON.stringify(badFinished)}`);
  assert.match(badFinished.error, /404/);

  console.log('smoke test passed');
} finally {
  child.kill();
  fileSrv.close();
  await fs.rm(ROOT, { recursive: true, force: true });
}
