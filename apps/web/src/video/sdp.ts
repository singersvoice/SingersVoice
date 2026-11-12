/** The DTLS fingerprint of an SDP — one per RTCPeerConnection, so it tells a re-made connection from a renegotiation. */
export function fingerprintOf(sdp: string | undefined): string {
  return /a=fingerprint:\S+\s+(\S+)/.exec(sdp ?? '')?.[1] ?? '';
}
