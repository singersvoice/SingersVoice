/** What the background saver is doing: chips for each take being saved, saved, or stuck (with Retry). */
import { href } from '../lib/nav.ts';
import { dismissSave, retrySave, saveJobs } from '../lib/saveQueue.ts';
import { IcCheck, IcX } from './icons.tsx';

export function SaveStatus(props: { compact?: boolean }) {
  const jobs = saveJobs.value;
  if (!jobs.length) return null;
  return (
    <div class={`savestatus ${props.compact ? 'compact' : ''}`} role="status" aria-live="polite">
      {jobs.map((j) => {
        const pct = j.progress ? Math.round(j.progress.fraction * 100) : 0;
        if (j.state === 'done')
          return (
            <span class="chip ok" key={j.id} data-save="done" data-save-id={j.id}>
              <IcCheck size={14} /> Saved “{j.title}”{j.shared ? ' · shared with the meet' : ''}
              {!props.compact && (
                <a href={href('/studio/performances')} style="margin-left:6px">
                  Performances
                </a>
              )}
            </span>
          );
        if (j.state === 'failed')
          return (
            <span class="chip danger" key={j.id} data-save="failed" data-save-id={j.id}>
              Could not save “{j.title}”{props.compact ? '' : ` — ${j.error}`}
              <button class="btn sm" style="margin-left:6px" onClick={() => retrySave(j.id)}>
                Retry
              </button>
              <button class="btn icon sm" aria-label="Forget this take" title="Forget this take (it is gone)" onClick={() => dismissSave(j.id)}>
                <IcX size={12} />
              </button>
            </span>
          );
        return (
          <span class="chip" key={j.id} data-save={j.state} data-save-id={j.id} title={j.progress?.label ?? ''}>
            <span class="spin" aria-hidden="true" /> {j.state === 'queued' ? 'Waiting to save' : 'Saving'} “{j.title}”{j.progress && pct > 2 ? ` · ${pct}%` : ''}
            {j.shared ? ' · the meet’s performance' : ''}
          </span>
        );
      })}
    </div>
  );
}
