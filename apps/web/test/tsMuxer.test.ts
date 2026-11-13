/**
 * The MPEG-TS muxer against real streams: ffmpeg makes two seconds of H.264 (Annex B, an AUD and
 * SPS/PPS in front of every IDR, like WebCodecs) and AAC (ADTS); the muxer packs them the way the
 * publisher's browser does for YouTube; ffprobe must then see one program with an H.264 video and
 * an AAC audio stream of the right length, and ffmpeg must decode every frame without an error.
 * Skipped where ffmpeg is not installed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32mpeg, splitAdts, splitNals, TS_PACKET, TsMuxer, type MediaPacket } from '../src/broadcast/tsMuxer.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

/** Annex B → access units, split at the AUD NALs x264 writes (SPS/PPS/IDR stay inside their unit). */
function accessUnits(annexB: Uint8Array): { key: boolean; data: Uint8Array }[] {
  const nals = splitNals(annexB);
  const units: { key: boolean; parts: Uint8Array[] }[] = [];
  for (const nal of nals) {
    const type = nal[0]! & 0x1f;
    if (type === 9 || !units.length) units.push({ key: false, parts: [] });
    const u = units[units.length - 1]!;
    if (type === 5) u.key = true;
    u.parts.push(new Uint8Array([0, 0, 0, 1]), nal);
  }
  return units.map((u) => {
    const len = u.parts.reduce((n, p) => n + p.length, 0);
    const data = new Uint8Array(len);
    let o = 0;
    for (const p of u.parts) {
      data.set(p, o);
      o += p.length;
    }
    return { key: u.key, data };
  });
}

describe('MPEG-TS muxer', () => {
  it('computes the MPEG CRC32 used by PAT/PMT', () => {
    // The CRC of an empty PAT body is a known constant for this polynomial.
    expect(crc32mpeg(new Uint8Array([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xf0, 0x00]))).toBe(0x2ab104b2);
  });

  it('muxes an ffmpeg-made H.264 + AAC pair into a segment ffprobe and ffmpeg accept', { timeout: 120_000 }, () => {
    if (!hasFfmpeg) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'sv-ts-'));
    const h264 = path.join(dir, 'v.h264');
    const aac = path.join(dir, 'a.aac');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-x264-params', 'keyint=30:min-keyint=30:scenecut=0:bframes=0:aud=1:repeat-headers=1', '-f', 'h264', h264]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', aac]);
    const units = accessUnits(new Uint8Array(readFileSync(h264)));
    const frames = splitAdts(new Uint8Array(readFileSync(aac)));
    expect(units.length).toBe(60);
    expect(units[0]!.key && units[30]!.key).toBe(true);
    expect(frames.length).toBeGreaterThan(80); // 2 s × 48000 / 1024 ≈ 94

    const packets: MediaPacket[] = [];
    units.forEach((u, i) => packets.push({ kind: 'video', ts: Math.round((i * 1e6) / 30), key: u.key, data: u.data }));
    // Four ADTS frames per audio PES, like the browser does.
    for (let i = 0; i < frames.length; i += 4) {
      const group = frames.slice(i, i + 4);
      const len = group.reduce((n, f) => n + f.length, 0);
      const data = new Uint8Array(len);
      let o = 0;
      for (const f of group) {
        data.set(f, o);
        o += f.length;
      }
      packets.push({ kind: 'audio', ts: Math.round((i * 1024 * 1e6) / 48000), key: false, data });
    }
    const mux = new TsMuxer('aac');
    // Two one-second segments, as a live stream would cut them — continuity counters carry across.
    const cut = packets.filter((p) => p.ts < 1e6);
    const rest = packets.filter((p) => p.ts >= 1e6);
    const seg1 = mux.muxSegment(cut);
    const seg2 = mux.muxSegment(rest);
    expect(seg1.durationS).toBeCloseTo(1, 1);
    expect(seg1.bytes.length % TS_PACKET).toBe(0);
    for (let i = 0; i < seg1.bytes.length; i += TS_PACKET) expect(seg1.bytes[i]).toBe(0x47); // every packet in sync
    // PAT then PMT first, as YouTube wants.
    expect(((seg1.bytes[1]! & 0x1f) << 8) | seg1.bytes[2]!).toBe(0);
    expect(((seg1.bytes[TS_PACKET + 1]! & 0x1f) << 8) | seg1.bytes[TS_PACKET + 2]!).toBe(0x1000);

    const all = new Uint8Array(seg1.bytes.length + seg2.bytes.length);
    all.set(seg1.bytes, 0);
    all.set(seg2.bytes, seg1.bytes.length);
    const ts = path.join(dir, 'out.ts');
    writeFileSync(ts, all);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', ts]).toString()) as {
      streams: { codec_type: string; codec_name: string; width?: number; sample_rate?: string; channels?: number }[];
      format: { format_name: string; duration: string; nb_programs?: number };
    };
    expect(probe.format.format_name).toBe('mpegts');
    const video = probe.streams.find((s) => s.codec_type === 'video')!;
    const audio = probe.streams.find((s) => s.codec_type === 'audio')!;
    expect(video.codec_name).toBe('h264');
    expect(video.width).toBe(320);
    expect(audio.codec_name).toBe('aac');
    expect(audio.sample_rate).toBe('48000');
    expect(audio.channels).toBe(2);
    expect(Number(probe.format.duration)).toBeGreaterThan(1.9);
    expect(Number(probe.format.duration)).toBeLessThan(2.2);
    // Decoding end to end: no errors, 60 video frames out.
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', ts, '-f', 'null', '-']);
    expect(dec.status, dec.stderr.toString()).toBe(0);
    const frameCount = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', ts]).toString().trim().split(/\s+/)[0];
    expect(Number(frameCount)).toBe(60);
  });
});
