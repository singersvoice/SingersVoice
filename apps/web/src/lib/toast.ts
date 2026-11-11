import { signal } from '@preact/signals';

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'warn' | 'error';
  text: string;
  /** Optional action button. */
  action?: { label: string; onClick: () => void };
}

export const toasts = signal<Toast[]>([]);
let seq = 1;

export function toast(text: string, kind: Toast['kind'] = 'info', ms = 3800, action?: Toast['action']): void {
  const id = seq++;
  toasts.value = [...toasts.value, { id, kind, text, action }];
  if (ms > 0) setTimeout(() => dismiss(id), ms);
}

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return 'Unknown error';
  }
}
