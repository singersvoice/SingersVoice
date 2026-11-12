import type { Meet } from '@singersvoice/protocol';
import { api } from '../../lib/api.ts';

/** `/meet/<id>` link, a bare meet id, or a 6-letter join code → the meet. */
export async function resolveMeet(input: string): Promise<Meet> {
  const s = input.trim();
  const m = /\/meet\/([^/?#\s]+)/.exec(s);
  if (m) return (await api.get('GET /meets/:id', `/meets/${encodeURIComponent(m[1]!)}`)).meet;
  if (/^[a-z0-9]{6}$/i.test(s)) return (await api.get('GET /meets/code/:code', `/meets/code/${encodeURIComponent(s.toUpperCase())}`)).meet;
  if (s) return (await api.get('GET /meets/:id', `/meets/${encodeURIComponent(s)}`)).meet;
  throw new Error('Paste a meet link or its 6-letter code');
}
