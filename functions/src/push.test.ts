// Tests of device selection and payloads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Device } from '../../src/shared/types';
import { canReceive, isPushEndpoint, MAX_PAYLOAD_BYTES, pushPayload, selectDevices } from './push';

test('only known push services over https', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://android.googleapis.com/gcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QFk',
    'https://wns2-db5p.notify.windows.com/w/?token=x',
    'https://FCM.googleapis.com:443/fcm/send/abc',
  ]) {
    assert.equal(isPushEndpoint(ok), true, ok);
  }
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/x',
    'https://evil.example/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.example/x',
    'https://notify.windows.com/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://169.254.169.254/',
    'not a url',
    '',
  ]) {
    assert.equal(isPushEndpoint(bad), false, bad);
  }
});

test('device selection: its accounts, complete keys, known services, no repeats', () => {
  const sub = (n: number) => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${n}`,
    keys: { p256dh: 'p', auth: 'a' },
  });
  const devs: Device[] = [
    { id: 'd1', uid: 'u1', subscription: sub(1), ua: '', createdAt: 0 },
    { id: 'd2', uid: 'u2', subscription: sub(2), ua: '', createdAt: 0 },
    { id: 'd3', uid: 'u2', subscription: sub(2), ua: '', createdAt: 0 },
    { id: 'd4', uid: 'u2', subscription: { ...sub(4), keys: { p256dh: '', auth: '' } }, ua: '', createdAt: 0 },
    { id: 'd5', uid: 'gone', subscription: sub(5), ua: '', createdAt: 0 },
    {
      id: 'd6',
      uid: 'u1',
      subscription: { endpoint: 'https://evil.example/x', keys: { p256dh: 'p', auth: 'a' } },
      ua: '',
      createdAt: 0,
    },
  ];
  const ids = (to: string[]) => selectDevices(devs, to).map((d) => d.id);
  assert.deepEqual(ids(['u1', 'u2']), ['d1', 'd2']);
  assert.deepEqual(ids(['u2']), ['d2']);
  assert.deepEqual(ids(['u1']), ['d1']);
  assert.deepEqual(ids([]), []);
  assert.equal(canReceive(devs[0] as Device), true);
  assert.equal(canReceive(devs[3] as Device), false);
  assert.equal(canReceive(devs[5] as Device), false);
});

test('payload: as is when it fits', () => {
  assert.deepEqual(JSON.parse(pushPayload({ title: 'T', body: 'B', url: '/#/', tag: 'x' })), {
    title: 'T',
    body: 'B',
    url: '/#/',
    tag: 'x',
  });
});

test('payload: always within the push size limit, without broken characters', () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  for (const [title, body] of [
    ['Á'.repeat(3000), 'ñ'.repeat(3000)],
    ['🎂'.repeat(500), '🎂'.repeat(5000)],
    ['x', '中'.repeat(4000)],
    ['\u0001'.repeat(300), '"\\'.repeat(3000)],
  ] as const) {
    const json = pushPayload({ title, body, url: '/#/calendar', tag: 'ev_x_2026-10-22' });
    assert.ok(bytes(json) <= MAX_PAYLOAD_BYTES, `${bytes(json)} bytes`);
    const p = JSON.parse(json) as { title: string; body: string };
    assert.ok(Array.from(p.title).length <= 200);
    assert.ok(p.body.endsWith('…'));
    assert.doesNotMatch(json, /\\ud[89ab]/i, 'no lone surrogates');
  }
});
