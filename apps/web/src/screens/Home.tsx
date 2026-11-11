import { formatMs } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { IcImage, IcLibrary, IcMic, IcMusic, IcSparkle, IcUsers } from '../components/icons.tsx';
import { Page } from '../components/Shell.tsx';
import { href } from '../lib/nav.ts';
import type { PerformanceSummary, TrackSummary } from '../lib/storage/types.ts';
import { isDrive, profile, withProvider } from '../state/session.ts';

export function Home() {
  const [tracks, setTracks] = useState<TrackSummary[] | null>(null);
  const [perfs, setPerfs] = useState<PerformanceSummary[] | null>(null);
  useEffect(() => {
    void withProvider(async (p) => {
      await p.ready();
      setTracks((await p.listTracks()).slice(0, 4));
      setPerfs(await p.listPerformances());
    }).catch(() => {
      setTracks([]);
      setPerfs([]);
    });
  }, []);
  const name = (profile.value?.name ?? 'Singer').split(' ')[0];
  const temp = perfs?.filter((p) => p.state === 'temp').length ?? 0;
  return (
    <Page>
      <div class="stack" style="gap:18px">
        <section class="home-hero">
          <h1>Hi {name}, ready to sing?</h1>
          <p class="muted">
            {isDrive.value ? 'Your takes save to SingersVoice in Google Drive.' : 'Device mode: takes stay on this device until you link Google Drive.'}
          </p>
          <div class="row">
            <a class="btn primary" href={href('/sing')}>
              <IcMic /> Sing a track
            </a>
            <a class="btn" href={href('/trackmaker')}>
              <IcSparkle /> Track Maker
            </a>
          </div>
        </section>

        <nav class="quick" aria-label="Quick actions">
          <a href={href('/library')}>
            <IcLibrary />
            <b>Library</b>
            <span>{tracks ? `${tracks.length ? `${tracks.length}+` : 'No'} tracks` : '…'}</span>
          </a>
          <a href={href('/performances')}>
            <IcMusic />
            <b>Performances</b>
            <span>{perfs ? `${perfs.length} takes${temp ? ` · ${temp} in Temp` : ''}` : '…'}</span>
          </a>
          <a href={href('/meets')}>
            <IcUsers />
            <b>Meets</b>
            <span>Up to 10 on stage, unlimited audience</span>
          </a>
          <a href={href('/settings#backgrounds')}>
            <IcImage />
            <b>Backgrounds</b>
            <span>Stage & publishing looks</span>
          </a>
        </nav>

        <section class="stack">
          <div class="row between">
            <h2>Recent tracks</h2>
            <a class="btn sm ghost" href={href('/library')}>
              All
            </a>
          </div>
          {tracks === null && <div class="muted small">Loading…</div>}
          {tracks && !tracks.length && (
            <div class="card">
              <b>No tracks yet.</b>
              <p class="muted small">Make one in Track Maker: pick a song file, paste lyrics, tap along to time them.</p>
            </div>
          )}
          <div class="list">
            {tracks?.map((t) => (
              <a class="item" key={t.trackId} href={href(`/sing/${encodeURIComponent(t.trackId)}`)}>
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
      </div>
    </Page>
  );
}
