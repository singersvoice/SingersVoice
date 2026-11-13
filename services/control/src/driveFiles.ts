/**
 * A published track's files live in its owner's Drive, shared anyone-with-the-link. A browser can
 * only read them with a Google API key (the `drive.file` token of another account cannot see them,
 * and Drive's download page sends no CORS headers), so the service fetches them for the app: with
 * the service's own API key when one is set, else through Drive's public download endpoint —
 * which answers an anonymous request for a shared file with the file itself, and with an HTML
 * page when it will not (not shared, not found).
 */

export interface PublicFile {
  body: ReadableStream<Uint8Array> | null;
  contentType: string;
  size: number | null;
}

const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;

/** True for an answer that is a file, not Drive's HTML page saying why not. */
const isFile = (r: Response): boolean => r.ok && !/text\/html/i.test(r.headers.get('content-type') ?? '');

/**
 * Fetch a shared Drive file anonymously. Throws with a plain message when Drive will not hand it
 * over (the owner stopped sharing it, or it is gone).
 */
export async function fetchPublicDriveFile(fileId: string, opts: { apiKey?: string; fetchImpl?: typeof fetch } = {}): Promise<PublicFile> {
  if (!DRIVE_ID.test(fileId)) throw new Error('Not a Drive file id');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts: string[] = [];
  if (opts.apiKey) attempts.push(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(opts.apiKey)}`);
  attempts.push(`https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`);
  attempts.push(`https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`);
  let last = '';
  for (const url of attempts) {
    try {
      const r = await fetchImpl(url, { redirect: 'follow' });
      if (isFile(r)) {
        const len = Number(r.headers.get('content-length') ?? '');
        return { body: r.body, contentType: r.headers.get('content-type') || 'application/octet-stream', size: Number.isFinite(len) && len > 0 ? len : null };
      }
      last = `${r.status}`;
      await r.body?.cancel().catch(() => undefined);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`Drive did not hand the file over (${last || 'no answer'}) — it may no longer be shared`);
}
