/**
 * In-memory meet registry (V2 skeleton). Postgres-backed persistence, auth (Google ID tokens)
 * and the session-pod scheduler plug in here; the message protocol is already final in
 * @singersvoice/protocol so the web client can be built against it.
 */
import { emptyStage, MAX_PERFORMERS, newId, type ChatMessage, type Meet, type MeetRole, type ServerMessage, type StageSlot } from '@singersvoice/protocol';

export interface Client {
  id: string;
  userId: string;
  displayName: string;
  role: MeetRole;
  slot: number | null;
  resumeToken: string;
  send: (m: ServerMessage) => void;
  lastSeen: number;
}

export class MeetRoom {
  meet: Meet;
  readonly clients = new Map<string, Client>();
  readonly chat: ChatMessage[] = [];

  constructor(opts: { title: string; hostId: string; trackId: string; trackTitle: string; backgroundId: string }) {
    this.meet = {
      meetId: newId('meet-'),
      title: opts.title,
      hostId: opts.hostId,
      trackId: opts.trackId,
      trackTitle: opts.trackTitle,
      state: 'lobby',
      backgroundId: opts.backgroundId,
      stage: emptyStage(),
      audienceCount: 0,
      createdAt: new Date().toISOString(),
      kickstartEpochMs: null,
      streamUrl: null,
    };
  }

  join(c: Client): void {
    this.clients.set(c.id, c);
    this.recount();
    c.send({ t: 'welcome', meet: this.meet, you: { userId: c.userId, role: c.role, slot: c.slot }, resumeToken: c.resumeToken, serverEpochMs: Date.now() });
    this.broadcast({ t: 'meet', meet: this.meet }, c.id);
  }

  leave(clientId: string): void {
    const c = this.clients.get(clientId);
    if (!c) return;
    this.clients.delete(clientId);
    if (c.slot) this.releaseSlot(c.slot);
    this.recount();
    this.broadcast({ t: 'meet', meet: this.meet });
  }

  claimSlot(clientId: string, slot: number): boolean {
    const c = this.clients.get(clientId);
    const s = this.meet.stage[slot - 1];
    if (!c || !s || slot < 1 || slot > MAX_PERFORMERS || (s.userId && s.userId !== c.userId)) return false;
    if (c.slot && c.slot !== slot) this.releaseSlot(c.slot);
    Object.assign(s, { userId: c.userId, displayName: c.displayName, ready: false } satisfies Partial<StageSlot>);
    c.slot = slot;
    c.role = 'performer';
    this.broadcast({ t: 'meet', meet: this.meet });
    return true;
  }

  releaseSlot(slot: number): void {
    const s = this.meet.stage[slot - 1];
    if (s) Object.assign(s, { userId: null, displayName: '', ready: false, muted: false });
  }

  setReady(clientId: string, ready: boolean): void {
    const c = this.clients.get(clientId);
    if (!c?.slot) return;
    this.meet.stage[c.slot - 1]!.ready = ready;
    this.broadcast({ t: 'meet', meet: this.meet });
  }

  /** Host starts: every device gets the same wall-clock instant `leadMs` ahead (the GMT kickstart). */
  start(leadMs: number): number {
    const at = Date.now() + Math.max(1500, leadMs);
    this.meet.kickstartEpochMs = at;
    this.meet.state = 'countdown';
    this.broadcast({ t: 'kickstart', kickstartEpochMs: at, trackId: this.meet.trackId });
    setTimeout(() => {
      this.meet.state = 'live';
      this.broadcast({ t: 'meet', meet: this.meet });
    }, at - Date.now());
    return at;
  }

  stop(reason: 'host' | 'ended' | 'error'): void {
    this.meet.state = 'ended';
    this.meet.kickstartEpochMs = null;
    this.broadcast({ t: 'stop', reason });
    this.broadcast({ t: 'meet', meet: this.meet });
  }

  say(clientId: string, text: string): void {
    const c = this.clients.get(clientId);
    if (!c) return;
    const message: ChatMessage = { id: newId('msg-'), meetId: this.meet.meetId, userId: c.userId, displayName: c.displayName, text: text.slice(0, 500), sentAt: new Date().toISOString() };
    this.chat.push(message);
    if (this.chat.length > 2000) this.chat.shift();
    this.broadcast({ t: 'chat', message });
  }

  private recount(): void {
    this.meet.audienceCount = [...this.clients.values()].filter((c) => c.role === 'audience').length;
  }

  broadcast(m: ServerMessage, except?: string): void {
    for (const c of this.clients.values()) if (c.id !== except) c.send(m);
  }
}

export class MeetRegistry {
  readonly rooms = new Map<string, MeetRoom>();
  create(opts: ConstructorParameters<typeof MeetRoom>[0]): MeetRoom {
    const r = new MeetRoom(opts);
    this.rooms.set(r.meet.meetId, r);
    return r;
  }
  get(id: string): MeetRoom | undefined {
    return this.rooms.get(id);
  }
  list(): Meet[] {
    return [...this.rooms.values()].map((r) => r.meet).filter((m) => m.state !== 'ended');
  }
}
