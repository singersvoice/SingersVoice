/** Studio portal — offline work: build tracks, sing solo, review takes. Needs no live service. */
import { formatMs } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { IcMic, IcMusic, IcSparkle } from '../../components/icons.tsx';
import { Page } from '../../components/Shell.tsx';
import { href } from '../../lib/nav.ts';
import type { PerformanceSummary, TrackSummary } from '../../lib/storage/types.ts';
import { isDrive, withProvider } from '../../state/session.ts';

export function StudioHome() {
  const [tracks, setTracks] = useState<TrackSummary[] | null>(null);
  const [perfs, setPerfs] = useState<PerformanceSummary[] | null>(null);
  useEffect(() => {
    void withProvider(async (p) => {
      await p.ready();
      setTracks((await p.listTracks()).slice(0, 5));
      setPerfs((await p.listPerformances()).slice(0, 3));
    }).catch(() => {
      setTracks([]);
      setPerfs([]);
    });
  }, []);
  const temp = perfs?.filter((p) => p.state === 'temp').length ?? 0;
  return (
    <Page title="Studio">
      <div class="stack" style="gap:18px">
        <nav class="quick" aria-label="Studio tools">
          <a href={href('/studio/sing')} class="primary">
            <IcMic />
            <b>Sing</b>
            <span>Lyrics-first stage, VoxForge voice, take saved to {isDrive.value ? 'Drive' : 'this device'}</span>
          </a>
          <a href={href('/studio/trackmaker')}>
            <IcSparkle />
            <b>Track Maker</b>
            <span>Song file + lyrics → tap-to-time → track</span>
          </a>
          <a href={href('/studio/performances')}>
            <IcMusic />
            <b>Performances</b>
            <span>{perfs ? `${perfs.length ? 'Latest takes' : 'No takes yet'}${temp ? ` · ${temp} in Temp` : ''}` : '…'}</span>
          </a>
        </nav>
        <section class="stack">
          <div class="row between">
            <h2>Sing a track</h2>
            <a class="btn sm ghost" href={href('/tracks')}>
              All tracks
            </a>
          </div>
          {tracks && !tracks.length && (
            <div class="card">
              <b>No tracks yet.</b>
              <p class="muted small">Make one in Track Maker, import a file in Tracks, or pull one from the public catalog.</p>
            </div>
          )}
          <div class="list">
            {tracks?.map((t) => (
              <a class="item" key={t.trackId} href={href(`/studio/sing/${encodeURIComponent(t.trackId)}`)}>
                <div class="thumb">{t.title.charAt(0).toUpperCase()}</div>
                <div class="meta">
                  <div class="t">{t.title}</div>
                  <div class="s">
                    {t.artist || 'Unknown artist'} · {formatMs(t.durationMs)} · {t.singerCount} singer{t.singerCount > 1 ? 's' : ''}
                  </div>
                </div>
                <span class="btn sm primary">Sing</span>
              </a>
            ))}
          </div>
        </section>
        {perfs && perfs.length > 0 && (
          <section class="stack">
            <h2>Latest takes</h2>
            <div class="list">
              {perfs.map((p) => (
                <a class="item" key={p.performanceId} href={href('/studio/performances')}>
                  <div class="thumb">
                    <IcMusic size={20} />
                  </div>
                  <div class="meta">
                    <div class="t">{p.trackTitle}</div>
                    <div class="s">
                      {new Date(p.createdAt).toLocaleString()} · {formatMs(p.durationMs)} · {p.mode}
                    </div>
                  </div>
                  <span class={`chip ${p.state === 'temp' ? 'warn' : 'ok'}`}>{p.state}</span>
                </a>
              ))}
            </div>
          </section>
        )}
      </div>
    </Page>
  );
}
