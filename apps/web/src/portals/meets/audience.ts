import type { Participant } from '@singersvoice/protocol';

/**
 * The audience by name as far as a snapshot names them (its first dozen — the service keeps every
 * poll small however large the room), then "and N more" from the meet's audience count.
 */
export function audienceLine(count: number, participants: Participant[]): string {
  const names = participants.filter((p) => p.slot === null && p.role !== 'publisher').map((p) => p.displayName);
  if (!names.length) return count > 0 ? `${count} listening` : 'nobody yet';
  const more = count - names.length;
  return more > 0 ? `${names.join(', ')} and ${more} more` : names.join(', ');
}
