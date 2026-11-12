import { describe, expect, it } from 'vitest';
import { fingerprintOf } from '../src/video/sdp.ts';

describe('performer mesh helpers', () => {
  it('reads the DTLS fingerprint that identifies one RTCPeerConnection', () => {
    const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AB:CD:EF\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
    expect(fingerprintOf(sdp)).toBe('AB:CD:EF');
    expect(fingerprintOf(sdp.replace('AB:CD:EF', '11:22:33'))).not.toBe(fingerprintOf(sdp));
    expect(fingerprintOf(undefined)).toBe('');
  });
});
