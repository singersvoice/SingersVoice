/**
 * The background saver: takes save themselves. A finished take (vocal + the show video) is handed
 * here and the singer carries on — the next song, another page, leaving the room, the meet ending:
 * none of it touches the save. Jobs run one at a time (one upload at a time keeps the uplink for
 * the stage), each stage of a job is remembered so a retry never uploads twice, a failed job is
 * retried by itself a few times and then waits for a tap on Retry. The room and the Performances
 * page show what is saving, saved, or stuck.
 */
import { computed, signal } from '@preact/signals';
import { newId } from '@singersvoice/protocol';
import { errorText, toast } from './toast.ts';

export type SaveState = 'queued' | 'saving' | 'done' | 'failed';

export interface SaveJob {
  /** The performance id (chosen up front, so retries and registrations agree). */
  id: string;
  title: string;
  meetTitle?: string;
  /** The host's copy of a meet song: the meet's performance, shared with everyone in it. */
  shared: boolean;
  state: SaveState;
  progress: { label: string; fraction: number } | null;
  error: string | null;
  /** Where it ended up (a Drive link, when there is one). */
  link: string | null;
  attempts: number;
  createdAt: number;
  finishedAt: number | null;
}

export type SaveReport = (p: { label: string; fraction: number }) => void;

interface Spec {
  id?: string;
  title: string;
  meetTitle?: string;
  shared?: boolean;
  /** The work itself; it is called again on retry, so it should skip what it already did. */
  work: (report: SaveReport) => Promise<{ link: string | null }>;
  /** Called once it is done (a toast action, say). */
  onDone?: (job: SaveJob) => void;
}

const AUTO_RETRIES = 3;
const KEEP_DONE_MS = 20_000;

export const saveJobs = signal<SaveJob[]>([]);
export const savesPending = computed(() => saveJobs.value.filter((j) => j.state === 'queued' || j.state === 'saving').length);
export const savesFailed = computed(() => saveJobs.value.filter((j) => j.state === 'failed').length);

const specs = new Map<string, Spec>();
let running = false;

function patch(id: string, p: Partial<SaveJob>): void {
  saveJobs.value = saveJobs.value.map((j) => (j.id === id ? { ...j, ...p } : j));
}

/** Hand a take to the saver; returns the performance id. */
export function enqueueSave(spec: Spec): string {
  const id = spec.id ?? newId('perf-');
  specs.set(id, { ...spec, id });
  const job: SaveJob = { id, title: spec.title, meetTitle: spec.meetTitle, shared: spec.shared ?? false, state: 'queued', progress: null, error: null, link: null, attempts: 0, createdAt: Date.now(), finishedAt: null };
  saveJobs.value = [...saveJobs.value.filter((j) => j.id !== id), job];
  void pump();
  return id;
}

/** Try a stuck job again, now. */
export function retrySave(id: string): void {
  const job = saveJobs.value.find((j) => j.id === id);
  if (!job || job.state !== 'failed') return;
  patch(id, { state: 'queued', error: null, attempts: 0 });
  void pump();
}

/** Forget a stuck job (the take is gone with it). */
export function dismissSave(id: string): void {
  specs.delete(id);
  saveJobs.value = saveJobs.value.filter((j) => j.id !== id);
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = saveJobs.value.find((j) => j.state === 'queued');
      if (!next) break;
      await runJob(next.id);
    }
  } finally {
    running = false;
  }
}

async function runJob(id: string): Promise<void> {
  const spec = specs.get(id);
  if (!spec) {
    saveJobs.value = saveJobs.value.filter((j) => j.id !== id);
    return;
  }
  patch(id, { state: 'saving', error: null, progress: { label: 'Saving', fraction: 0.02 } });
  const report: SaveReport = (p) => patch(id, { progress: p });
  for (;;) {
    const attempt = (saveJobs.value.find((j) => j.id === id)?.attempts ?? 0) + 1;
    patch(id, { attempts: attempt });
    try {
      const r = await spec.work(report);
      patch(id, { state: 'done', progress: null, link: r.link, finishedAt: Date.now() });
      specs.delete(id);
      const job = saveJobs.value.find((j) => j.id === id)!;
      toast(job.shared ? `Saved "${job.title}" — the meet's performance, shared with everyone in it` : `Saved "${job.title}" to your performances`, 'ok', 6000, { label: 'Performances', onClick: () => spec.onDone?.(job) });
      setTimeout(() => {
        saveJobs.value = saveJobs.value.filter((j) => j.id !== id || j.state !== 'done');
      }, KEEP_DONE_MS);
      return;
    } catch (e) {
      const msg = errorText(e);
      if (attempt < AUTO_RETRIES) {
        patch(id, { progress: { label: `Retrying (${msg})`, fraction: 0.02 } });
        await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
        continue;
      }
      patch(id, { state: 'failed', error: msg, progress: null, finishedAt: Date.now() });
      toast(`Could not save "${spec.title}": ${msg}`, 'error', 0, { label: 'Retry', onClick: () => retrySave(id) });
      return;
    }
  }
}

/** Keep the tab from closing while something is still saving (the take lives only in memory until then). */
if (typeof window !== 'undefined')
  window.addEventListener('beforeunload', (e) => {
    if (savesPending.value > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
