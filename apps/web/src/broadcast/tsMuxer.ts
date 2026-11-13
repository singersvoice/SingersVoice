/**
 * MPEG-2 Transport Stream muxer for live segments: H.264 (Annex B access units, as WebCodecs hands
 * them out with `avc: { format: 'annexb' }`) and AAC-LC (ADTS frames, `aac: { format: 'adts' }`) —
 * exactly what YouTube's HLS ingestion asks for (one program, PAT + PMT first, self-initialising
 * segments, audio and video muxed) and what every HLS player plays. Pure functions over byte arrays,
 * no DOM, so the same code is unit-tested in Node against streams ffmpeg made.
 *
 * Timestamps are microseconds (WebCodecs' unit); they become 90 kHz PTS. There are no B-frames in
 * a realtime encode, so DTS = PTS and only the PTS is written.
 */

export interface MediaPacket {
  kind: 'video' | 'audio';
  /** Presentation time in microseconds. */
  ts: number;
  /** Video: an IDR access unit (with SPS/PPS in front). */
  key: boolean;
  /** Video: Annex B bytes. Audio: one or more ADTS frames. */
  data: Uint8Array;
}

export const TS_PACKET = 188;
const PID_PAT = 0;
const PID_PMT = 0x1000;
const PID_VIDEO = 0x100;
const PID_AUDIO = 0x101;
const STREAM_ID_VIDEO = 0xe0;
const STREAM_ID_AUDIO = 0xc0;
/** PTS offset so the stream never starts at 0 (players dislike a zero first timestamp). */
const PTS_OFFSET_US = 1_000_000;
/** How long before a picture's PTS its PCR says the clock is (the usual small mux delay). */
const PCR_LEAD_90K = 7200; // 80 ms

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** MPEG-2 CRC32 (as used by PSI tables). */
export function crc32mpeg(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]!) & 0xff]!) >>> 0;
  return crc >>> 0;
}

export const pts90 = (us: number): number => Math.round(((us + PTS_OFFSET_US) * 9) / 100) % 2 ** 33;

class Out {
  private chunks: Uint8Array[] = [];
  private size = 0;
  push(b: Uint8Array): void {
    this.chunks.push(b);
    this.size += b.length;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

/** The muxer keeps continuity counters across segments, as a live stream must. */
export class TsMuxer {
  private cc = new Map<number, number>();
  /** Whether the PMT advertises an audio stream, and which (0x0f = AAC ADTS). */
  constructor(private readonly audio: 'aac' | 'none' = 'aac') {}

  private next(pid: number): number {
    const c = (this.cc.get(pid) ?? -1) + 1;
    const v = c & 0x0f;
    this.cc.set(pid, v);
    return v;
  }

  private psiPacket(pid: number, tableId: number, section: Uint8Array): Uint8Array {
    // section = the bytes after section_length up to (not including) the CRC
    const len = section.length + 4; // + CRC
    const table = new Uint8Array(3 + len);
    table[0] = tableId;
    table[1] = 0xb0 | ((len >> 8) & 0x0f);
    table[2] = len & 0xff;
    table.set(section, 3);
    const crc = crc32mpeg(table, 0, 3 + section.length);
    table[3 + section.length] = (crc >>> 24) & 0xff;
    table[4 + section.length] = (crc >>> 16) & 0xff;
    table[5 + section.length] = (crc >>> 8) & 0xff;
    table[6 + section.length] = crc & 0xff;
    const pkt = new Uint8Array(TS_PACKET).fill(0xff);
    pkt[0] = 0x47;
    pkt[1] = 0x40 | ((pid >> 8) & 0x1f); // payload_unit_start
    pkt[2] = pid & 0xff;
    pkt[3] = 0x10 | this.next(pid); // payload only
    pkt[4] = 0; // pointer_field
    pkt.set(table, 5);
    return pkt;
  }

  pat(): Uint8Array {
    // transport_stream_id, version/current_next, section_number, last_section_number, program 1 → PMT PID
    const s = new Uint8Array([0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | ((PID_PMT >> 8) & 0x1f), PID_PMT & 0xff]);
    return this.psiPacket(PID_PAT, 0x00, s);
  }

  pmt(): Uint8Array {
    const streams: number[] = [0x1b, 0xe0 | ((PID_VIDEO >> 8) & 0x1f), PID_VIDEO & 0xff, 0xf0, 0x00];
    if (this.audio === 'aac') streams.push(0x0f, 0xe0 | ((PID_AUDIO >> 8) & 0x1f), PID_AUDIO & 0xff, 0xf0, 0x00);
    // program_number, version/current_next, section/last, PCR PID (video), program_info_length 0
    const s = new Uint8Array([0x00, 0x01, 0xc1, 0x00, 0x00, 0xe0 | ((PID_VIDEO >> 8) & 0x1f), PID_VIDEO & 0xff, 0xf0, 0x00, ...streams]);
    return this.psiPacket(PID_PMT, 0x02, s);
  }

  /** A PES packet (header + payload) split into TS packets; the first carries the PCR when given. */
  private pes(pid: number, streamId: number, pts: number, payload: Uint8Array, pcr: number | null, randomAccess: boolean, out: Out): void {
    const header = new Uint8Array(14);
    header[0] = 0;
    header[1] = 0;
    header[2] = 1;
    header[3] = streamId;
    const pesLen = payload.length + 8; // flags(3) + PTS(5); 0 = unbounded (video)
    const bounded = pid === PID_AUDIO && pesLen <= 0xffff;
    header[4] = bounded ? (pesLen >> 8) & 0xff : 0;
    header[5] = bounded ? pesLen & 0xff : 0;
    header[6] = 0x80; // marker bits
    header[7] = 0x80; // PTS only
    header[8] = 5; // PES_header_data_length
    header[9] = 0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1);
    header[10] = (pts >>> 22) & 0xff;
    header[11] = (((pts >>> 15) & 0x7f) << 1) | 1;
    header[12] = (pts >>> 7) & 0xff;
    header[13] = ((pts & 0x7f) << 1) | 1;
    const stream = new Uint8Array(header.length + payload.length);
    stream.set(header, 0);
    stream.set(payload, header.length);
    let pos = 0;
    let first = true;
    while (pos < stream.length) {
      const remaining = stream.length - pos;
      const pcrHere = first && pcr !== null;
      let afBytes = pcrHere ? 8 : 0; // adaptation field incl. its length byte
      const cap = TS_PACKET - 4 - afBytes;
      if (remaining < cap) afBytes += cap - remaining; // last packet: stuffing fills the rest
      const pkt = new Uint8Array(TS_PACKET);
      pkt[0] = 0x47;
      pkt[1] = (first ? 0x40 : 0) | ((pid >> 8) & 0x1f);
      pkt[2] = pid & 0xff;
      pkt[3] = (afBytes ? 0x30 : 0x10) | this.next(pid);
      let o = 4;
      if (afBytes) {
        pkt[o++] = afBytes - 1;
        if (afBytes > 1) {
          pkt[o++] = (pcrHere ? 0x10 : 0) | (first && randomAccess ? 0x40 : 0);
          if (pcrHere) {
            const base = pcr!;
            pkt[o++] = Math.floor(base / 2 ** 25) & 0xff;
            pkt[o++] = (base >>> 17) & 0xff;
            pkt[o++] = (base >>> 9) & 0xff;
            pkt[o++] = (base >>> 1) & 0xff;
            pkt[o++] = ((base & 1) << 7) | 0x7e;
            pkt[o++] = 0;
          }
          while (o < 4 + afBytes) pkt[o++] = 0xff;
        }
      }
      const take = TS_PACKET - o;
      pkt.set(stream.subarray(pos, pos + take), o);
      pos += take;
      out.push(pkt);
      first = false;
    }
  }

  /**
   * One segment: PAT, PMT, then every packet in time order. Video access units get an AUD in front
   * when they lack one; each video PES carries a PCR. Returns the bytes and the segment's duration
   * (last video PTS − first, plus one frame) in seconds.
   */
  muxSegment(packets: MediaPacket[], frameDurationUs = 33_333): { bytes: Uint8Array; durationS: number } {
    const out = new Out();
    out.push(this.pat());
    out.push(this.pmt());
    const sorted = [...packets].sort((a, b) => a.ts - b.ts || (a.kind === 'video' ? -1 : 1));
    let firstVideo: number | null = null;
    let lastVideo: number | null = null;
    for (const p of sorted) {
      const pts = pts90(p.ts);
      if (p.kind === 'video') {
        firstVideo ??= p.ts;
        lastVideo = p.ts;
        const au = withAud(p.data);
        this.pes(PID_VIDEO, STREAM_ID_VIDEO, pts, au, Math.max(0, pts - PCR_LEAD_90K), p.key, out);
      } else if (this.audio === 'aac') {
        this.pes(PID_AUDIO, STREAM_ID_AUDIO, pts, p.data, null, false, out);
      }
    }
    const durationS = firstVideo !== null && lastVideo !== null ? (lastVideo - firstVideo + frameDurationUs) / 1e6 : 0;
    return { bytes: out.bytes(), durationS };
  }
}

const AUD = new Uint8Array([0, 0, 0, 1, 0x09, 0xf0]);

/** An access-unit delimiter in front of the access unit (YouTube and strict players expect one). */
export function withAud(au: Uint8Array): Uint8Array {
  // Already starts with an AUD NAL (type 9)?
  const nalType = (i: number) => au[i]! & 0x1f;
  if (au.length > 4 && au[0] === 0 && au[1] === 0 && au[2] === 0 && au[3] === 1 && nalType(4) === 9) return au;
  if (au.length > 3 && au[0] === 0 && au[1] === 0 && au[2] === 1 && nalType(3) === 9) return au;
  const out = new Uint8Array(AUD.length + au.length);
  out.set(AUD, 0);
  out.set(au, AUD.length);
  return out;
}

/** Split an Annex B byte stream into NAL units (without start codes) — for tests and SPS/PPS lookups. */
export function splitNals(annexB: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let i = 0;
  let start = -1;
  const n = annexB.length;
  while (i + 2 < n) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && annexB[end - 1] === 0) end--; // 4-byte start code's leading zero
        nals.push(annexB.subarray(start, end));
      }
      start = i + 3;
      i += 3;
    } else i++;
  }
  if (start >= 0) nals.push(annexB.subarray(start));
  return nals;
}

/** ADTS frame boundaries in a byte run (each frame carries its own length). */
export function splitAdts(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let i = 0;
  while (i + 7 <= bytes.length) {
    if (bytes[i] !== 0xff || (bytes[i + 1]! & 0xf6) !== 0xf0) {
      i++;
      continue;
    }
    const len = ((bytes[i + 3]! & 0x03) << 11) | (bytes[i + 4]! << 3) | ((bytes[i + 5]! & 0xe0) >> 5);
    if (len < 7 || i + len > bytes.length) break;
    frames.push(bytes.subarray(i, i + len));
    i += len;
  }
  return frames;
}
