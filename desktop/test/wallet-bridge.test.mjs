import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// The app opens exactly one kind of URL for the game: the site's own https wallet link page.
const require = createRequire(import.meta.url);
const { handleWalletRequest, linkUrl } = require('../src/wallet-bridge.js');

const ORIGIN = 'https://breathless.gotclass.xyz';
const SID = 'A'.repeat(21) + '-_' + 'b'.repeat(20);
const TOKEN = 'z9'.repeat(21) + 'Q';
const GOOD = `${ORIGIN}/link.html?sid=${SID}#t=${TOKEN}`;

function ctx() {
  const opened = [];
  return { opened, origin: ORIGIN, senderUrl: `${ORIGIN}/`, window: null, openExternal: (u) => opened.push(u), log: () => {} };
}

test('opens the link page on the app origin', async () => {
  const c = ctx();
  assert.deepEqual(await handleWalletRequest({ kind: 'openLink', url: GOOD }, c), { ok: true });
  assert.deepEqual(c.opened, [GOOD]);
});

test('refuses every other URL, and opens nothing', async () => {
  const bad = [
    `http://breathless.gotclass.xyz/link.html?sid=${SID}#t=${TOKEN}`, // not https
    `https://evil.example/link.html?sid=${SID}#t=${TOKEN}`, // another site
    `https://breathless.gotclass.xyz.evil.example/link.html?sid=${SID}#t=${TOKEN}`,
    `https://breathless.gotclass.xyz:8443/link.html?sid=${SID}#t=${TOKEN}`, // another port is another origin
    `https://user:pw@breathless.gotclass.xyz/link.html?sid=${SID}#t=${TOKEN}`,
    `${ORIGIN}/index.html?sid=${SID}#t=${TOKEN}`, // another page
    `${ORIGIN}/link.html/../index.html?sid=${SID}#t=${TOKEN}`,
    `${ORIGIN}/link.htm?sid=${SID}#t=${TOKEN}`,
    `${ORIGIN}/api/link?sid=${SID}#t=${TOKEN}`,
    `${ORIGIN}/link.html#t=${TOKEN}`, // no sid
    `${ORIGIN}/link.html?sid=${SID}`, // no token
    `${ORIGIN}/link.html?sid=short#t=${TOKEN}`,
    `${ORIGIN}/link.html?sid=${SID}&next=https://evil.example#t=${TOKEN}`, // extra query
    `${ORIGIN}/link.html?sid=${SID}#t=${TOKEN}&x=1`,
    'javascript:alert(1)',
    'file:///etc/passwd',
    `${ORIGIN}/link.html?sid=${SID}#t=${TOKEN}`.padEnd(3000, 'x'),
    '',
    42,
    null,
  ];
  for (const url of bad) {
    const c = ctx();
    const res = await handleWalletRequest({ kind: 'openLink', url }, c);
    assert.equal(res.ok, false, String(url));
    assert.deepEqual(c.opened, [], String(url));
    assert.equal(linkUrl(url, ORIGIN), null, String(url));
  }
});

test('only openLink is understood', async () => {
  for (const req of [null, undefined, 'openLink', {}, { kind: 'sign', url: GOOD }, { kind: 'OPENLINK', url: GOOD }, []]) {
    const c = ctx();
    const res = await handleWalletRequest(req, c);
    assert.deepEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: 'unsupported' });
    assert.deepEqual(c.opened, []);
  }
});

test('the origin is the one the app runs on (a dev override), never a guess', async () => {
  const c = { ...ctx(), origin: 'https://staging.example' };
  assert.equal((await handleWalletRequest({ kind: 'openLink', url: GOOD }, c)).ok, false);
  const url = `https://staging.example/link.html?sid=${SID}#t=${TOKEN}`;
  assert.equal((await handleWalletRequest({ kind: 'openLink', url }, c)).ok, true);
  assert.deepEqual(c.opened, [url]);
});
