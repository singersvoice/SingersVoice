import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@singersvoice/protocol';
import { MeetRegistry, type Client } from '../src/meets.ts';

function client(id: string, role: Client['role'] = 'audience'): Client & { inbox: ServerMessage[] } {
  const inbox: ServerMessage[] = [];
  return { id, userId: `u-${id}`, displayName: id, role, slot: null, resumeToken: `rt-${id}`, send: (m) => inbox.push(m), lastSeen: 0, inbox };
}

describe('MeetRoom', () => {
  it('seats up to 10 performers, counts audience and kickstarts everyone with one instant', () => {
    const reg = new MeetRegistry();
    const room = reg.create({ title: 'Sunday meet', hostId: 'u-host', trackId: 'trk-1', trackTitle: 'AA', backgroundId: 'mytestbg1' });
    const host = client('host');
    room.join(host);
    expect(host.inbox[0]?.t).toBe('welcome');
    for (let i = 1; i <= 11; i++) {
      const c = client(`p${i}`);
      room.join(c);
      expect(room.claimSlot(c.id, i)).toBe(i <= 10);
    }
    expect(room.meet.stage.filter((s) => s.userId).length).toBe(10);
    expect(room.claimSlot('p2', 1)).toBe(false); // taken by p1
    const aud = client('fan');
    room.join(aud);
    expect(room.meet.audienceCount).toBe(3); // host (no slot yet) + p11 (no free slot) + fan
    const at = room.start(2000);
    const ks = aud.inbox.filter((m) => m.t === 'kickstart');
    expect(ks).toHaveLength(1);
    expect(ks[0]!.t === 'kickstart' && ks[0]!.kickstartEpochMs).toBe(at);
    room.say(aud.id, 'encore!');
    expect(room.chat).toHaveLength(1);
    room.leave('p1');
    expect(room.meet.stage[0]!.userId).toBeNull();
  });
});
