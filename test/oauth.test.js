// OAuth hardening tests: start the real server with dummy credentials and walk the
// Google account-linking flow. No SensorPush API calls are made.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 39000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-oauth-'));
const ENV = {
  PORT: String(PORT),
  SENSORPUSH_EMAIL: 'test@example.com',
  SENSORPUSH_PASSWORD: 'unused',
  OAUTH_CLIENT_ID: 'test-client',
  OAUTH_CLIENT_SECRET: 'test-secret',
  OAUTH_OWNER_PASSWORD: 'owner-pass',
  OAUTH_PROJECT_ID: 'proj-123',
  TOKEN_STORE_PATH: path.join(TMP, 'tokens.json'),
};
const REDIRECT = 'https://oauth-redirect.googleusercontent.com/r/proj-123';

let server;

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
      env: { ...process.env, ...ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const onData = (chunk) => {
      output += chunk;
      if (output.includes('running on port')) resolve(proc);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (chunk) => { output += chunk; });
    proc.on('exit', (code) => reject(new Error(`server exited ${code}: ${output}`)));
    proc.output = () => output;
  });
}

async function stopServer(proc) {
  proc.removeAllListeners('exit');
  const exited = new Promise((resolve) => proc.on('exit', resolve));
  proc.kill();
  await exited;
}

function authQuery(overrides = {}) {
  return new URLSearchParams({
    client_id: 'test-client',
    redirect_uri: REDIRECT,
    state: 'st&ate=1',
    response_type: 'code',
    ...overrides,
  });
}

async function login(password = 'owner-pass', overrides = {}) {
  const body = authQuery(overrides);
  body.set('password', password);
  return fetch(`${BASE}/auth`, { method: 'POST', body, redirect: 'manual' });
}

async function getCode() {
  const res = await login();
  assert.strictEqual(res.status, 302);
  return new URL(res.headers.get('location')).searchParams.get('code');
}

function tokenRequest(fields) {
  return fetch(`${BASE}/token`, { method: 'POST', body: new URLSearchParams(fields) });
}

before(async () => { server = await startServer(); });
after(async () => {
  if (server) await stopServer(server);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('GET /auth with valid params shows the login page, no code', async () => {
  const res = await fetch(`${BASE}/auth?${authQuery()}`, { redirect: 'manual' });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /type="password"/);
  assert.match(html, /st&amp;ate=1/, 'state is HTML-escaped');
  // form-action also governs the post-login redirect; without Google's origin the browser blocks it
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /form-action [^;]*https:\/\/oauth-redirect\.googleusercontent\.com/);
  assert.match(csp, /form-action [^;]*https:\/\/oauth-redirect-sandbox\.googleusercontent\.com/);
});

test('GET /auth rejects unknown client_id, foreign redirect_uri, wrong response_type', async () => {
  for (const overrides of [
    { client_id: 'evil' },
    { redirect_uri: 'https://evil.example.com/cb' },
    { redirect_uri: 'https://oauth-redirect.googleusercontent.com/r/other-project' },
    { response_type: 'token' },
  ]) {
    const res = await fetch(`${BASE}/auth?${authQuery(overrides)}`, { redirect: 'manual' });
    assert.strictEqual(res.status, 400, JSON.stringify(overrides));
    assert.strictEqual(res.headers.get('location'), null);
  }
});

test('GET /auth with no params is 400', async () => {
  const res = await fetch(`${BASE}/auth`, { redirect: 'manual' });
  assert.strictEqual(res.status, 400);
});

test('POST /auth with wrong password does not issue a code', async () => {
  const res = await login('wrong');
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.headers.get('location'), null);
});

test('POST /auth cannot be pointed at a foreign redirect_uri', async () => {
  const res = await login('owner-pass', { redirect_uri: 'https://evil.example.com/cb' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.headers.get('location'), null);
});

test('POST /auth with the owner password redirects to Google with code and state', async () => {
  const res = await login();
  assert.strictEqual(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.strictEqual(`${location.origin}${location.pathname}`, REDIRECT);
  assert.ok(location.searchParams.get('code'));
  assert.strictEqual(location.searchParams.get('state'), 'st&ate=1');
});

test('GET /token stays 404 (HomeOps heartbeat depends on it)', async () => {
  const res = await fetch(`${BASE}/token`);
  assert.strictEqual(res.status, 404);
});

test('POST /token rejects bad client credentials', async () => {
  const code = await getCode();
  for (const creds of [
    { client_id: 'test-client', client_secret: 'wrong' },
    { client_id: 'evil', client_secret: 'test-secret' },
    {},
  ]) {
    const res = await tokenRequest({ grant_type: 'authorization_code', code, ...creds });
    assert.strictEqual(res.status, 401, JSON.stringify(creds));
  }
});

test('POST /token rejects a redirect_uri that differs from the code', async () => {
  const code = await getCode();
  const res = await tokenRequest({
    grant_type: 'authorization_code', code, client_id: 'test-client', client_secret: 'test-secret',
    redirect_uri: 'https://oauth-redirect-sandbox.googleusercontent.com/r/proj-123',
  });
  assert.strictEqual(res.status, 400);
});

test('POST /fulfillment without or with a bogus bearer is 401', async () => {
  for (const headers of [{}, { Authorization: 'Bearer nope' }]) {
    const res = await fetch(`${BASE}/fulfillment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    });
    assert.strictEqual(res.status, 401);
  }
});

test('full flow: code → tokens (Basic auth) → fulfillment → refresh → restart persists → disconnect revokes', async () => {
  const code = await getCode();
  const basic = Buffer.from('test-client:test-secret').toString('base64');
  let res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }),
  });
  assert.strictEqual(res.status, 200);
  const tokens = await res.json();
  assert.ok(tokens.access_token && tokens.refresh_token);

  // Codes are single use
  res = await tokenRequest({ grant_type: 'authorization_code', code, client_id: 'test-client', client_secret: 'test-secret' });
  assert.strictEqual(res.status, 400);

  // Refresh tokens are not access tokens
  const execute = (token) => fetch(`${BASE}/fulfillment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requestId: 'r1',
      inputs: [{ intent: 'action.devices.EXECUTE', payload: { commands: [{ devices: [{ id: 'x' }], execution: [] }] } }],
    }),
  });
  assert.strictEqual((await execute(tokens.refresh_token)).status, 401);

  res = await execute(tokens.access_token);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).requestId, 'r1');

  // Refresh grant (credentials in body, as Google sends them)
  res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'test-client', client_secret: 'test-secret' });
  assert.strictEqual(res.status, 200);
  const refreshed = await res.json();

  // Tokens survive a restart, and only hashes are on disk
  const onDisk = fs.readFileSync(ENV.TOKEN_STORE_PATH, 'utf8');
  assert.ok(!onDisk.includes(tokens.access_token) && !onDisk.includes(tokens.refresh_token));
  assert.ok(!server.output().includes(tokens.access_token), 'access token not logged');
  await stopServer(server);
  server = await startServer();
  assert.strictEqual((await execute(refreshed.access_token)).status, 200);

  // DISCONNECT revokes everything
  res = await fetch(`${BASE}/fulfillment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${refreshed.access_token}` },
    body: JSON.stringify({ requestId: 'r2', inputs: [{ intent: 'action.devices.DISCONNECT' }] }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await execute(refreshed.access_token)).status, 401);
  res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'test-client', client_secret: 'test-secret' });
  assert.strictEqual(res.status, 400);
});

test('server refuses to start without required OAuth env', async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, ...ENV, OAUTH_OWNER_PASSWORD: '', PORT: String(PORT + 1) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  assert.strictEqual(code, 1);
  assert.match(stderr, /OAUTH_OWNER_PASSWORD/);
});

test('owner login locks out after repeated failures', async () => {
  for (let i = 0; i < 10; i++) await login('wrong');
  const res = await login();
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.headers.get('location'), null);
});
