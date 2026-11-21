/**
 * What the stage has to say about itself, in one place: the camera's state, a frozen picture, a link down, the
 * mix, the timing, a pause — each a notice with a severity, set by whoever knows (the stage, the session) and
 * taken down by the same hand the moment it no longer holds. The room shows them through one small control
 * (components/NoticeCenter.tsx) instead of a stack of chips over the stage: a bell with a count, the one worst
 * line beside it, the rest in a popup.
 */
import { computed, signal } from '@preact/signals';

export type NoticeSeverity = 'info' | 'warn' | 'critical';

export interface Notice {
  id: string;
  severity: NoticeSeverity;
  text: string;
  /** A longer word on it, for the popup. */
  detail?: string;
  /** Something to do about it, right there. */
  action?: { label: string; run: () => void };
  /** When it was first raised (ms). */
  at: number;
  /** A notice the singer can take down themselves (the mix line, say); a critical one stays until it is resolved. */
  dismissible?: boolean;
}

const store = signal<Map<string, Notice>>(new Map());
const dismissed = signal<Set<string>>(new Set());

const RANK: Record<NoticeSeverity, number> = { critical: 0, warn: 1, info: 2 };

/** Raise a notice, or take it down (`null`); a notice raised again keeps its first instant and loses a dismissal only when its text changed. */
export function setNotice(id: string, notice: Omit<Notice, 'id' | 'at'> | null): void {
  const cur = store.value.get(id);
  if (!notice) {
    if (!cur) return;
    const next = new Map(store.value);
    next.delete(id);
    store.value = next;
    if (dismissed.value.has(id)) {
      const d = new Set(dismissed.value);
      d.delete(id);
      dismissed.value = d;
    }
    return;
  }
  if (cur && cur.severity === notice.severity && cur.text === notice.text && cur.detail === notice.detail && cur.dismissible === notice.dismissible && cur.action?.label === notice.action?.label) {
    if (cur.action !== notice.action) cur.action = notice.action; // a fresh closure, the same deed
    return;
  }
  const next = new Map(store.value);
  next.set(id, { ...notice, id, at: cur?.at ?? Date.now() });
  store.value = next;
  if (cur && cur.text !== notice.text && dismissed.value.has(id)) {
    const d = new Set(dismissed.value);
    d.delete(id);
    dismissed.value = d;
  }
}

/** The singer took it down: hidden until it changes or is raised anew. */
export function dismissNotice(id: string): void {
  const d = new Set(dismissed.value);
  d.add(id);
  dismissed.value = d;
}

/** Every notice up, the worst first, then the oldest first. */
export const notices = computed(() => [...store.value.values()].filter((n) => !dismissed.value.has(n.id)).sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.at - b.at));

/** Take every notice down (leaving the room). */
export function clearNotices(): void {
  store.value = new Map();
  dismissed.value = new Set();
}
