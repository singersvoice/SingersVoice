// A stand-in for X and Meta (Facebook Pages, Instagram) for the browser tests: the sign-in pages approve at
// once (a redirect back with a code), the token endpoints hand out tokens, the media endpoints take the
// bytes and the posts, and /_log tells the test what came. sv-control is pointed at it with SV_SOCIAL_FAKE
// (services/control/src/index.ts). Nothing here resembles the real services beyond their shapes.
import { createServer } from 'node:http';

export async function startFakeSocial() {
  const log = [];
  const read = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body));
  };
  let igStatusLooks = 0;
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://fake');
    const body = await read(req);
    const entry = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), auth: req.headers.authorization ?? '', bytes: body.length, contentType: req.headers['content-type'] ?? '' };
    // The bodies worth keeping: JSON and forms as text; multipart only by size.
    if (body.length && body.length < 100_000 && !/multipart|octet-stream/.test(entry.contentType)) entry.body = body.toString('utf8');
    if (u.pathname !== '/_log') log.push(entry);
    if (u.pathname === '/_log') return json(res, 200, log);
    // ---- the sign-in pages: approved at once ----
    if (u.pathname === '/x/authorize' || u.pathname === '/meta/authorize') {
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.searchParams.set('code', `code-${u.pathname.split('/')[1]}`);
      back.searchParams.set('state', u.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    // ---- X ----
    if (u.pathname === '/x/2/oauth2/token') return json(res, 200, { access_token: 'xat', refresh_token: 'xrt', expires_in: 7200, scope: 'tweet.read tweet.write users.read media.write offline.access' });
    if (u.pathname === '/x/2/oauth2/revoke') return json(res, 200, { revoked: true });
    if (u.pathname === '/x/2/users/me') return json(res, 200, { data: { id: 'x1', username: 'fake_singer', name: 'Fake Singer' } });
    if (u.pathname === '/x/2/media/upload/initialize') return json(res, 200, { data: { id: 'media1', media_key: '13_media1' } });
    if (u.pathname === '/x/2/media/upload/media1/append') return json(res, 204, {});
    if (u.pathname === '/x/2/media/upload/media1/finalize') return json(res, 200, { data: { id: 'media1', processing_info: { state: 'pending', check_after_secs: 0 } } });
    if (u.pathname === '/x/2/media/upload' && u.searchParams.get('command') === 'STATUS') return json(res, 200, { data: { id: 'media1', processing_info: { state: 'succeeded' } } });
    if (u.pathname === '/x/2/tweets') return json(res, 200, { data: { id: '9001', text: 'ok' } });
    // ---- Meta ----
    if (u.pathname === '/meta/oauth/access_token') return json(res, 200, u.searchParams.get('grant_type') === 'fb_exchange_token' ? { access_token: 'mlong', expires_in: 5184000 } : { access_token: 'mshort', expires_in: 3600 });
    if (u.pathname === '/meta/me/accounts') return json(res, 200, { data: [{ id: 'page1', name: 'Our Choir', access_token: 'ptok1' }, { id: 'page2', name: 'Fake Singer Music', access_token: 'ptok2', instagram_business_account: { id: 'ig2', username: 'fake.singer' } }] });
    if (u.pathname === '/meta-video/page2/videos') return json(res, 200, { id: 'fbvideo1' });
    if (u.pathname === '/meta/ig2/media') return json(res, 200, { id: 'container1' });
    if (u.pathname === '/meta-upload/container1') return json(res, 200, { success: true });
    if (u.pathname === '/meta/container1') return json(res, 200, { status_code: ++igStatusLooks < 2 ? 'IN_PROGRESS' : 'FINISHED', status: 'x' });
    if (u.pathname === '/meta/ig2/media_publish') return json(res, 200, { id: 'igmedia1' });
    if (u.pathname === '/meta/igmedia1') return json(res, 200, { permalink: 'https://www.instagram.com/reel/fake1/' });
    return json(res, 404, { error: { message: `nothing at ${u.pathname}` } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, log: async () => (await fetch(`${url}/_log`)).json(), stop: () => server.close() };
}
