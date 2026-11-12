/**
 * The meet you are in stays alive while you browse the rest of the app in the same tab — like a
 * call that keeps running when you switch screens. The room component is mounted once at the app
 * root (see RoomLayer in app.tsx) and only hidden when another page is open, so the heartbeat, the
 * camera, the cut-out and the video mesh carry on; a floating pill offers Return / Leave.
 */
import { signal } from '@preact/signals';

/** The meet whose room is mounted (null = none). */
export const activeMeetId = signal<string | null>(null);

export interface ActiveRoomInfo {
  meetId: string;
  title: string;
  state: string;
  onStage: boolean;
  slot: number | null;
}
/** What the floating pill shows; published by the room itself. */
export const activeRoomInfo = signal<ActiveRoomInfo | null>(null);

export function enterRoom(meetId: string): void {
  if (activeMeetId.value !== meetId) {
    activeRoomInfo.value = null;
    activeMeetId.value = meetId;
  }
}

/** Unmounts the room: the session leaves the meet (slot freed), camera and video links close. */
export function leaveRoom(): void {
  activeMeetId.value = null;
  activeRoomInfo.value = null;
}
