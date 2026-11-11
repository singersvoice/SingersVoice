import type { ComponentChildren, JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { toasts, dismiss } from '../lib/toast.ts';
import { IcX } from './icons.tsx';

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: ComponentChildren; hint?: string; disabled?: boolean }) {
  return (
    <label class="switch">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span>
        <div>{props.label}</div>
        {props.hint && <div class="small muted">{props.hint}</div>}
      </span>
    </label>
  );
}

export function Seg<T extends string>(props: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; ariaLabel?: string }) {
  return (
    <div class="seg" role="radiogroup" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={props.value === o.v} class={props.value === o.v ? 'on' : ''} onClick={() => props.onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field(props: { label: string; children: ComponentChildren; hint?: string }) {
  return (
    <div class="field">
      <label>{props.label}</label>
      {props.children}
      {props.hint && <div class="small faint">{props.hint}</div>}
    </div>
  );
}

export function Sheet(props: { open: boolean; onClose: () => void; title?: string; children: ComponentChildren }) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open]);
  if (!props.open) return null;
  return (
    <div class="sheet-back" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={props.title}>
        <div class="grab" />
        {props.title && (
          <div class="row between" style="margin-bottom:10px">
            <h2>{props.title}</h2>
            <button class="btn icon sm ghost" aria-label="Close" onClick={props.onClose}>
              <IcX />
            </button>
          </div>
        )}
        {props.children}
      </div>
    </div>
  );
}

export function Toasts() {
  const list = toasts.value;
  if (!list.length) return null;
  return (
    <div class="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              class="btn sm accent"
              onClick={() => {
                t.action?.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button class="btn icon sm ghost" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <IcX size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Empty(props: { title: string; body?: string; children?: ComponentChildren; icon?: JSX.Element }) {
  return (
    <div class="empty">
      {props.icon}
      <h3>{props.title}</h3>
      {props.body && <p>{props.body}</p>}
      {props.children}
    </div>
  );
}

export function Progress(props: { fraction: number; label?: string }) {
  return (
    <div class="stack" style="gap:6px">
      {props.label && (
        <div class="row between small muted">
          <span>{props.label}</span>
          <span>{Math.round(props.fraction * 100)}%</span>
        </div>
      )}
      <div class="progress">
        <i style={{ width: `${Math.round(props.fraction * 100)}%` }} />
      </div>
    </div>
  );
}

export function Spinner() {
  return <span class="spin" aria-label="Loading" />;
}
