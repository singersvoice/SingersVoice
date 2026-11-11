/** AES-GCM for stream keys at rest (WebCrypto: Node 22 and Workers). Key = base64 of 32 random bytes. */
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class SecretBox {
  private keyPromise: Promise<CryptoKey>;

  constructor(secretB64: string) {
    let raw = secretB64 ? unb64(secretB64) : new Uint8Array(0);
    if (raw.length !== 32) {
      // No/invalid secret: derive a process-local key (dev only — keys won't survive a restart).
      raw = crypto.getRandomValues(new Uint8Array(32));
    }
    this.keyPromise = crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async seal(plain: string): Promise<string> {
    const key = await this.keyPromise;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain)));
    return `${b64(iv)}.${b64(ct)}`;
  }

  async open(sealed: string): Promise<string> {
    const [ivB, ctB] = sealed.split('.');
    if (!ivB || !ctB) throw new Error('bad sealed value');
    const key = await this.keyPromise;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB) as BufferSource }, key, unb64(ctB) as BufferSource);
    return dec.decode(pt);
  }
}

export function randomSecretB64(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
