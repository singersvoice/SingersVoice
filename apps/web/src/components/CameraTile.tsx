import { useEffect, useRef } from 'preact/hooks';
import type { Camera } from '../video/camera.ts';
import { Cutout } from '../video/cutout.ts';
import { IcCameraOff } from './icons.tsx';

/**
 * The "you" tile: live camera with zoom/auto-frame transforms, optional person cut-out.
 * Exposes the <video> through `videoRef` so the Sing screen can record it.
 */
export function CameraTile(props: { camera: Camera; cutout: boolean; label: string; videoRef: { current: HTMLVideoElement | null }; onCutoutError?: (e: unknown) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const cut = useRef<Cutout | null>(null);
  const stream = props.camera.stream;
  const on = props.camera.on.value;
  const zoom = props.camera.zoom.value;
  const origin = props.camera.origin.value;
  const mirror = props.camera.facing.value === 'user';

  useEffect(() => {
    const v = props.videoRef.current;
    if (!v) return;
    if (stream && v.srcObject !== stream) {
      v.srcObject = stream;
      void v.play().catch(() => undefined);
    }
    if (!stream) v.srcObject = null;
  }, [stream, on]);

  useEffect(() => {
    const v = props.videoRef.current;
    if (!v || !on) return;
    if (props.cutout) {
      const c = new Cutout(480, 360);
      cut.current = c;
      holder.current?.appendChild(c.canvas);
      c.canvas.className = mirror ? 'mirror' : '';
      c.start(v).catch((e) => props.onCutoutError?.(e));
      props.camera.startAutoFrame(v);
      return () => {
        c.stop();
        c.canvas.remove();
        cut.current = null;
      };
    }
    props.camera.startAutoFrame(v);
    return () => props.camera.stopAutoFrame();
  }, [props.cutout, on, mirror]);

  return (
    <div
      class="tile"
      ref={holder}
      style={{ '--zoom': zoom.toFixed(3), '--ox': `${origin.x}%`, '--oy': `${origin.y}%` } as unknown as string}
      aria-label="Your camera"
    >
      <video ref={props.videoRef} class={`${mirror ? 'mirror' : ''} ${props.cutout ? 'hidden' : ''}`} muted playsInline autoPlay />
      {!on && (
        <div class="silhouette">
          <IcCameraOff size={28} />
        </div>
      )}
      <span class="tag">{props.label}</span>
    </div>
  );
}
