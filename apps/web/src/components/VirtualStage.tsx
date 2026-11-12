import { useEffect, useRef } from 'preact/hooks';
import type { StageCompositor } from '../video/stage.ts';

/** Mounts the stage compositor's canvas and keeps it sized to its box. */
export function VirtualStage(props: { compositor: StageCompositor; extra?: HTMLElement[] }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    const comp = props.compositor;
    if (!el) return;
    el.appendChild(comp.canvas);
    for (const x of props.extra ?? []) el.appendChild(x);
    const size = () => comp.resize(el.clientWidth, el.clientHeight);
    size();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(size) : null;
    ro?.observe(el);
    window.addEventListener('resize', size);
    comp.start();
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', size);
      comp.stop();
      comp.canvas.remove();
      for (const x of props.extra ?? []) x.remove();
    };
  }, [props.compositor]);
  return <div class="vstage" ref={host} aria-label="Stage" />;
}
