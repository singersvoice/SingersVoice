/**
 * The song of the stage, in one panel — inline in the lobby and as a drawer on the live stage. One
 * song at a time: the song up (or singing), whether this device can play it, and the picker (library
 * or public catalog) for the host and everyone on stage. Picked is up: the first pick loads on every
 * device and any singer on stage starts it. A second pick while a song is up does not replace it and
 * does not queue behind it — it is *put forward*, and every singer on stage sees the same choice card
 * (the song up and every song put forward); one tap on any device settles it and the others are
 * dropped. Nothing starts while the choice is open. While a song plays, songs put forward wait for
 * its end: one alone comes up by itself, several leave the choice to the stage. The audience sees the
 * same card without the buttons.
 */
import { formatMs, songChoicePending, songPlace, type Meet, type Participant, type SetListEntry, type SongPick } from '@singersvoice/protocol';
import { useState } from 'preact/hooks';
import { IcMusic, IcX } from '../../components/icons.tsx';
import { errorText, toast } from '../../lib/toast.ts';
import type { MeetSession } from './meetSession.ts';
import { SongPicker } from './SongPicker.tsx';
import type { MeetTrack } from './trackSource.ts';

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

export function SetListPanel(props: { session: MeetSession; meet: Meet; you: Participant; track: MeetTrack | null; host: boolean; onStage: boolean; live: boolean; compact?: boolean }) {
  const { session, meet, you, host, live } = props;
  const [picking, setPicking] = useState(false);
  const [settling, setSettling] = useState<string | null>(null);
  const canPick = host || props.onStage;
  const hasSong = Boolean(meet.trackId || meet.catalogTrackId);
  const proposed = meet.setList;
  /** Songs put forward with no song running: the stage chooses before anything starts. */
  const choosing = songChoicePending(meet);
  /** Songs put forward while a song runs: the one that follows, or a choice to make before the song ends. */
  const waiting = live && proposed.length > 0;
  const candidates = hasSong ? 1 + proposed.length : proposed.length;

  const addSong = async (song: SongPick) => {
    // Up already, or put forward already: nothing is added (a song is never listed twice) — say where it is instead.
    const already = songPlace(meet, song);
    if (already) {
      toast(already.place === 'current' ? `"${song.trackTitle}" is ${live ? 'playing now' : 'up already'}` : `"${song.trackTitle}" is put forward already — choose it on the stage card`, 'warn');
      return;
    }
    const straightUp = !hasSong && proposed.length === 0;
    await session.addSong(song);
    toast(straightUp ? `"${song.trackTitle}" is up — loading on every device` : live ? `"${song.trackTitle}" is put forward for after this song` : `"${song.trackTitle}" is put forward — the stage chooses which song to sing`, 'ok');
  };
  /** One tap settles it: `id` is a song put forward, or 'current' for the one up. */
  const choose = async (id: string, title: string) => {
    setSettling(id);
    try {
      await session.songAction(id, 'choose');
      toast(live ? `"${title}" follows this song` : `"${title}" it is — loading on every device`, 'ok');
    } catch (e) {
      toast(errorText(e), 'warn');
    } finally {
      setSettling(null);
    }
  };
  const withdraw = async (e: SetListEntry) => {
    try {
      await session.songAction(e.id, 'remove');
    } catch (err) {
      toast(errorText(err), 'warn');
    }
  };
  const heading = choosing ? `${candidates} song${candidates === 1 ? '' : 's'} picked — one song at a time on this stage` : hasSong ? (live ? 'Now singing' : `Up next${meet.songCount ? ` · song ${meet.songCount + 1}` : ''}`) : 'No song picked yet';
  const title = choosing ? (canPick ? 'Which one is it? One tap by any singer settles it' : 'The singers are choosing the song') : hasSong ? meet.trackTitle || 'Untitled track' : canPick ? 'Pick a song — it loads for everyone in the meet' : 'The singers pick the songs';
  return (
<section class={`card stack pad-sm setlist ${props.compact ? 'compact' : ''}`} data-songs={proposed.length} data-current={hasSong ? '1' : '0'} data-choice={choosing ? candidates : waiting && proposed.length > 1 ? proposed.length : 0}>
  <div class="row between">
    <div class="min0">
      <div class="small muted">{heading}</div>
      <b class="setlist-title">{title}</b>
    </div>
    <div class="row monitor-chips">
      {canPick && !picking && (
        <button class="btn sm primary" title={hasSong || proposed.length ? 'Pick another song — every singer on stage then chooses between them' : 'The song loads on every device in the meet'} onClick={() => setPicking(true)}>
          <IcMusic size={16} /> Pick your selection of song
        </button>
      )}
    </div>
  </div>
  {hasSong && !choosing && <TrackStatus track={props.track} host={host} />}
  {picking && <SongPicker meetId={meet.meetId} onPick={addSong} placeOf={(song) => songPlace(meet, song)?.place ?? null} onClose={() => setPicking(false)} />}
  {choosing && (
    <ol class="setlist-queue choice" aria-label="Songs picked — choose one">
      {hasSong && (
        <SongRow title={meet.trackTitle || 'Untitled track'} who="picked first" durationMs={meet.currentDurationMs} canChoose={canPick} settling={settling === 'current'} busy={settling !== null} onChoose={() => void choose('current', meet.trackTitle || 'this song')} />
      )}
      {proposed.map((e) => (
        <SongRow key={e.id} title={e.trackTitle} who={`picked by ${firstName(e.pickedByName)}`} durationMs={e.durationMs} canChoose={canPick} settling={settling === e.id} busy={settling !== null} onChoose={() => void choose(e.id, e.trackTitle)} onWithdraw={canPick || e.pickedBy === you.participantId ? () => void withdraw(e) : undefined} />
      ))}
    </ol>
  )}
  {waiting && (
    <div class="stack" style="gap:6px">
      <div class="small muted">{proposed.length === 1 ? 'After this song' : `After this song — ${proposed.length} songs put forward, the stage chooses one`}</div>
      <ol class="setlist-queue">
        {proposed.map((e) => (
          <SongRow key={e.id} title={e.trackTitle} who={`picked by ${firstName(e.pickedByName)}`} durationMs={e.durationMs} canChoose={canPick && proposed.length > 1} settling={settling === e.id} busy={settling !== null} onChoose={() => void choose(e.id, e.trackTitle)} onWithdraw={canPick || e.pickedBy === you.participantId ? () => void withdraw(e) : undefined} />
        ))}
      </ol>
    </div>
  )}
</section>
  );
}

function SongRow(props: { title: string; who: string; durationMs?: number; canChoose: boolean; settling: boolean; busy: boolean; onChoose: () => void; onWithdraw?: () => void }) {
  return (
    <li class="row between" data-song-row>
      <span class="min0">
        <b>{props.title}</b> <span class="small muted">· {props.who}{props.durationMs ? ` · ${formatMs(props.durationMs)}` : ''}</span>
      </span>
      <span class="row monitor-chips" style="flex-wrap:nowrap">
        {props.canChoose && (
          <button class="btn sm primary" disabled={props.busy} aria-label={`Sing ${props.title}`} onClick={props.onChoose}>
            {props.settling ? '…' : 'Sing this one'}
          </button>
        )}
        {props.onWithdraw && (
          <button class="btn icon sm" aria-label={`Withdraw ${props.title}`} title="Withdraw this song" onClick={props.onWithdraw}>
            <IcX size={14} />
          </button>
        )}
      </span>
    </li>
  );
}

export function TrackStatus(props: { track: MeetTrack | null; host: boolean }) {
  const t = props.track;
  if (!t) return <div class="small muted">Checking the track on this device…</div>;
  if (t.loaded) return <div class="small muted">Track ready on this device ({t.source === 'library' ? 'your library' : 'public catalog'}): {t.loaded.track.title} · {formatMs(t.loaded.track.durationMs)}</div>;
  return <div class="callout warn">{t.reason}</div>;
}
