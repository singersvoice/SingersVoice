import { useComputed } from '@preact/signals';
import type { BackgroundItem } from '@singersvoice/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { backgroundsBusy, deleteBackgrounds, isMyBackground, loadMyBackgrounds, loadStockBackgrounds, myBackgrounds, restoreStockBackgrounds, stockBackgrounds, uploadBackground } from '../lib/backgrounds.ts';
import { asset } from '../lib/nav.ts';
import { errorText, toast } from '../lib/toast.ts';
import { isDrive } from '../state/session.ts';
import { appSettings, updateApp, type AppSettings } from '../state/settings.ts';
import { IcCamera, IcCheck, IcTrash, IcUpload } from './icons.tsx';
import { Spinner } from './ui.tsx';

/** The built-in pictures, as before (`loadBackgrounds` keeps its name for the stages that call it). */
export const backgrounds = stockBackgrounds;
export const loadBackgrounds = loadStockBackgrounds;

/**
 * No stage behind the singer: their camera picture as it is, room and all — the virtual background off. A
 * choice like any other in the picker (first), remembered like any other; the stage and the show draw a
 * plain dark backdrop behind the pictures, and the singer's own picture switches to "my camera as it is".
 */
export const NONE_BACKGROUND_ID = 'none';
export const NONE_BACKGROUND: BackgroundItem = { id: NONE_BACKGROUND_ID, kind: 'image', src: '', thumb: '', label: 'None — my camera as it is' };
export const isNoneBackground = (id: string): boolean => id === NONE_BACKGROUND_ID;

/**
 * The singer's own background chosen (Settings, the Studio, the stage a meet starts on): none switches their
 * picture to their camera as it is (that is the point of it); a stage chosen after none puts them back on it,
 * cut out. Either way the choice is kept with the app settings (this device, and the Config folder in Drive).
 */
export function pickBackground(id: string): void {
  const app = appSettings.peek();
  const patch: Partial<AppSettings> = { backgroundId: id };
  if (isNoneBackground(id)) patch.picture = 'camera';
  else if (isNoneBackground(app.backgroundId)) patch.picture = 'cutout';
  updateApp(patch);
}

/** The id a meet's shared stage can carry: a built-in picture's or none — an upload of one singer's own becomes the first built-in picture. */
export function sharedBackgroundId(id: string): string {
  if (isNoneBackground(id) || !isMyBackground(id)) return id;
  return stockBackgrounds.peek()[0]?.id ?? NONE_BACKGROUND_ID;
}

/** The background by id: none, one of the singer's uploads (once listed), or a built-in picture (the first one when the id is unknown). */
export function backgroundById(id: string): BackgroundItem | undefined {
  if (isNoneBackground(id)) return NONE_BACKGROUND;
  if (isMyBackground(id)) {
    const mine = myBackgrounds.value?.find((b) => b.id === id);
    if (mine) return mine;
    if (myBackgrounds.value === null) return undefined; // not listed yet: nothing to draw until it is
  }
  return stockBackgrounds.value.find((b) => b.id === id) ?? stockBackgrounds.value[0];
}

/** The background's file (''): none for the plain backdrop — the stage and the show then draw nothing behind the singers; an upload's picture is its own URL. */
export function backgroundSrc(b: BackgroundItem | undefined): string {
  if (!b || !b.src) return '';
  return /^(blob|data):/.test(b.src) ? b.src : asset(`backgrounds/${b.src}`);
}
const thumbSrc = (b: BackgroundItem): string => (/^(blob|data):/.test(b.thumb) ? b.thumb : asset(`backgrounds/${b.thumb}`));

/**
 * The picker: the built-in pictures and the singer's own (the Backgrounds folder — lib/backgrounds.ts), with Upload
 * from this device, Select → Delete (with a word of confirmation) and, once a built-in has been deleted, Restore.
 * `stockOnly` (a live meet's shared stage) lists the built-in pictures alone: every device in the meet has those.
 */
export function BackgroundPicker(props: { value: string; onChange: (id: string) => void; stockOnly?: boolean }) {
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void loadStockBackgrounds();
    if (!props.stockOnly) void loadMyBackgrounds();
  }, [props.stockOnly]);
  const hidden = useComputed(() => new Set(appSettings.value.hiddenBackgrounds));
  const stock = stockBackgrounds.value.filter((b) => props.stockOnly || !hidden.value.has(b.id));
  const mine = props.stockOnly ? [] : (myBackgrounds.value ?? []);
  const busy = backgroundsBusy.value;
  const where = isDrive.value ? 'Drive › SingersVoice › Backgrounds' : 'this device';
  if (!stockBackgrounds.value.length && !mine.length) return <div class="muted small">Loading backgrounds…</div>;

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) {
      toast('Pick picture files (JPEG, PNG, WebP…)', 'warn');
      return;
    }
    let first: string | null = null;
    let done = 0;
    for (const f of list) {
      try {
        setWorking(`Uploading ${done + 1} of ${list.length}: ${f.name}`);
        const id = await uploadBackground(f, (label) => setWorking(`${done + 1} of ${list.length}: ${label}`));
        first ??= id;
        done++;
      } catch (e) {
        toast(`${f.name}: ${errorText(e)}`, 'error', 8000);
      }
    }
    setWorking(null);
    if (first) {
      props.onChange(first); // the first picture uploaded is the one chosen (that is why it was uploaded)
      toast(`${done} background${done === 1 ? '' : 's'} added to ${where}`, 'ok', 5000);
    }
  };

  const remove = async () => {
    const ids = [...checked];
    if (!ids.length) return;
    const names = ids.map((id) => [...mine, ...stock].find((b) => b.id === id)?.label ?? id);
    if (!confirm(`Delete ${ids.length === 1 ? `the background "${names[0]}"` : `these ${ids.length} backgrounds`}?\n${names.join(', ')}\n\nAn upload goes to the Drive bin; a built-in picture is hidden (Restore brings the built-in ones back).`)) return;
    setWorking('Deleting…');
    try {
      const gone = await deleteBackgrounds(ids);
      if (gone.includes(props.value)) props.onChange(stock.find((b) => !gone.includes(b.id))?.id ?? NONE_BACKGROUND_ID);
      setChecked(new Set());
      setSelecting(false);
      toast(`${gone.length} background${gone.length === 1 ? '' : 's'} deleted`, 'ok', 4000);
    } catch (e) {
      toast(`Could not delete: ${errorText(e)}`, 'error', 8000);
    } finally {
      setWorking(null);
    }
  };

  const restore = async () => {
    setWorking('Restoring the built-in backgrounds…');
    try {
      await restoreStockBackgrounds();
      toast('The built-in backgrounds are back', 'ok', 4000);
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setWorking(null);
    }
  };

  const tile = (b: BackgroundItem) => {
    const on = selecting ? checked.has(b.id) : props.value === b.id;
    return (
      <button key={b.id} type="button" role="option" aria-selected={on} class={`${on ? 'on' : ''} ${selecting ? 'selecting' : ''}`} data-bg-item={b.id} data-bg-mine={isMyBackground(b.id) ? '1' : undefined} onClick={() => (selecting ? toggle(b.id) : props.onChange(b.id))} title={selecting ? (checked.has(b.id) ? 'Selected for deletion' : 'Select') : b.label}>
        <img src={thumbSrc(b)} alt={b.label} loading="lazy" width="320" height="180" />
        {selecting && (
          <i class={`check ${checked.has(b.id) ? 'on' : ''}`} aria-hidden="true">
            {checked.has(b.id) ? <IcCheck size={16} /> : null}
          </i>
        )}
        <span>
          {b.label}
          {b.kind === 'video' ? ' ▶' : ''}
        </span>
      </button>
    );
  };

  return (
    <div class="stack" style="gap:10px" data-background-picker data-bg-mode={selecting ? 'select' : 'pick'}>
      {!props.stockOnly && (
        <div class="row wrap" style="gap:8px;align-items:center">
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => void upload((e.currentTarget as HTMLInputElement).files).finally(() => ((e.target as HTMLInputElement).value = ''))} data-bg-upload />
          <button type="button" class="btn" disabled={working !== null} onClick={() => fileInput.current?.click()} data-bg-upload-button>
            <IcUpload size={18} /> Upload from this device
          </button>
          <button type="button" class={`btn ${selecting ? 'on' : ''}`} disabled={working !== null} onClick={() => (setSelecting(!selecting), setChecked(new Set()))} data-bg-select>
            {selecting ? 'Done' : 'Select'}
          </button>
          {selecting && (
            <button type="button" class="btn danger" disabled={!checked.size || working !== null} onClick={() => void remove()} data-bg-delete>
              <IcTrash size={16} /> Delete selected ({checked.size})
            </button>
          )}
          {!selecting && hidden.value.size > 0 && (
            <button type="button" class="btn ghost" disabled={working !== null} onClick={() => void restore()} data-bg-restore>
              Restore built-in backgrounds ({hidden.value.size})
            </button>
          )}
          {(working || busy) && (
            <span class="small muted row" style="gap:6px">
              <Spinner /> {working ?? (busy === 'seeding' ? `Copying the built-in pictures to ${where}…` : `Reading ${where}…`)}
            </span>
          )}
        </div>
      )}
      <div class="bg-grid" role="listbox" aria-label="Stage background" aria-multiselectable={selecting}>
        {!selecting && (
          <button type="button" role="option" aria-selected={isNoneBackground(props.value)} class={`none ${isNoneBackground(props.value) ? 'on' : ''}`} data-bg-none onClick={() => props.onChange(NONE_BACKGROUND_ID)} title="No virtual background: your camera picture as it is, your room and all">
            <span class="nonebg" aria-hidden="true">
              <IcCamera size={28} />
            </span>
            <span>{NONE_BACKGROUND.label}</span>
          </button>
        )}
        {mine.map(tile)}
        {stock.map(tile)}
      </div>
      {!props.stockOnly && <div class="small faint">{mine.length ? `${mine.length} of your own and ` : ''}{stock.length} built-in pictures — all in {where}; the choice is kept with your settings.</div>}
    </div>
  );
}

/**
 * The stage background of a running meet, for the host and the singers on stage: a tap switches it
 * for everyone — every device in the room and the show (Publisher mode) follow at once (the mesh carries the word, the service the state).
 * The built-in pictures alone: those every device has.
 */
export function StageBackgroundChoice(props: { value: string; onPick: (id: string) => Promise<void>; compact?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const pick = async (id: string) => {
    if (id === props.value || busy) return;
    setBusy(id);
    try {
      await props.onPick(id);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div class={`stack ${props.compact ? 'compact' : ''}`} data-stage-background={props.value}>
      {!props.compact && <div class="small muted">The background of the stage, for everyone in the meet — on every device and in the show at once. Any singer on stage may switch it (the built-in pictures: every device has those).</div>}
      <BackgroundPicker value={busy ?? props.value} onChange={(id) => void pick(id)} stockOnly />
    </div>
  );
}

/** Full-bleed stage background (image or looping video). */
export function StageBackground(props: { id: string }) {
  useEffect(() => {
    void loadStockBackgrounds();
    if (isMyBackground(props.id)) void loadMyBackgrounds();
  }, [props.id]);
  const b = backgroundById(props.id);
  if (!b || isNoneBackground(b.id)) return <div class="bg" data-bg={b ? b.id : ''} />;
  if (b.kind === 'video') {
    return (
      <div class="bg" data-bg={b.id}>
        <video src={backgroundSrc(b)} poster={b.poster ? asset(`backgrounds/${b.poster}`) : undefined} muted loop autoPlay playsInline />
      </div>
    );
  }
  return <div class="bg" data-bg={b.id} style={{ backgroundImage: `url(${backgroundSrc(b)})` }} />;
}
