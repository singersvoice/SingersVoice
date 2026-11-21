/**
 * The TV screens: a TV (its browser at /tv — or a laptop on the HDMI cable, a stick, anything with a browser)
 * registers a screen and shows its four-letter code and a QR of it; the singer, signed in on their phone,
 * claims the code (typed on the stage's TV button, or by scanning the QR), and from then on the two talk
 * through here — WebRTC offers, answers and candidates each way — until one of them leaves. The picture
 * and the words then go straight from the phone to the TV over the room's Wi-Fi (`apps/web/src/lib/tv.ts`);
 * this service never carries them, only the handshake. The TV needs no sign-in: its token (given with the
 * code, never shown) is its credential; the phone's side is its account, and a token of its own for the
 * stream (a browser's EventSource sends no header).
 *
 * In memory, like the meets' push channel (events.ts): one process on Node, the one Durable Object on
 * Cloudflare. A screen the service forgot (a restart) tells the TV so, and the TV simply makes a new code.
 */

export type TvSide = 'tv' | 'phone';

export interface TvScreen {
  code: string;
  /** The TV's credential. */
  token: string;
  /** The phone's credential for the stream, once claimed. */
  phoneToken: string | null;
  createdAt: number;
  /** The last moment either side was heard from (a stream open, a signal posted). */
  seenAt: number;
  claimedBy: { userId: string; name: string } | null;
}

/** The TV's event stream tells it these; the phone's, `signal` and `released`. */
export type TvEvent = { type: 'claimed'; name: string } | { type: 'released' } | { type: 'signal'; data: unknown } | { type: 'closed' };

interface Sub {
  side: TvSide;
  send: (ev: TvEvent) => void;
  end: () => void;
}

/** The code's alphabet: no I, O, 0 or 1 (a TV across the room). */
export const TV_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TV_CODE_LENGTH = 4;
/** A screen nobody claimed goes after this long; a claimed one after this long without a word from either side. */
export const TV_UNCLAIMED_MS = 15 * 60_000;
export const TV_IDLE_MS = 5 * 60_000;
/** A signal's size (a WebRTC offer is a few KB). */
export const TV_SIGNAL_MAX_BYTES = 32 * 1024;
/** Streams one side of a screen may keep open at once (a page reloading overlaps itself; a flood does not): the oldest is closed for a new one. */
export const TV_STREAMS_PER_SIDE = 3;

/** A code as typed: upper case, spaces and dashes dropped, the letters the alphabet has (I, O, 0 and 1 are never in a code). */
export const normalizeTvCode = (s: string): string =>
  String(s ?? '')
    .toUpperCase()
    .split('')
    .filter((ch) => TV_CODE_ALPHABET.includes(ch))
    .join('')
    .slice(0, TV_CODE_LENGTH);

export class TvScreens {
  private screens = new Map<string, TvScreen>();
  private subs = new Map<string, Set<Sub>>();
  private readonly random: (bytes: number) => string;

  constructor(opts: { random?: (bytes: number) => string; now?: () => number } = {}) {
    this.random =
      opts.random ??
      ((bytes) => {
        const a = new Uint8Array(bytes);
        crypto.getRandomValues(a);
        return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
      });
    this.now = opts.now ?? (() => Date.now());
  }
  private readonly now: () => number;

  /** A new screen: a code no live screen has, and its token. */
  create(): TvScreen {
    this.sweep();
    let code = '';
    for (let tries = 0; tries < 50; tries++) {
      const a = new Uint8Array(TV_CODE_LENGTH);
      crypto.getRandomValues(a);
      code = Array.from(a, (b) => TV_CODE_ALPHABET[b % TV_CODE_ALPHABET.length]!).join('');
      if (!this.screens.has(code)) break;
    }
    const s: TvScreen = { code, token: this.random(16), phoneToken: null, createdAt: this.now(), seenAt: this.now(), claimedBy: null };
    this.screens.set(code, s);
    return s;
  }

  get(code: string): TvScreen | null {
    return this.screens.get(normalizeTvCode(code)) ?? null;
  }

  /** The screen, when `token` is one of its two credentials (the TV's, or the phone's once claimed): which side it is. */
  sideOf(code: string, token: string): { screen: TvScreen; side: TvSide } | null {
    const s = this.get(code);
    if (!s || !token) return null;
    if (token === s.token) return { screen: s, side: 'tv' };
    if (s.phoneToken && token === s.phoneToken) return { screen: s, side: 'phone' };
    return null;
  }

  /**
   * The singer takes the screen: free, or theirs already (a second stage on the same phone). Someone else's:
   * null. The TV is told who; the phone gets its stream token.
   */
  claim(code: string, user: { userId: string; name: string }): TvScreen | null {
    const s = this.get(code);
    if (!s) return null;
    if (s.claimedBy && s.claimedBy.userId !== user.userId) return null;
    s.claimedBy = { userId: user.userId, name: user.name };
    s.phoneToken = s.phoneToken ?? this.random(16);
    s.seenAt = this.now();
    this.tell(s.code, 'tv', { type: 'claimed', name: user.name });
    return s;
  }

  /** The phone lets the screen go (the stage left, Disconnect): the TV shows its code again for the next claim. */
  release(code: string): void {
    const s = this.get(code);
    if (!s) return;
    s.claimedBy = null;
    s.phoneToken = null;
    s.seenAt = this.now();
    this.tell(s.code, 'tv', { type: 'released' });
    for (const sub of this.subs.get(s.code) ?? []) if (sub.side === 'phone') sub.end();
  }

  /** The TV is gone (its page closed, or it asked): the screen is forgotten and the phone told. */
  close(code: string): void {
    const s = this.get(code);
    if (!s) return;
    this.screens.delete(s.code);
    const set = this.subs.get(s.code);
    this.subs.delete(s.code);
    for (const sub of set ?? []) {
      try {
        sub.send({ type: 'closed' });
        sub.end();
      } catch {
        /* gone */
      }
    }
  }

  /** A signal (an offer, an answer, a candidate) from one side, delivered to the other if it listens; false when nobody does. */
  signal(code: string, from: TvSide, data: unknown): boolean {
    const s = this.get(code);
    if (!s) return false;
    s.seenAt = this.now();
    return this.tell(s.code, from === 'tv' ? 'phone' : 'tv', { type: 'signal', data });
  }

  subscribe(code: string, side: TvSide, send: (ev: TvEvent) => void, end: () => void): () => void {
    const s = this.get(code);
    if (!s) return () => undefined;
    s.seenAt = this.now();
    const sub: Sub = { side, send, end };
    let set = this.subs.get(s.code);
    if (!set) {
      set = new Set();
      this.subs.set(s.code, set);
    }
    const same = [...set].filter((x) => x.side === side);
    for (const old of same.slice(0, Math.max(0, same.length + 1 - TV_STREAMS_PER_SIDE))) {
      set.delete(old);
      try {
        old.end();
      } catch {
        /* ignore */
      }
    }
    set.add(sub);
    return () => {
      const cur = this.subs.get(s.code);
      if (!cur) return;
      cur.delete(sub);
      if (!cur.size) this.subs.delete(s.code);
      const scr = this.screens.get(s.code);
      if (scr) scr.seenAt = this.now();
    };
  }

  /** Whether a side has its stream open (tests, the TV's "connected" line). */
  listening(code: string, side: TvSide): boolean {
    for (const sub of this.subs.get(normalizeTvCode(code)) ?? []) if (sub.side === side) return true;
    return false;
  }

  private tell(code: string, side: TvSide, ev: TvEvent): boolean {
    let told = false;
    for (const sub of this.subs.get(code) ?? []) {
      if (sub.side !== side) continue;
      try {
        sub.send(ev);
        told = true;
      } catch {
        /* a dead stream is dropped when its route notices */
      }
    }
    return told;
  }

  /** Forgotten: screens nobody claimed in TV_UNCLAIMED_MS, screens nobody has spoken on for TV_IDLE_MS with no stream open. */
  sweep(): void {
    const now = this.now();
    for (const [code, s] of this.screens) {
      const open = this.subs.get(code)?.size ?? 0;
      if (open) continue;
      if ((!s.claimedBy && now - s.createdAt > TV_UNCLAIMED_MS) || now - s.seenAt > TV_IDLE_MS) this.close(code);
    }
  }

  /** How many screens are live (diagnostics). */
  get size(): number {
    return this.screens.size;
  }
}
