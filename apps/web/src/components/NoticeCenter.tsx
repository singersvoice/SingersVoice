/**
 * The stage's notices in one small control (lib/notices.ts): a bell with the count, the one worst line beside it
 * (a critical notice is never hidden), and a popup with every notice — its severity, its words, what to do about
 * it. The stage stays clean and the singers stay in view; nothing here covers the picture.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { dismissNotice, notices, type Notice } from '../lib/notices.ts';
import { IcBell, IcX } from './icons.tsx';

const MARK: Record<Notice['severity'], string> = { critical: '!', warn: '•', info: '·' };

export function NoticeCenter(props: { /** Where the popup opens: below the bell (the lobby's strip) or above it (the stage's bar). */ open?: 'below' | 'above' }) {
  const list = notices.value;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const worst = list[0] ?? null;
  const critical = list.filter((n) => n.severity === 'critical').length;
  const warn = list.filter((n) => n.severity === 'warn').length;
  // A tap elsewhere closes the popup.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);
  if (!list.length) return null;
  return (
    <div class={`notices ${props.open ?? 'below'}`} ref={ref} data-notices={list.length} data-notices-critical={critical} data-notices-warn={warn} data-notice-ids={list.map((n) => n.id).join(',')}>
      <button class={`btn sm notices-bell ${critical ? 'critical' : warn ? 'warn' : ''}`} aria-label={`${list.length} notice${list.length === 1 ? '' : 's'}`} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-notices-bell>
        <IcBell size={16} />
        <span class="notices-count">{list.length}</span>
      </button>
      {!open && worst && worst.severity !== 'info' && (
        <span class={`chip notices-worst ${worst.severity}`} data-notices-worst={worst.id} title={worst.detail ?? worst.text}>
          {worst.text}
          {worst.action && (
            <button class="btn sm" style="margin-left:6px" onClick={worst.action.run}>
              {worst.action.label}
            </button>
          )}
        </span>
      )}
      {open && (
        <div class="notices-pop" role="dialog" aria-label="Notices" data-notices-pop>
          <div class="row between">
            <b>What the stage says</b>
            <button class="btn icon sm" aria-label="Close the notices" onClick={() => setOpen(false)}>
              <IcX size={16} />
            </button>
          </div>
          {list.map((n) => (
            <div key={n.id} class={`notice ${n.severity}`} data-notice={n.id} data-notice-severity={n.severity}>
              <span class="notice-mark" aria-hidden>
                {MARK[n.severity]}
              </span>
              <div class="notice-body">
                <div>{n.text}</div>
                {n.detail && <div class="small muted">{n.detail}</div>}
              </div>
              {n.action && (
                <button class="btn sm" onClick={n.action.run}>
                  {n.action.label}
                </button>
              )}
              {n.dismissible && (
                <button class="btn icon sm" aria-label="Take this down" onClick={() => dismissNotice(n.id)}>
                  <IcX size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
