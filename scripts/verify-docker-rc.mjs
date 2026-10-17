#!/usr/bin/env node
// End-to-end check of a locally built server image (see docs/DOCKER-SERVER.md).
//
//   npm run verify:docker -- --image smart-family-chore-chart-server:rc-<commit> [--port 3194]
//
// Uses ONLY synthetic data, in a disposable Compose project with a unique
// name (sfcc-verify-<id>), so its own volume, network and container are the
// only things it creates and the only things it removes. It never pulls or
// builds an image (the exact local tag must exist), refuses ports that are
// in use (and 4173/4174 outright), and leaves every other container,
// volume and service alone. Needs Docker and the installed Google Chrome
// (as the browser tests do). Exit code 0 only if every check passed.
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const image = arg('image');
const port = Number(arg('port', '3194'));
if (!image || image.endsWith(':latest') || !image.includes(':')) {
  console.error('Usage: npm run verify:docker -- --image <name>:<tag> [--port <port>]   (an explicit tag, never "latest")');
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4173 || port === 4174) {
  console.error(`Refusing port ${port}: use a free port from 1024-65535 (4173 and 4174 are never used).`);
  process.exit(2);
}

const PROJECT = `sfcc-verify-${Date.now().toString(36)}`;
const base = `http://localhost:${port}`;
const env = { ...process.env, SFCC_SERVER_IMAGE: image, SFCC_HOST_PORT: String(port), SFCC_TIMEZONE: 'Europe/London' };
delete env.SFCC_COOKIE_SECURE;
delete env.SFCC_TRUST_PROXY;
const USER = 'rcparent';
const PASSWORD = 'synthetic test passphrase';
const results = [];

const run = (cmd, args, extraEnv = env) => execFileSync(cmd, args, { cwd: repo, env: extraEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const compose = (...args) => run('docker', ['compose', '-p', PROJECT, '-f', 'compose.server.yaml', ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failText = (fn) => {
  try {
    fn();
    return '';
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
};
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
function portInUse(host) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(false)));
  });
}

let containerId = '';
const devCheckName = `${PROJECT}-devcheck`;
let browser;

async function waitHealthy() {
  for (let i = 0; i < 90; i++) {
    const s = run('docker', ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{end}}', containerId]).trim();
    if (s === 'healthy') return true;
    if (s === 'unhealthy') return false;
    await sleep(1000);
  }
  return false;
}
const status = async (ctx) => (await ctx.request.get(`${base}/api/auth/status`)).json();
const cookie = async (ctx, name) => (await ctx.cookies()).find((c) => c.name === name)?.value;
async function replay(name, value) {
  const c = await browser.newContext();
  await c.addCookies([{ name, value, url: base }]);
  const s = await status(c);
  await c.close();
  return s;
}
async function command(ctx, type, payload = {}) {
  const r = await ctx.request.post(`${base}/api/commands`, { data: { type, payload } });
  return r.status();
}
async function dismissReminder(page) {
  const later = page.getByRole('button', { name: 'Remind me tomorrow' });
  if (await later.isVisible({ timeout: 1500 }).catch(() => false)) await later.click();
}
async function signInOnScreen(page) {
  const dialog = page.getByRole('dialog', { name: 'Parent sign in' });
  await dialog.getByLabel('Username').fill(USER);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
}

async function main() {
  // ---------- preconditions (nothing created yet) ----------
  // Throws (stopping the run before anything is created) if the tag isn't here.
  const inspect = JSON.parse(run('docker', ['image', 'inspect', image]))[0];
  check('the exact image exists locally (never pulled or built)', Boolean(inspect.Id), `${inspect.Id.slice(7, 19)} ${inspect.Os}/${inspect.Architecture}`);
  if ((await portInUse('127.0.0.1')) || (await portInUse('::1'))) throw new Error(`Port ${port} is already in use; choose another with --port.`);
  const config = JSON.parse(compose('config', '--format', 'json'));
  check('compose.server.yaml resolves to exactly this tag', config.services.app.image === image, config.services.app.image);
  check('compose.server.yaml never pulls', config.services.app.pull_policy === 'never');
  const unset = { ...env };
  delete unset.SFCC_SERVER_IMAGE;
  check('without SFCC_SERVER_IMAGE Compose refuses (no silent default)', /SFCC_SERVER_IMAGE/.test(failText(() => run('docker', ['compose', '-p', PROJECT, '-f', 'compose.server.yaml', 'config'], unset))));

  // ---------- start ----------
  compose('up', '-d', '--pull', 'never', '--no-build');
  containerId = compose('ps', '-q', 'app').trim();
  check('container starts and becomes healthy', await waitHealthy());
  check('the container runs the exact image', run('docker', ['inspect', '-f', '{{.Image}}', containerId]).trim() === inspect.Id);
  check('runs as the unprivileged node user (uid 1000)', run('docker', ['exec', containerId, 'id', '-u']).trim() === '1000');
  check('NODE_ENV=production', run('docker', ['exec', containerId, 'printenv', 'NODE_ENV']).trim() === 'production');
  check('port published on loopback only', /^127\.0\.0\.1:/.test(run('docker', ['port', containerId, '3000']).trim()), run('docker', ['port', containerId, '3000']).trim());
  const ready = await (await fetch(`${base}/readyz`)).json();
  check('/readyz reports ready', ready.status === 'ready');

  // ---------- development-only mode is unavailable ----------
  check(
    'the --dev-unauthenticated-api flag is refused',
    /cannot be used with NODE_ENV=production/.test(failText(() => run('docker', ['exec', containerId, 'node', 'dist-server/main.js', '--dev-unauthenticated-api']))),
  );
  check(
    'SFCC_DEV_UNAUTHENTICATED_API=1 makes the image refuse to start',
    /Refusing to start/.test(failText(() => run('docker', ['run', '--rm', '--name', devCheckName, '--network', 'none', '-e', 'SFCC_DEV_UNAUTHENTICATED_API=1', image]))),
  );
  const anon = await fetch(`${base}/api/state`);
  check('family data needs sign-in (401) and there is no dev-mode header', anon.status === 401 && !anon.headers.get('x-sfcc-dev-mode'));
  const anonStatus = await (await fetch(`${base}/api/auth/status`)).json();
  check('normal mode, setup required', anonStatus.devMode === false && anonStatus.setupRequired === true);

  // ---------- first-run setup ----------
  const code = /setup code: ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(compose('logs', 'app'))?.[1];
  check('setup code printed in the container logs', Boolean(code));
  browser = await chromium.launch({ channel: 'chrome' });
  const parent = await browser.newContext();
  const pp = await parent.newPage();
  await pp.goto(base);
  await pp.getByLabel('Setup code').fill(code);
  await pp.getByLabel('Your name').fill('RC Parent');
  await pp.getByLabel('Username').fill(USER);
  await pp.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await pp.getByLabel('Type the password again').fill(PASSWORD);
  await pp.getByRole('button', { name: 'Create parent account' }).click();
  await pp.getByRole('button', { name: /Parent area/ }).first().waitFor();
  check('first-run setup in the app creates and signs in the parent', (await status(parent)).parent?.username === USER);
  const again = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupCode: code, username: 'intruder', displayName: 'X', password: 'another long passphrase' }),
  });
  check('the setup code can’t be used again', again.status === 409);

  // ---------- parent authentication ----------
  const other = await browser.newContext();
  const op = await other.newPage();
  await op.goto(base);
  await op.getByRole('button', { name: 'Parent sign in' }).click();
  const dialog = op.getByRole('dialog', { name: 'Parent sign in' });
  await dialog.getByLabel('Username').fill(USER);
  await dialog.getByLabel('Password').fill('wrong password here');
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await dialog.getByText(/don’t match/).waitFor();
  check('a wrong password is refused', (await status(other)).parent === null);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await op.getByRole('button', { name: /Parent area/ }).first().waitFor();
  check('the right password signs in on a second browser', (await status(other)).parent?.username === USER);
  await other.close();

  // ---------- pairing and shared data ----------
  check('the parent loads a synthetic demo family', (await command(parent, 'loadDemoFamily')) === 200);
  const pairing = await (await parent.request.post(`${base}/api/devices/pairing-codes`, { data: { name: 'Verify kiosk' } })).json();
  const kiosk = await browser.newContext();
  const kp = await kiosk.newPage();
  await kp.goto(base);
  await kp.getByLabel('Pairing code').fill(pairing.code);
  await kp.getByRole('button', { name: 'Pair this device' }).click();
  await dismissReminder(kp);
  const firstChild = (await (await parent.request.get(`${base}/api/state`)).json()).family.children[0].name;
  await kp.getByText(firstChild).first().waitFor();
  check('a kiosk paired with a code shows the family', true, firstChild);
  const state = await (await kiosk.request.get(`${base}/api/state`)).json();
  const before = state.family.completions.length;
  check('the kiosk can tick a chore', (await command(kiosk, 'toggleChore', { choreId: state.family.chores[0].id })) === 200);
  const seen = (await (await parent.request.get(`${base}/api/state`)).json()).family.completions.length;
  check('the parent sees the kiosk’s tick (shared data)', seen === before + 1, `${before} -> ${seen}`);
  check('the kiosk can’t do parent-only things (403)', (await command(kiosk, 'saveChild', { name: 'Nope', avatar: '🐼', color: 'teal' })) === 403);
  const deviceToken = await cookie(kiosk, 'sfcc_device');

  // ---------- restart persistence ----------
  compose('restart', 'app');
  check('healthy again after a restart', await waitHealthy());
  const after = await (await parent.request.get(`${base}/api/state`)).json();
  check('family data persists across the restart', after.family.completions.length === before + 1 && after.family.children[0].name === firstChild);
  check('parent and device sessions persist across the restart', (await status(parent)).parent !== null && (await status(kiosk)).device !== null);

  // ---------- kiosk reload ----------
  await kp.goto(base);
  await dismissReminder(kp);
  await kp.getByRole('button', { name: /Parent area/ }).first().click();
  await signInOnScreen(kp);
  await kp.getByRole('heading', { name: /Parent area/ }).waitFor();
  const kioskParent = await cookie(kiosk, 'sfcc_parent');
  await kp.reload();
  await dismissReminder(kp);
  let ended = false;
  for (let i = 0; i < 20 && !ended; i++) {
    ended = (await replay('sfcc_parent', kioskParent)).parent === null;
    if (!ended) await sleep(250);
  }
  check('a kiosk reload ends the parent session on the server', ended);
  await kp.getByRole('button', { name: /Parent area/ }).first().click();
  check('after the reload the parent area asks for the password', await kp.getByRole('dialog', { name: 'Parent sign in' }).isVisible({ timeout: 5000 }).catch(() => false));

  // ---------- idle lock (fake page clock) ----------
  const idle = await browser.newContext();
  await idle.addCookies([{ name: 'sfcc_device', value: deviceToken, url: base }]);
  const ip = await idle.newPage();
  await ip.clock.install();
  await ip.goto(base);
  await dismissReminder(ip);
  await ip.getByRole('button', { name: /Parent area/ }).first().click();
  await signInOnScreen(ip);
  await ip.getByRole('heading', { name: /Parent area/ }).waitFor();
  const idleToken = await cookie(idle, 'sfcc_parent');
  await ip.clock.runFor(29 * 60_000);
  check('still open after 29 idle minutes', (await ip.getByRole('heading', { name: /Parent area/ }).count()) === 1);
  let locked = false;
  for (let t = 0; t < 8 && !locked; t++) {
    await ip.clock.runFor(15_000);
    locked = (await ip.getByRole('heading', { name: /Parent area/ }).count()) === 0;
  }
  check('locked after 30 minutes without input', locked);
  let idleEnded = false;
  for (let i = 0; i < 20 && !idleEnded; i++) {
    idleEnded = (await replay('sfcc_parent', idleToken)).parent === null;
    if (!idleEnded) await sleep(250);
  }
  check('the idle lock ended the session on the server', idleEnded);
  await idle.close();

  // ---------- sign-out ----------
  const own = await cookie(parent, 'sfcc_parent');
  await pp.goto(base);
  await dismissReminder(pp);
  await pp.getByRole('button', { name: /Parent area/ }).first().click();
  await pp.getByRole('heading', { name: /Parent area/ }).waitFor();
  await pp.getByRole('tab', { name: /Family access/ }).click();
  await pp.getByRole('button', { name: 'Sign out' }).click();
  await pp.getByText('Signed out.', { exact: true }).waitFor();
  check('sign-out is confirmed and ends the session on the server', (await replay('sfcc_parent', own)).parent === null);

  // ---------- backup, restore and session invalidation ----------
  await pp.getByRole('button', { name: 'Parent sign in' }).click();
  await signInOnScreen(pp);
  await pp.getByRole('button', { name: /Parent area/ }).first().waitFor();
  const backupFile = /\/data\/backups\/\S+\.db/.exec(compose('exec', '-T', 'app', 'node', 'dist-server/cli.js', 'backup', 'verify'))?.[0];
  check('an online backup is written and verified', Boolean(backupFile), backupFile);
  check('a change after the backup', (await command(parent, 'saveChild', { name: 'After Backup', avatar: '🦊', color: 'teal' })) === 200);
  const parentToken = await cookie(parent, 'sfcc_parent');
  compose('stop', 'app');
  const restored = compose('run', '--rm', '-T', '--no-deps', 'app', 'node', 'dist-server/cli.js', 'restore', backupFile, '--yes');
  check('the offline restore runs and says everyone was signed out', /Everyone was signed out/.test(restored));
  compose('start', 'app');
  check('healthy after the restore', await waitHealthy());
  check('the parent session from before the restore is refused', (await replay('sfcc_parent', parentToken)).parent === null);
  check('the paired device from before the restore is refused', (await replay('sfcc_device', deviceToken)).device === null);
  const relogin = await browser.newContext();
  check('the parent can sign in again', (await relogin.request.post(`${base}/api/auth/login`, { data: { username: USER, password: PASSWORD } })).status() === 200);
  const data = await (await relogin.request.get(`${base}/api/state`)).json();
  check('the family data is as it was at the backup', !data.family.children.some((c) => c.name === 'After Backup') && data.family.children[0].name === firstChild);
  const listing = compose('exec', '-T', 'app', 'ls', '/data/backups');
  check('the replaced database was kept aside', /^replaced-\S+\.db$/m.test(listing));

  // ---------- recovery ----------
  const temp = /Temporary password for \S+: (\S+)/.exec(compose('exec', '-T', 'app', 'node', 'dist-server/cli.js', 'reset-password', USER))?.[1];
  const withTemp = await browser.newContext();
  check('reset-password gives a working temporary password', Boolean(temp) && (await withTemp.request.post(`${base}/api/auth/login`, { data: { username: USER, password: temp } })).status() === 200);
  check('reset-password signed the parent out everywhere', (await status(relogin)).parent === null);
}

let error;
try {
  await main();
} catch (e) {
  error = e;
} finally {
  await browser?.close().catch(() => undefined);
  // Remove only what this run created: its Compose project (container,
  // network, volume) and, if it somehow survived, the dev-mode check container.
  try {
    compose('down', '-v', '--remove-orphans');
  } catch {
    // Nothing was created yet.
  }
  try {
    run('docker', ['rm', '-f', devCheckName]);
  } catch {
    // Already removed (--rm).
  }
}
const left = run('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`, '-q']).trim();
const volumes = run('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${PROJECT}`, '-q']).trim();
check('cleanup: this run left no container or volume behind', !left && !volumes);
if (error) {
  console.error(`\nERROR: ${error.message}`);
  check('the run completed without errors', false);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (project ${PROJECT}, image ${image})`);
process.exit(failed.length ? 1 : 0);
