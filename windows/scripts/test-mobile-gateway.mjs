import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const gatewayFile = path.resolve(directory, '..', 'mobile-gateway.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function freePort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitFor(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url, { redirect: 'manual' })).status > 0) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Mobile gateway did not start.');
}

const upstream = createServer((_request, response) => {
  const html = '<!doctype html><html><head><title>Harness test</title></head><body><main>Harness mobile</main></body></html>';
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  response.end(html);
});
const upstreamPort = await listen(upstream);
const gatewayPort = await freePort();
const token = 'mobile-gateway-test-token-1234567890';
const child = spawn(process.execPath, [gatewayFile, '--token', token, '--allowed-prefix', '192.168.',
  '--port', String(gatewayPort), '--upstream-port', String(upstreamPort)], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-5000); });
child.on('message', (message) => {
  if (message?.type !== 'mobile-control') return;
  child.send({ type: 'mobile-control-result', id: message.id, result: { ok: true, received: message.action?.type } });
});

try {
  const root = `http://127.0.0.1:${gatewayPort}`;
  await waitFor(root);
  const rejected = await fetch(root, { redirect: 'manual' });
  if (rejected.status !== 401) throw new Error(`Expected unauthenticated 401, received ${rejected.status}.`);
  const accepted = await fetch(`${root}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const cookie = accepted.headers.get('set-cookie')?.split(';')[0] || '';
  if (accepted.status !== 302 || !cookie) throw new Error('Token exchange did not create the access cookie.');
  const page = await fetch(root, { headers: { Cookie: cookie } });
  const html = await page.text();
  for (const marker of ['dsh-mobile-shell', 'dsy-mobile-nav', '__dshMobileClient=true', 'dsh-mobile-style']) {
    if (!html.includes(marker)) throw new Error(`Missing mobile marker: ${marker}`);
  }
  const control = await fetch(`${root}/deep-seek-yu/mobile-control`, {
    method: 'POST', headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'desktop-pet:get-settings', payload: {} }),
  });
  const result = await control.json();
  if (!control.ok || result.result?.received !== 'desktop-pet:get-settings') {
    throw new Error(`Mobile control bridge failed: ${JSON.stringify(result)}`);
  }
  process.stdout.write('mobile gateway test passed\n');
} finally {
  child.kill();
  await new Promise((resolve) => upstream.close(resolve));
  if (child.exitCode && child.exitCode !== 0) process.stderr.write(stderr);
}
