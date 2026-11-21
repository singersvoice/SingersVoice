/**
 * Post a clip: the sheet on a saved performance (Performances, and the review after a take is kept). The
 * singer picks the section — two sliders, from and to, and Play section to hear it — writes the caption,
 * ticks where it goes, and taps Make the clip. The clip then goes out: on a phone, Share… opens the system
 * sheet with the file (Instagram, Snapchat, Facebook, X, WhatsApp — every app installed); Download keeps
 * the file; Post sends it to the networks connected in Settings → Social (X, a Facebook Page, Instagram)
 * through the service, and the links come back. On a computer without a connected network, the clip
 * downloads and the network's composer opens with the caption, the clip to attach by hand.
 */
import { CAPTION_MAX, CLIP_LIMITS, CLIP_MAX_SECONDS, clampClip, clipCaption, composerUrl, formatMs, socialTitle, type SocialNetwork, type SocialPost, type SocialStatus } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, controlConfigured } from '../lib/api.ts';
import { canShareFile, clipExt, makeClip, shareClip, type Clip, type ClipProgress } from '../lib/clip.ts';
import { downloadBlob } from '../lib/download.ts';
import { href, safeHref } from '../lib/nav.ts';
import { errorText, toast } from '../lib/toast.ts';
import { appSettings } from '../state/settings.ts';
import { IcDownload, IcPlay, IcShare, IcStop } from './icons.tsx';
import { Progress, Spinner } from './ui.tsx';

export interface ClipSource {
  /** The show video of the performance (what the clip is cut from). */
  video: Blob;
  durationMs: number;
  title: string;
  performanceId: string | null;
  /** Who sang, for the caption. */
  singers?: string[];
  /** The performance's shareable link, for the caption (null when it has none yet). */
  link?: string | null;
}

const mmss = (ms: number) => formatMs(Math.max(0, Math.round(ms)));

export function ClipSheet(props: { source: ClipSource; onClose: () => void }) {
  const { source } = props;
  const total = Math.max(1000, Math.round(source.durationMs));
  const app = appSettings.value;
  const [range, setRange] = useState(() => clampClip(0, Math.min(total, app.clipSeconds * 1000), total));
  const [caption, setCaption] = useState(() => clipCaption({ title: source.title, singers: source.singers, link: source.link ?? null }));
  const [social, setSocial] = useState<SocialStatus | null>(null);
  const [picked, setPicked] = useState<SocialNetwork[]>([]);
  const [progress, setProgress] = useState<ClipProgress | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [posting, setPosting] = useState<SocialNetwork | null>(null);
  const [results, setResults] = useState<SocialPost[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const url = useMemo(() => URL.createObjectURL(source.video), [source.video]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const clipUrl = useMemo(() => (clip ? URL.createObjectURL(clip.blob) : ''), [clip]);
  useEffect(() => () => clipUrl && URL.revokeObjectURL(clipUrl), [clipUrl]);

  useEffect(() => {
    if (!controlConfigured.value) return;
    api
      .get('GET /social', '/social')
      .then((s) => {
        setSocial(s);
        setPicked(s.connections.map((c) => c.network));
      })
      .catch(() => setSocial(null));
  }, []);

  /** The longest clip the ticked networks all take (every network when none is ticked). */
  const maxSeconds = picked.length ? Math.min(...picked.map((n) => CLIP_LIMITS[n].maxSeconds)) : CLIP_MAX_SECONDS;
  const set = (fromMs: number, toMs: number) => {
    setRange(clampClip(fromMs, toMs, total, maxSeconds));
    setClip(null);
    setResults([]);
  };
  useEffect(() => set(range.fromMs, range.toMs), [maxSeconds]);
  const lengthMs = range.toMs - range.fromMs;

  const stopPreview = () => {
    const v = videoRef.current;
    if (v) v.pause();
    setPreviewing(false);
  };
  /** The section as it will be, from the start slider to the end slider. */
  const preview = async () => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = range.fromMs / 1000;
    v.muted = false;
    const stopAt = range.toMs / 1000;
    const onTime = () => {
      if (v.currentTime >= stopAt) {
        v.pause();
        v.removeEventListener('timeupdate', onTime);
        setPreviewing(false);
      }
    };
    v.addEventListener('timeupdate', onTime);
    await v.play().catch(() => undefined);
    setPreviewing(true);
  };
  const make = async () => {
    stopPreview();
    setClip(null);
    setResults([]);
    setProgress({ fraction: 0, label: 'Making the clip…' });
    try {
      const c = await makeClip(source.video, range.fromMs, range.toMs, { onProgress: setProgress });
      setClip(c);
    } catch (e) {
      toast(errorText(e), 'error', 9000);
    } finally {
      setProgress(null);
    }
  };
  const fileOf = (c: Clip) => new File([c.blob], `${source.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'SingersVoice'} clip.${clipExt(c.mime)}`, { type: c.mime });
  const share = async () => {
    if (!clip) return;
    const r = await shareClip(fileOf(clip), source.title, caption);
    if (r === 'shared') toast('Shared', 'ok');
    else if (r === 'unsupported') toast('This device cannot hand a video to another app — Download it and post from the app', 'warn', 7000);
  };
  const download = () => clip && downloadBlob(clip.blob, fileOf(clip).name);
  /** Posted to every ticked network, one after the other; each answer is a line below (the link, or what went wrong). */
  const post = async () => {
    if (!clip) return;
    const file = fileOf(clip);
    for (const network of picked) {
      setPosting(network);
      try {
        const form = new FormData();
        form.set('clip', file, file.name);
        form.set('network', network);
        form.set('text', caption.slice(0, CAPTION_MAX[network]));
        form.set('title', source.title);
        if (source.performanceId) form.set('performanceId', source.performanceId);
        form.set('clipMs', String(lengthMs));
        let { post: p } = await api.postForm('POST /social/posts', '/social/posts', form);
        // Instagram processes the video on its side: ask again until it is posted (or gives up).
        for (let i = 0; i < 40 && p.status === 'processing'; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          p = (await api.get('GET /social/posts/:id', `/social/posts/${encodeURIComponent(p.postId)}`)).post;
        }
        setResults((cur) => [...cur.filter((x) => x.network !== network), p]);
        toast(p.status === 'posted' ? `Posted to ${socialTitle[network]}` : p.status === 'processing' ? `${socialTitle[network]} is still processing the video — the link comes to Settings → Social` : `${socialTitle[network]}: ${p.note || 'not posted'}`, p.status === 'posted' ? 'ok' : 'warn', 7000);
      } catch (e) {
        toast(`${socialTitle[network]}: ${errorText(e)}`, 'error', 9000);
      }
    }
    setPosting(null);
  };

  const connected = social?.connections ?? [];
  const sharable = typeof navigator.share === 'function' && typeof (navigator as Navigator & { canShare?: unknown }).canShare === 'function';
  const captionMax = picked.length ? Math.min(...picked.map((n) => CAPTION_MAX[n])) : 2200;
  return (
    <div class="stack" data-clip-sheet data-clip-from={range.fromMs} data-clip-to={range.toMs}>
      <video ref={videoRef} src={url} playsInline preload="metadata" style="width:100%;border-radius:12px;background:#000;max-height:34dvh" data-clip-preview onPause={() => setPreviewing(false)} />
      <div class="stack" style="gap:6px" data-clip-range>
        <div class="row between small muted">
          <span>
            From <b data-clip-from-label>{mmss(range.fromMs)}</b>
          </span>
          <span>
            <b data-clip-length>{mmss(lengthMs)}</b> of {mmss(total)} · at most {maxSeconds} s{picked.length ? ` for ${picked.map((n) => socialTitle[n]).join(', ')}` : ''}
          </span>
          <span>
            To <b data-clip-to-label>{mmss(range.toMs)}</b>
          </span>
        </div>
        <input type="range" min={0} max={total} step={500} value={range.fromMs} aria-label="Clip start" data-clip-start onInput={(e) => set(Number((e.currentTarget as HTMLInputElement).value), range.toMs)} />
        <input type="range" min={0} max={total} step={500} value={range.toMs} aria-label="Clip end" data-clip-end onInput={(e) => set(range.fromMs, Number((e.currentTarget as HTMLInputElement).value))} />
        <div class="row wrap" style="gap:8px">
          <button class="btn sm" onClick={() => (previewing ? stopPreview() : void preview())} data-clip-play>
            {previewing ? <IcStop size={14} /> : <IcPlay size={14} />} {previewing ? 'Stop' : 'Play section'}
          </button>
          <button class="btn sm" onClick={() => set(Math.max(0, total - Math.min(total, app.clipSeconds * 1000)), total)} title="The end of the performance">
            Last {Math.min(Math.round(total / 1000), app.clipSeconds)} s
          </button>
          <button class="btn sm" onClick={() => set(0, Math.min(total, app.clipSeconds * 1000))} title="The start of the performance">
            First {Math.min(Math.round(total / 1000), app.clipSeconds)} s
          </button>
        </div>
      </div>
      <div class="field" style="margin:0">
        <label>Caption</label>
        <textarea class="input" rows={3} maxLength={captionMax} value={caption} data-clip-caption onInput={(e) => setCaption((e.currentTarget as HTMLTextAreaElement).value)} />
        <div class="small faint">
          {caption.length} / {captionMax}
        </div>
      </div>
      {controlConfigured.value && (
        <div class="stack" style="gap:6px" data-clip-networks>
          <div class="small muted">Post to</div>
          {connected.length === 0 ? (
            <div class="small faint">
              No network connected yet — <a href={href('/settings#social')}>Settings → Social</a> connects X, a Facebook Page and Instagram. {sharable ? 'Share… below hands the clip to any app on this phone meanwhile.' : 'Download below keeps the clip to post from the network itself.'}
            </div>
          ) : (
            <div class="row wrap" style="gap:10px">
              {connected.map((c) => (
                <label class="switch" style="margin:0" key={c.network}>
                  <input type="checkbox" checked={picked.includes(c.network)} data-clip-network={c.network} onChange={(e) => setPicked((cur) => ((e.currentTarget as HTMLInputElement).checked ? [...cur, c.network] : cur.filter((n) => n !== c.network)))} />
                  <span>
                    <div>
                      {socialTitle[c.network]} <span class="muted small">{c.handle}</span>
                    </div>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      {!clip && !progress && (
        <button class="btn primary lg" onClick={() => void make()} data-clip-make>
          Make the clip ({mmss(lengthMs)})
        </button>
      )}
      {progress && <Progress fraction={progress.fraction} label={`${progress.label} — the section plays through once, silently`} />}
      {clip && (
        <div class="stack" data-clip-ready data-clip-mime={clip.mime}>
          <video src={clipUrl} controls playsInline style="width:100%;border-radius:12px;background:#000;max-height:30dvh" data-clip-result />
          <div class="small faint">
            {mmss(clip.durationMs)} · {clip.width}×{clip.height} · {(clip.blob.size / 1048576).toFixed(1)} MB · {clipExt(clip.mime).toUpperCase()}
            {!/avc1|h264/i.test(clip.mime) ? ' — this browser writes VP9; X and Instagram want H.264 MP4, which Chrome on Windows, Mac and Android and Safari write (the share sheet and Facebook take this one)' : ''}
          </div>
          <div class="row wrap" style="gap:8px">
            {sharable && canShareFile(fileOf(clip)) && (
              <button class="btn primary" onClick={() => void share()} data-clip-share>
                <IcShare /> Share…
              </button>
            )}
            <button class="btn" onClick={download} data-clip-download>
              <IcDownload /> Download
            </button>
            {picked.length > 0 && (
              <button class="btn accent" disabled={posting !== null} onClick={() => void post()} data-clip-post>
                {posting ? <Spinner /> : null} {posting ? `Posting to ${socialTitle[posting]}…` : `Post to ${picked.map((n) => socialTitle[n]).join(', ')}`}
              </button>
            )}
            <button class="btn ghost" onClick={() => setClip(null)}>
              Change the section
            </button>
          </div>
          {!sharable && (
            <div class="row wrap small" style="gap:8px;align-items:center" data-clip-composers>
              <span class="muted">On this computer: Download, then open</span>
              <a class="btn sm" href={composerUrl('x', caption, source.link ?? null) ?? '#'} target="_blank" rel="noopener">
                X
              </a>
              {source.link && (
                <a class="btn sm" href={composerUrl('facebook', caption, source.link) ?? '#'} target="_blank" rel="noopener">
                  Facebook
                </a>
              )}
              <span class="muted">and attach the clip (Instagram and Snapchat post from their phone apps).</span>
            </div>
          )}
          {results.length > 0 && (
            <div class="stack" style="gap:4px" data-clip-results>
              {results.map((p) => (
                <div class="row wrap small" style="gap:8px;align-items:center" key={p.postId} data-clip-result-network={p.network} data-clip-result-status={p.status}>
                  <span class={`chip ${p.status === 'posted' ? 'ok' : p.status === 'failed' ? 'warn' : ''}`}>
                    {socialTitle[p.network]} · {p.status}
                  </span>
                  {p.url && (
                    <a href={safeHref(p.url)} target="_blank" rel="noopener">
                      {p.url}
                    </a>
                  )}
                  {p.note && <span class="faint">{p.note}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div class="row">
        <button class="btn ghost" onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
