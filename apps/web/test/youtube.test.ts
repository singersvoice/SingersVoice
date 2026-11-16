/**
 * YouTube, run by the app: the channel's HLS stream is found (or made, once), a broadcast is made per
 * show and bound to it with its public link, YouTube's reasons come back in the publisher's words, the
 * status reads as "receiving" / "not receiving", and ending a broadcast that is over already is no error.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { _setYoutubeFetch, endBroadcast, ensureHlsStream, startBroadcast, youtubeReason, youtubeStatus, youtubeWord, YoutubeError } from '../src/lib/youtube.ts';
import type { GoogleToken } from '../src/lib/google.ts';

const token: GoogleToken = { accessToken: 'tok', expiresAt: Date.now() + 3600_000, scope: 'https://www.googleapis.com/auth/youtube' };

/** A fake YouTube Data API: every request recorded; answers by method + path. */
function fakeApi(answers: Record<string, (body: unknown, url: URL) => { status?: number; json: unknown }>) {
  const calls: { method: string; path: string; params: Record<string, string>; body: unknown; auth: string }[] = [];
  _setYoutubeFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/youtube/v3/', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, params: Object.fromEntries(url.searchParams), body, auth: String((init?.headers as Record<string, string>)?.Authorization ?? '') });
    const a = answers[`${method} ${path}`];
    if (!a) return new Response(JSON.stringify({ error: { message: `no fake for ${method} ${path}`, errors: [{ reason: 'notFound' }] } }), { status: 404 });
    const r = a(body, url);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch);
  return calls;
}

afterEach(() => _setYoutubeFetch(null));

describe('YouTube run by the app', () => {
  it('finds the channel HLS stream, or makes one once, and hands back its key', async () => {
    const calls = fakeApi({
      'GET liveStreams': () => ({ json: { items: [{ id: 'rtmp1', cdn: { ingestionType: 'rtmp', ingestionInfo: { streamName: 'rtmp-key' } } }] } }),
      'POST liveStreams': (body) => ({ json: { id: 'hls1', cdn: { ingestionType: (body as { cdn: { ingestionType: string } }).cdn.ingestionType, ingestionInfo: { streamName: 'abcd-efgh-ijkl-mnop', ingestionAddress: 'https://a.upload.youtube.com/http_upload_hls' } } } }),
    });
    const s = await ensureHlsStream(token);
    expect(s).toEqual({ streamId: 'hls1', streamKey: 'abcd-efgh-ijkl-mnop', ingestionAddress: 'https://a.upload.youtube.com/http_upload_hls' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET liveStreams', 'POST liveStreams']); // the RTMP stream is not the one: an HLS one is made
    expect((calls[1]!.body as { cdn: { ingestionType: string }; contentDetails: { isReusable: boolean } }).cdn.ingestionType).toBe('hls');
    expect((calls[1]!.body as { contentDetails: { isReusable: boolean } }).contentDetails.isReusable).toBe(true);
    expect(calls[0]!.auth).toBe('Bearer tok');
    // Found the next time: nothing made.
    const calls2 = fakeApi({ 'GET liveStreams': () => ({ json: { items: [{ id: 'hls1', cdn: { ingestionType: 'hls', ingestionInfo: { streamName: 'abcd-efgh-ijkl-mnop' } } }] } }) });
    expect((await ensureHlsStream(token)).streamId).toBe('hls1');
    expect(calls2.map((c) => c.method)).toEqual(['GET']);
  });

  it('makes a broadcast for the show, bound to the stream, going live by itself — and its public link', async () => {
    const calls = fakeApi({
      'POST liveBroadcasts': () => ({ json: { id: 'FTUbrBKUSvY', status: { lifeCycleStatus: 'ready' } } }),
      'POST liveBroadcasts/bind': () => ({ json: { id: 'FTUbrBKUSvY' } }),
    });
    const b = await startBroadcast(token, { title: 'HN@16NOV2026-03', streamId: 'hls1', privacy: 'public' });
    expect(b).toEqual({ broadcastId: 'FTUbrBKUSvY', watchUrl: 'https://www.youtube.com/watch?v=FTUbrBKUSvY' });
    const made = calls[0]!.body as { snippet: { title: string }; status: { privacyStatus: string }; contentDetails: { enableAutoStart: boolean; enableAutoStop: boolean } };
    expect(made.snippet.title).toBe('HN@16NOV2026-03');
    expect(made.status.privacyStatus).toBe('public');
    expect(made.contentDetails.enableAutoStart && made.contentDetails.enableAutoStop).toBe(true);
    expect(calls[1]!.params).toMatchObject({ id: 'FTUbrBKUSvY', streamId: 'hls1' });
  });

  it("YouTube's reasons come back in the publisher's words", async () => {
    fakeApi({ 'POST liveBroadcasts': () => ({ status: 403, json: { error: { message: 'The user is not enabled for live streaming.', errors: [{ reason: 'liveStreamingNotEnabled' }] } } }) });
    await expect(startBroadcast(token, { title: 'x', streamId: 's', privacy: 'public' })).rejects.toMatchObject({ reason: 'liveStreamingNotEnabled', message: expect.stringMatching(/not enabled on this YouTube channel/) });
    expect(youtubeReason('quotaExceeded', 'x')).toMatch(/allowance/);
    expect(youtubeReason('accessNotConfigured', 'x')).toMatch(/YouTube Data API/);
    expect(youtubeReason('somethingElse', 'YouTube: fallback')).toBe('YouTube: fallback');
    fakeApi({ 'GET liveStreams': () => ({ status: 401, json: { error: { message: 'Invalid Credentials' } } }) });
    await expect(ensureHlsStream(token)).rejects.toBeInstanceOf(YoutubeError);
    await expect(ensureHlsStream(token)).rejects.toMatchObject({ reason: 'authError' });
  });

  it("the status is YouTube's own word on the show, in words for the bar", async () => {
    fakeApi({
      'GET liveBroadcasts': () => ({ json: { items: [{ id: 'b', status: { lifeCycleStatus: 'live' } }] } }),
      'GET liveStreams': () => ({ json: { items: [{ id: 's', status: { streamStatus: 'active', healthStatus: { status: 'good' } } }] } }),
    });
    const st = await youtubeStatus(token, 'b', 's');
    expect(st).toEqual({ broadcast: 'live', stream: 'active', health: 'good' });
    expect(youtubeWord(st)).toEqual({ text: 'YouTube: live · stream good', ok: true });
    expect(youtubeWord({ broadcast: 'ready', stream: 'inactive', health: 'noData' })).toEqual({ text: 'YouTube: not receiving the stream yet', ok: false });
    expect(youtubeWord({ broadcast: 'ready', stream: 'active', health: 'ok' })).toMatchObject({ ok: true });
    expect(youtubeWord({ broadcast: 'complete', stream: 'inactive', health: 'noData' })).toMatchObject({ ok: false, text: expect.stringMatching(/over/) });
  });

  it('ending a broadcast: done; one that is over already, or never went live, is no error', async () => {
    const calls = fakeApi({ 'POST liveBroadcasts/transition': () => ({ json: { id: 'b', status: { lifeCycleStatus: 'complete' } } }) });
    await endBroadcast(token, 'b');
    expect(calls[0]!.params).toMatchObject({ broadcastStatus: 'complete', id: 'b' });
    fakeApi({ 'POST liveBroadcasts/transition': () => ({ status: 403, json: { error: { message: 'Invalid transition', errors: [{ reason: 'invalidTransition' }] } } }) });
    await expect(endBroadcast(token, 'b')).resolves.toBeUndefined();
    fakeApi({ 'POST liveBroadcasts/transition': () => ({ status: 403, json: { error: { message: 'Forbidden', errors: [{ reason: 'forbidden' }] } } }) });
    await expect(endBroadcast(token, 'b')).rejects.toBeInstanceOf(YoutubeError);
  });
});
