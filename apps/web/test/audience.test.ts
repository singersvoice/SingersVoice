import { describe, expect, it } from 'vitest';
import type { Participant } from '@singersvoice/protocol';
import { audienceLine } from '../src/portals/meets/audience.ts';

const p = (name: string, slot: number | null = null, role: Participant['role'] = 'audience'): Participant => ({ participantId: name, userId: `u-${name}`, displayName: name, picture: '', role, slot, stageRequest: 'none', joinedAt: '', lastSeenAt: '' });

describe('audience line', () => {
  it('names who the snapshot names and counts the rest', () => {
    expect(audienceLine(0, [])).toBe('nobody yet');
    expect(audienceLine(2, [p('Ann'), p('Ben'), p('Host', 1, 'host'), p('Show', null, 'publisher')])).toBe('Ann, Ben');
    expect(audienceLine(100, [p('Ann'), p('Ben')])).toBe('Ann, Ben and 98 more');
    expect(audienceLine(7, [p('Singer', 2)])).toBe('7 listening'); // only performers were named
  });
});
