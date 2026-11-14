import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A stand-in for ffmpeg: whatever arrives on stdin lands in a file, so the test can see the bytes went through in order.
const dir = mkdtempSync(path.join(tmpdir(), 'sv-relay-'));
const out = path.join(dir, 'out.ts');
const stub = path.join(dir, 'ffmpeg');
writeFileSync(stub, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg version stub"; exit 0; fi\nexec cat > "${out}"\n`);
chmodSync(stub, 0o755);
process.env.RELAY_SECRET = 'test-secret';
process.env.RELAY_FFMPEG = stub;
const { handle, ffmpegArgs, rtmpTarget, streamCount } = await import('../src/server.mjs');

const server = http.createServer(handle);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = (method, p, body, headers = {}) => fetch(`${base}${p}`, { method, body, headers: { Authorization: 'Bearer test-secret', ...headers } });

test('ffmpeg arguments: MPEG-TS in, copied to FLV over RTMP, one target plain, several through tee', () => {
  assert.equal(rtmpTarget({ url: 'rtmps://a.rtmps.youtube.com:443/live2/', key: 'abcd-1234' }), 'rtmps://a.rtmps.youtube.com:443/live2/abcd-1234');
  const one = ffmpegArgs([{ url: 'rtmps://a.rtmps.youtube.com:443/live2', key: 'k1' }]);
  assert.deepEqual(one.slice(-3), ['-f', 'flv', 'rtmps://a.rtmps.youtube.com:443/live2/k1']);
  assert.ok(one.includes('aac_adtstoasc') && one.includes('copy'), 'no transcoding; AAC made FLV-ready');
  const two = ffmpegArgs([{ url: 'rtmps://a/live2', key: 'k1' }, { url: 'rtmps://live.twitch.tv/app', key: 'k2' }]);
  assert.deepEqual(two.slice(-3, -1), ['-f', 'tee']);
  assert.equal(two.at(-1), '[f=flv:onfail=ignore]rtmps://a/live2/k1|[f=flv:onfail=ignore]rtmps://live.twitch.tv/app/k2');
});

test('a stream: refused without the secret; started with targets; segments go through in order; stopped', async () => {
  assert.equal((await fetch(`${base}/streams/j1/start`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await call('POST', '/streams/j1/segments', Buffer.from([0x47]))).status, 404); // not started
  assert.equal((await call('POST', '/streams/j1/start', JSON.stringify({ targets: [{ kind: 'youtube', url: 'http://not-rtmp', key: 'x' }] }), { 'Content-Type': 'application/json' })).status, 400);
  const started = await call('POST', '/streams/j1/start', JSON.stringify({ targets: [{ kind: 'youtube', url: 'rtmps://a.rtmps.youtube.com:443/live2', key: 'secret-key' }] }), { 'Content-Type': 'application/json' });
  assert.equal(started.status, 200);
  assert.equal(streamCount(), 1);
  const a = Buffer.alloc(188 * 3, 0x47);
  const b = Buffer.from('second segment bytes');
  assert.equal((await call('POST', '/streams/j1/segments', a)).status, 200);
  const r2 = await (await call('POST', '/streams/j1/segments', b)).json();
  assert.equal(r2.segments, 2);
  assert.equal(r2.bytes, a.length + b.length);
  const status = await (await call('GET', '/streams/j1')).json();
  assert.equal(status.running, true);
  assert.equal(status.targets, 1);
  assert.equal((await (await call('POST', '/streams/j1/stop')).json()).stopped, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(readFileSync(out).toString('binary'), Buffer.concat([a, b]).toString('binary'), 'the bytes reached ffmpeg unchanged and in order');
  assert.equal(streamCount(), 0);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  server.close();
});
