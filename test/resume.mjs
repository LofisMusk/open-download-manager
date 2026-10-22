// Restart/resume test: reproduces a redeploy killing a download mid-flight.
// Hard-kills the server partway through a slow download, boots it again on the
// same root dir and checks that (1) no orphaned .part is left invisible,
// (2) the job reappears as "interrupted", and (3) resume() finishes the file
// - both when the source honours HTTP Range and when it ignores it.
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 4100 + Math.floor(Math.random() * 100);
const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'odm-resume-test-'));
const PAYLOAD_A = crypto.randomBytes(384 * 1024); // Range-honouring source
const PAYLOAD_B = crypto.randomBytes(384 * 1024); // ignores Range (always 200)

// slow file server: /slow.bin honours Range, /norange.bin does not.
// Both drip the payload in small chunks so we can kill the app mid-download.
const stats = { range: 0, noRangeFull: 0 };
const CHUNK = 16 * 1024;
const DRIp_MS = 40;

async function drip(res, buf) {
  for (let i = 0; i < buf.length; i += CHUNK) {
    await new Promise((resolve) => {
      res.write(buf.subarray(i, i + CHUNK), () => sleep(DRIp_MS).then(resolve));
    });
  }
  res.end();
}

const fileSrv = http.createServer(async (req, res) => {
  const range = req.headers.range; // "bytes=N-"
  if (req.url === '/slow.bin') {
    if (range) {
      const start = Number(range.replace(/^bytes=/, '').replace(/-$/, ''));
      stats.range += 1;
      res.statusCode = 206;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', String(PAYLOAD_A.length - start));
      res.setHeader('content-range', `bytes ${start}-${PAYLOAD_A.length - 1}/${PAYLOAD_A.length}`);
      await drip(res, PAYLOAD_A.subarray(start));
    } else {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', String(PAYLOAD_A.length));
      await drip(res, PAYLOAD_A);
    }
  } else if (req.url === '/norange.bin') {
    if (!range) stats.noRangeFull += 1;
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(PAYLOAD_B.length));
    await drip(res, PAYLOAD_B); // full body even when a Range was requested
  } else {
    res.statusCode = 404;
    res.end('nope');
  }
});
await new Promise((r) => fileSrv.listen(0, '127.0.0.1', r));
const srcBase = `http://127.0.0.1:${fileSrv.address().port}`;

function startApp() {
  return spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), ROOT_DIR: ROOT, AUTH_USER: 'admin', AUTH_PASS: 'pass' },
    stdio: 'inherit',
  });
}

const auth = { Authorization: 'Basic ' + Buffer.from('admin:pass').toString('base64') };
const api = (p) => `http://127.0.0.1:${PORT}${p}`;

async function waitUp(child) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(api('/healthz'))).ok) return; } catch { /* not yet */ }
    await sleep(200);
  }
  throw new Error('server did not start');
}

async function findParts(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.part')) out.push(path.join(dir, e.name));
  }
  return out;
}

async function killMidDownload(child, destRel, payload) {
  const dir = path.join(ROOT, destRel);
  // wait until a meaningful slice of the file is on disk, then hard-kill (no SIGTERM cleanup)
  for (let i = 0; i < 300; i++) {
    const parts = await findParts(dir);
    if (parts.length === 1) {
      const st = await fs.stat(parts[0]);
      if (st.size >= payload.length * 0.35 && st.size <= payload.length * 0.9) break;
    }
    await sleep(100);
  }
  child.kill('SIGKILL'); // simulate `docker stop` after grace / power loss / container replace
  await new Promise((r) => child.on('exit', r));
}

async function waitForJob(id, predicate, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = await (await fetch(api('/api/jobs'), { headers: auth })).json();
    const job = list.find((j) => j.id === id);
    if (job && predicate(job)) return job;
    await sleep(200);
  }
  throw new Error(`job ${id} did not reach the expected state`);
}

let child;
try {
  // --- phase A: hard kill mid-download, source honours Range --------------
  child = startApp();
  await waitUp(child);
  const createdA = await fetch(api('/api/jobs'), {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${srcBase}/slow.bin`, dest: 'resumed' }),
  });
  assert.equal(createdA.status, 201);
  const jobA = await createdA.json();

  await killMidDownload(child, 'resumed', PAYLOAD_A);
  // the sidecar must have been persisted while the download was running
  const dirA = path.join(ROOT, 'resumed');
  const partsAfterKill = await findParts(dirA);
  assert.equal(partsAfterKill.length, 1, 'expected exactly one .part file after the hard kill');
  let meta = null;
  try { meta = JSON.parse(await fs.readFile(partsAfterKill[0] + '.meta.json', 'utf8')); } catch { /* asserted below */ }
  assert.ok(meta && meta.url === `${srcBase}/slow.bin`, 'sidecar metadata missing or wrong');

  // restart on the same root: the partial must come back as an interrupted job
  child = startApp();
  await waitUp(child);
  const interruptedA = await waitForJob(jobA.id, (j) => j.state === 'interrupted', 5000);
  const partA = (await findParts(dirA))[0];
  assert.equal(interruptedA.receivedBytes, (await fs.stat(partA)).size, 'interrupted job must reflect the on-disk partial size');

  const rangeBefore = stats.range;
  await fetch(api(`/api/jobs/${jobA.id}/resume`), { method: 'POST', headers: auth });
  const doneA = await waitForJob(jobA.id, (j) => j.state === 'done');
  assert.equal(doneA.file, path.posix.join('resumed', 'slow.bin'));
  assert.ok((await fs.readFile(path.join(ROOT, doneA.file))).equals(PAYLOAD_A), 'resumed content mismatch');
  assert.ok(stats.range > rangeBefore, 'resume should have continued via a Range request');

  // --- phase B: hard kill mid-download, source ignores Range --------------
  const createdB = await fetch(api('/api/jobs'), {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${srcBase}/norange.bin`, dest: 'resumed' }),
  });
  assert.equal(createdB.status, 201);
  const jobB = await createdB.json();

  await killMidDownload(child, 'resumed', PAYLOAD_B);
  child = startApp(); // third boot: recovery must find phase B's partial too
  await waitUp(child);

  const fullRefetchBefore = stats.noRangeFull;
  const interruptedB = await waitForJob(jobB.id, (j) => j.state === 'interrupted', 5000);
  assert.ok(interruptedB);
  await fetch(api(`/api/jobs/${jobB.id}/resume`), { method: 'POST', headers: auth });
  const doneB = await waitForJob(jobB.id, (j) => j.state === 'done');
  assert.ok((await fs.readFile(path.join(ROOT, doneB.file))).equals(PAYLOAD_B), 'fallback re-download content mismatch');
  assert.ok(stats.noRangeFull > fullRefetchBefore, 'Range-ignoring source must trigger a fresh full download');

  // --- no orphans left behind ------------------------------------------------
  const leftovers = (await findParts(path.join(ROOT, 'resumed'))).concat(
    (await fs.readdir(path.join(ROOT, 'resumed'))).filter((n) => n.endsWith('.meta.json')),
  );
  assert.deepEqual(leftovers, [], `orphaned files remain: ${leftovers}`);

  console.log('resume test passed');
} finally {
  if (child && !child.killed) child.kill();
  fileSrv.close();
  await fs.rm(ROOT, { recursive: true, force: true });
}
