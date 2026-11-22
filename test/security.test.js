import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchUpstream } from '../server/proxy.js';
import { VIDEO_HOSTS } from '../server/media.js';
import { clientBucket } from '../server/rate-limit.js';
import { createSigner } from '../server/signer.js';

test('assinatura: válida, adulterada e expirada', () => {
  const s = createSigner({ secret: 'k', ttlSeconds: 60 });
  const { exp, sig } = s.sign('https://video.twimg.com/a.mp4');
  assert.equal(s.verify('https://video.twimg.com/a.mp4', String(exp), sig), 'ok');
  assert.equal(s.verify('https://video.twimg.com/b.mp4', String(exp), sig), 'invalid');
  assert.equal(s.verify('https://video.twimg.com/a.mp4', String(exp), sig.slice(0, -1)), 'invalid');
  assert.equal(s.verify(['x'], String(exp), sig), 'invalid');
  const old = createSigner({ secret: 'k', ttlSeconds: -1 });
  const o = old.sign('https://video.twimg.com/a.mp4');
  assert.equal(old.verify('https://video.twimg.com/a.mp4', String(o.exp), o.sig), 'expired');
  // Outro segredo (outro servidor) não aceita a assinatura.
  assert.equal(createSigner({ secret: 'z', ttlSeconds: 60 }).verify('https://video.twimg.com/a.mp4', String(exp), sig), 'invalid');
});

test('redirecionamento para fora do X é recusado antes de ser seguido', async () => {
  const visited = [];
  const fetchImpl = async (url) => {
    visited.push(url);
    if (url.includes('video.twimg.com/a.mp4')) {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    }
    return new Response('segredo');
  };
  await assert.rejects(
    fetchUpstream('https://video.twimg.com/a.mp4', { hosts: VIDEO_HOSTS, fetchImpl, timeoutMs: 1000 }),
    { code: 'MEDIA_NOT_ALLOWED' },
  );
  assert.deepEqual(visited, ['https://video.twimg.com/a.mp4']);
});

test('redirecionamento dentro do X é seguido', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/a.mp4')
      ? new Response(null, { status: 301, headers: { location: '/b.mp4' } })
      : new Response('ok');
  const res = await fetchUpstream('https://video.twimg.com/a.mp4', { hosts: VIDEO_HOSTS, fetchImpl, timeoutMs: 1000 });
  assert.equal(await res.text(), 'ok');
});

test('rate limit agrupa IPv6 por /64', () => {
  assert.equal(clientBucket('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(clientBucket('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(clientBucket('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(clientBucket('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(clientBucket('203.0.113.9'), '203.0.113.9');
});
