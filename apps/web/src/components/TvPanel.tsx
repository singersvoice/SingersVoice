/**
 * The TV panel (the TV button on the live stage and in the Studio): the state of the link to the TV in
 * the room, the four-letter code to type, Connect / Disconnect. One panel, both stages (lib/tv.ts).
 */
import { useState } from 'preact/hooks';
import { tvLink } from '../lib/tv.ts';
import { errorText } from '../lib/toast.ts';

export function TvPanel(props: { compact?: boolean }) {
  const state = tvLink.state.value;
  const code = tvLink.code.value;
  const note = tvLink.note.value;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      await tvLink.connect(typed);
      setTyped('');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const site = `${location.host}${import.meta.env.BASE_URL}tv`;
  return (
    <div class="stack tvpanel" data-tv-state={state}>
      {state === 'off' ? (
        <>
          <div class="small muted">
            On the TV, open <b>{site}</b> in its browser (or on a laptop plugged into it). It shows a code of four letters — type it here. Or scan the TV's QR code with your phone's camera: the app connects by itself.
          </div>
          <div class="row" style="gap:8px;align-items:center">
            <input class="input tvcode" type="text" inputMode="text" autoCapitalize="characters" autoComplete="off" spellcheck={false} maxLength={4} placeholder="CODE" aria-label="The code on the TV" value={typed} data-tv-code onInput={(e) => setTyped((e.currentTarget as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))} onKeyDown={(e) => e.key === 'Enter' && typed.length === 4 && void connect()} />
            <button class="btn primary" disabled={busy || typed.length !== 4} data-tv-connect onClick={() => void connect()}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          {(err || note) && <div class="small warn-text" data-tv-note>{err ?? note}</div>}
        </>
      ) : (
        <>
          <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
            <span class={`chip ${state === 'on' ? 'ok' : 'warn'}`} data-tv-chip>
              {state === 'on' ? `TV ${code}: showing your stage` : `TV ${code}: connecting…`}
            </span>
            <button class="btn sm" data-tv-disconnect onClick={() => tvLink.disconnect(true)}>
              Disconnect
            </button>
          </div>
          {!props.compact && <div class="small muted">The TV shows the words and the stage (Settings → TV says what). The sound plays here, on your device — a TV a few tenths of a second behind would echo it.</div>}
        </>
      )}
    </div>
  );
}
