/**
 * The set list — the karaoke queue — in one panel, used inline in the lobby and as a drawer on the
 * live stage: the song up next / now singing, its availability on this device, the queue, and the
 * picker (library or public catalog) for the host and everyone on stage.
 */
import { formatMs, type Meet, type Participant, type SongPick } from '@singersvoice/protocol';
import { useState } from 'preact/hooks';
import { IcMusic, IcPlay, IcX } from '../../components/icons.tsx';
import { errorText, toast } from '../../lib/toast.ts';
import type { MeetSession } from './meetSession.ts';
import { SongPicker } from './SongPicker.tsx';
import type { MeetTrack } from './trackSource.ts';

export function SetListPanel(props: { session: MeetSession; meet: Meet; you: Participant; track: MeetTrack | null; host: boolean; onStage: boolean; live: boolean; compact?: boolean }) {
  const { session, meet, you, host, live } = props;
  const [picking, setPicking] = useState(false);
  const canPick = host || props.onStage;
  const hasSong = Boolean(meet.trackId || meet.catalogTrackId);
  const addSong = async (song: SongPick, now = false) => {
    await session.addSong(song, now);
    toast(now || !hasSong ? `"${song.trackTitle}" is up next — loading on every device` : `"${song.trackTitle}" is on the set list`, 'ok');
  };
  const songAction = async (id: string, action: 'remove' | 'up' | 'now') => {
    try {
      await session.songAction(id, action);
    } catch (e) {
      toast(errorText(e), 'warn');
    }
  };
  const endSong = async () => {
    if (!confirm(live ? 'End the current song for everyone and move on?' : 'Skip this song? The next one on the set list comes up.')) return;
    try {
      await session.nextSong();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
<section class={`card stack pad-sm setlist ${props.compact ? 'compact' : ''}`} data-songs={meet.setList.length} data-current={hasSong ? '1' : '0'}>
  <div class="row between">
    <div class="min0">
      <div class="small muted">{hasSong ? (live ? 'Now singing' : `Up next${meet.songCount ? ` · song ${meet.songCount + 1}` : ''}`) : 'No song picked yet'}</div>
      <b class="setlist-title">{hasSong ? meet.trackTitle || 'Untitled track' : canPick ? 'Pick a song — it loads for everyone in the meet' : 'The singers pick the songs'}</b>
    </div>
    <div class="row monitor-chips">
      {canPick && !picking && (
        <button class="btn sm primary" onClick={() => setPicking(true)}>
          <IcMusic size={16} /> Pick your selection of song
        </button>
      )}
      {host && hasSong && !live && (
        <button class="btn sm" title="Skip this song; the next one on the set list comes up" onClick={() => void endSong()}>
          Skip
        </button>
      )}
    </div>
  </div>
  {hasSong && <TrackStatus track={props.track} host={host} />}
  {picking && <SongPicker onPick={(song) => addSong(song)} canPlayNow={host && hasSong && !live} onPlayNow={(song) => addSong(song, true)} onClose={() => setPicking(false)} />}
  {meet.setList.length > 0 && (
    <ol class="setlist-queue">
      {meet.setList.map((e, i) => (
        <li key={e.id} class="row between">
          <span class="min0">
            <b>{e.trackTitle}</b> <span class="small muted">· picked by {e.pickedByName.split(' ')[0]}{e.durationMs ? ` · ${formatMs(e.durationMs)}` : ''}</span>
          </span>
          <span class="row monitor-chips">
            {host && i > 0 && (
              <button class="btn icon sm" aria-label={`Move ${e.trackTitle} up`} title="Move up" onClick={() => void songAction(e.id, 'up')}>
                ▲
              </button>
            )}
            {host && !live && (
              <button class="btn sm" aria-label={`Play ${e.trackTitle} now`} onClick={() => void songAction(e.id, 'now')}>
                <IcPlay size={14} /> Now
              </button>
            )}
            {(host || e.pickedBy === you.participantId) && (
              <button class="btn icon sm" aria-label={`Remove ${e.trackTitle} from the set list`} title="Remove" onClick={() => void songAction(e.id, 'remove')}>
                <IcX size={14} />
              </button>
            )}
          </span>
        </li>
      ))}
    </ol>
  )}
</section>
  );
}

export function TrackStatus(props: { track: MeetTrack | null; host: boolean }) {
  const t = props.track;
  if (!t) return <div class="small muted">Checking the track on this device…</div>;
  if (t.loaded) return <div class="small muted">Track ready on this device ({t.source === 'library' ? 'your library' : 'public catalog'}): {t.loaded.track.title} · {formatMs(t.loaded.track.durationMs)}</div>;
  return <div class="callout warn">{t.reason}</div>;
}
