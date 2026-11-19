import type { ReadonlySignal } from '@preact/signals';

/**
 * A song position for a component to show: a plain number, or a signal that the view's clock writes every
 * frame. The component reads it where it renders (`ms()`), so the clock moves only what shows the time —
 * the lyrics, the seek bar — and never the whole stage around them.
 */
export type Clocked = number | ReadonlySignal<number>;

export const ms = (v: Clocked): number => (typeof v === 'number' ? v : v.value);
