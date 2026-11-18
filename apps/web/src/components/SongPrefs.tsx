/**
 * Settings → Songs you prefer: the languages a singer sings in and the countries whose songs they like,
 * as chips — tap to pick, tap again to drop; saved to the account on every tap (lib/prefs.ts). The
 * Recommended tab and the public catalog show the songs in those languages first.
 */
import { languagesLine, prefsLanguages, SONG_COUNTRIES, SONG_LANGUAGES, type SongPrefs } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { controlConfigured } from '../lib/api.ts';
import { loadPrefs, savePrefs, songPrefs } from '../lib/prefs.ts';
import { errorText, toast } from '../lib/toast.ts';
import { Field } from './ui.tsx';

export function SongPrefsCard() {
  const p = songPrefs.value;
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void loadPrefs();
  }, []);

  const toggle = async (kind: keyof SongPrefs, name: string) => {
    const have = p[kind].includes(name);
    const next: SongPrefs = { ...p, [kind]: have ? p[kind].filter((x) => x !== name) : [...p[kind], name] };
    setSaving(true);
    try {
      await savePrefs(next);
    } catch (e) {
      toast(errorText(e), 'error', 6000);
    } finally {
      setSaving(false);
    }
  };
  const reach = prefsLanguages(p);
  return (
    <section class="card stack" data-song-prefs>
      <h2>Songs you prefer</h2>
      <p class="small muted">The languages you sing in, the countries whose songs you like — Recommended and the public catalog show those songs first. Nothing picked: every song, and you are asked there.</p>
      {!controlConfigured.value && <div class="callout warn small">The preference is kept on your SingersVoice account — this build has no service configured, so it stays on this device.</div>}
      <Field label="Languages">
        <div class="chips" data-pref-languages>
          {SONG_LANGUAGES.map((l) => (
            <button key={l} type="button" class="chip pick" aria-pressed={p.languages.includes(l)} disabled={saving} onClick={() => void toggle('languages', l)} data-pref-language={l}>
              {l}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Countries">
        <div class="chips" data-pref-countries>
          {SONG_COUNTRIES.map((c) => (
            <button key={c.name} type="button" class="chip pick" aria-pressed={p.countries.includes(c.name)} disabled={saving} title={`Songs in ${languagesLine(c.languages)}`} onClick={() => void toggle('countries', c.name)} data-pref-country={c.name}>
              {c.name}
            </button>
          ))}
        </div>
      </Field>
      <div class="small muted" data-prefs-line>
        {reach.length ? `Songs in ${languagesLine(reach)} first.` : 'No preference yet — every song, in every language.'}
      </div>
    </section>
  );
}
