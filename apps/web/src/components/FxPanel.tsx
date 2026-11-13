import { applyPreset, VOXFORGE_PRESETS, VOXFORGE_RANGES, type AudioPluginSettings, type VoxForgeParams } from '@singersvoice/protocol';
import { Switch } from './ui.tsx';

type NumKey = keyof typeof VOXFORGE_RANGES;
type OnKey = 'pitchOn' | 'eqOn' | 'compOn' | 'pcOn' | 'dsOn' | 'exOn' | 'rdOn' | 'satOn' | 'chOn' | 'dlOn' | 'rvOn';

const SECTIONS: { title: string; on: OnKey | null; keys: NumKey[] }[] = [
  { title: 'Gain', on: null, keys: ['inGain', 'outGain'] },
  { title: 'Pitch & Auto-tune', on: 'pitchOn', keys: ['octave', 'pitchSt', 'pitchCt', 'autoStr', 'autoSpeed'] },
  { title: 'EQ', on: 'eqOn', keys: ['hpfHz', 'eqLow', 'eqLm', 'eqMid', 'presHz', 'eqPres', 'eqHi'] },
  { title: 'Compressor', on: 'compOn', keys: ['cThr', 'cRat', 'cAtk', 'cRel', 'cMk'] },
  { title: 'Punch (parallel compression)', on: 'pcOn', keys: ['pcMx'] },
  { title: 'De-esser', on: 'dsOn', keys: ['dsHz', 'dsAmt'] },
  { title: 'Air (exciter)', on: 'exOn', keys: ['exAmt'] },
  { title: 'Vocal rider', on: 'rdOn', keys: ['rdAmt'] },
  { title: 'Saturation', on: 'satOn', keys: ['satDr', 'satMx'] },
  { title: 'Chorus / Doubler', on: 'chOn', keys: ['chRt', 'chDp', 'chMx'] },
  { title: 'Stereo delay', on: 'dlOn', keys: ['dlTm', 'dlFb', 'dlMx'] },
  { title: 'Reverb', on: 'rvOn', keys: ['rvSz', 'rvDc', 'rvPd', 'rvMx'] },
];

function fmt(key: NumKey, v: number): string {
  const r = VOXFORGE_RANGES[key];
  const digits = r.step >= 1 ? 0 : r.step >= 0.1 ? 1 : r.step >= 0.01 ? 2 : 3;
  return `${v.toFixed(digits)}${r.unit ? ` ${r.unit}` : ''}`;
}

export function PresetGrid(props: { value: AudioPluginSettings; onChange: (patch: Partial<AudioPluginSettings>) => void }) {
  const all = [...VOXFORGE_PRESETS, ...props.value.userPresets];
  return (
    <div class="preset-grid" role="listbox" aria-label="Voice presets">
      {all.map((p) => (
        <button
          key={p.id}
          type="button"
          role="option"
          aria-selected={props.value.activePresetId === p.id}
          class={props.value.activePresetId === p.id ? 'on' : ''}
          onClick={() => props.onChange({ activePresetId: p.id, params: applyPreset(props.value.params, p) })}
        >
          <b>{p.name}</b>
          <span>{p.blurb}</span>
        </button>
      ))}
    </div>
  );
}

export function FxPanel(props: { value: AudioPluginSettings; onChange: (patch: Partial<AudioPluginSettings>) => void; compact?: boolean }) {
  const p = props.value.params;
  const set = (patch: Partial<VoxForgeParams>) => props.onChange({ params: { ...p, ...patch }, activePresetId: 'custom' });
  return (
    <div class="fx-grid">
      <PresetGrid value={props.value} onChange={props.onChange} />
      {SECTIONS.map((s) => (
        <section class="fx-section" key={s.title}>
          <header>
            <h3>{s.title}</h3>
            {s.on && <Switch checked={p[s.on]} onChange={(v) => set({ [s.on as OnKey]: v } as Partial<VoxForgeParams>)} label="" />}
          </header>
          {s.keys.map((k) => {
            const r = VOXFORGE_RANGES[k];
            return (
              <label class="param" key={k}>
                <span>{r.label}</span>
                <span class="v">{fmt(k, p[k])}</span>
                <input
                  type="range"
                  min={r.min}
                  max={r.max}
                  step={r.step}
                  value={p[k]}
                  disabled={s.on ? !p[s.on] : false}
                  onInput={(e) => set({ [k]: Number((e.currentTarget as HTMLInputElement).value) } as Partial<VoxForgeParams>)}
                />
              </label>
            );
          })}
        </section>
      ))}
    </div>
  );
}

/** One-tap preset chips for the Sing screen and the live stage: applied to the captured voice the instant they are tapped. */
export function PresetChips(props: { value: AudioPluginSettings; onChange: (patch: Partial<AudioPluginSettings>) => void }) {
  const active = VOXFORGE_PRESETS.find((pr) => pr.id === props.value.activePresetId);
  return (
    <div class="stack" style="gap:4px">
      <div class="fxbar" role="listbox" aria-label="Voice preset">
        {VOXFORGE_PRESETS.map((pr) => (
          <button key={pr.id} type="button" role="option" aria-selected={props.value.activePresetId === pr.id} class={props.value.activePresetId === pr.id ? 'on' : ''} title={pr.blurb} onClick={() => props.onChange({ activePresetId: pr.id, params: applyPreset(props.value.params, pr) })}>
            {pr.name}
          </button>
        ))}
      </div>
      {active && (
        <div class="small faint" data-preset-blurb>
          {active.blurb}
        </div>
      )}
    </div>
  );
}
