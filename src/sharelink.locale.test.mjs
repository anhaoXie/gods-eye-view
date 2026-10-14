import test from 'node:test';
import assert from 'node:assert/strict';
import { ShareLinkManager } from './sharelink.js';

function makeManager(hash = '') {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = {
    replaceState(_state, _title, next) {
      window.location.hash = new URL(next, window.location.href).hash;
    },
  };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer);
}

function installClipboard(writeText) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  });
}

function paramsOf(url) {
  return new URLSearchParams(new URL(url).hash.slice(1));
}

test('a shared link carries the sharer language, and English stays implicit', async () => {
  let copied = null;
  installClipboard(async (url) => {
    copied = url;
  });
  const manager = makeManager('#v=2&lat=10&lon=20');
  manager.parseInitialHash();

  manager.setLocaleProvider(() => 'zh');
  assert.equal(await manager.copyLink({ nowMs: 1_000 }), true);
  assert.equal(paramsOf(copied).get('lang'), 'zh');

  // English is the default, so an absent param already means English and the
  // link stays short rather than carrying a redundant value.
  manager.setLocaleProvider(() => 'en');
  assert.equal(await manager.copyLink({ nowMs: 2_000 }), true);
  assert.equal(paramsOf(copied).has('lang'), false);

  // A provider that goes away, or returns nothing usable, must not leave a
  // stale language in the link.
  manager.setLocaleProvider(null);
  assert.equal(await manager.copyLink({ nowMs: 3_000 }), true);
  assert.equal(paramsOf(copied).has('lang'), false);

  manager.setLocaleProvider(() => '');
  assert.equal(await manager.copyLink({ nowMs: 4_000 }), true);
  assert.equal(paramsOf(copied).has('lang'), false);
});

test('a stale language in an incoming link is dropped for an English sharer', async () => {
  let copied = null;
  installClipboard(async (url) => {
    copied = url;
  });
  // A copy snapshots live state, so `lang` must reflect the sharer, never the
  // language the incoming link happened to arrive with.
  const manager = makeManager('#v=2&lat=10&lon=20&lang=ru');
  manager.parseInitialHash();
  manager.setLocaleProvider(() => 'en');
  assert.equal(await manager.copyLink({ nowMs: 1_000 }), true);
  const params = paramsOf(copied);
  assert.equal(params.get('v'), '2', 'the rest of the link survives');
  assert.equal(params.has('lang'), false, 'and the stale language is gone');
});
