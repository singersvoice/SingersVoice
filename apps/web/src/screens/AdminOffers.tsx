/**
 * Two tables of the super admin's billing section (offers.ts): the offers — the ways to pay for each
 * plan: a period with its prices in USD and INR, on sale between two dates — and the promo codes — a
 * percentage off, an amount off, or the fee voided for so many periods; good for some plans or all,
 * until a date, for so many uses, once per account. Each row is its own small form with Save and
 * Delete; "Add" opens a new row. Nothing here touches Stripe: a percent or amount code becomes a
 * Stripe coupon the first time a singer pays with it.
 */
import { moneyLabel, periodWords, promoLabel, type AdminBillingOverview, type PlanDef, type PlanId, type PlanOffer, type PlanOfferInput, type PromoCode, type PromoCodeInput } from '@singersvoice/protocol';
import { useState } from 'preact/hooks';
import { Spinner } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { errorText, toast } from '../lib/toast.ts';

const PAID: PlanId[] = ['svv', 'svvpro', 'club'];
const money = (cents: number | undefined) => (cents ? (cents / 100).toFixed(2) : '');
const cents = (v: string): number => {
  const n = Math.round(Number(v.replace(',', '.')) * 100);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
/** An ISO instant → the date for a date box ("2026-12-31"); a date box → the end of that day (UTC) as ISO, so "until Dec 31" includes Dec 31. */
const dateOf = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');
const endOfDay = (date: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59.000Z` : null);
const startOfDay = (date: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : null);
const day = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString() : '');

interface OfferForm {
  plan: PlanId;
  title: string;
  interval: 'month' | 'year';
  intervalCount: string;
  usd: string;
  inr: string;
  from: string;
  until: string;
  active: boolean;
}
const offerForm = (o: PlanOffer | null, plan: PlanId = 'svv'): OfferForm => ({ plan: o?.plan ?? plan, title: o?.title ?? '', interval: o?.interval ?? 'month', intervalCount: String(o?.intervalCount ?? 1), usd: money(o?.prices.usd), inr: money(o?.prices.inr), from: dateOf(o?.validFrom ?? null), until: dateOf(o?.validUntil ?? null), active: o?.active ?? true });
const offerInput = (f: OfferForm): PlanOfferInput => {
  const prices: Record<string, number> = {};
  if (cents(f.usd)) prices.usd = cents(f.usd);
  if (cents(f.inr)) prices.inr = cents(f.inr);
  return { plan: f.plan, title: f.title.trim(), interval: f.interval, intervalCount: Number(f.intervalCount) || 1, prices, validFrom: startOfDay(f.from), validUntil: endOfDay(f.until), active: f.active };
};

function OfferRow(props: { offer: PlanOffer | null; plans: PlanDef[]; onDone: () => void; onCancel?: () => void }) {
  const [f, setF] = useState<OfferForm>(() => offerForm(props.offer));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<OfferForm>) => setF((cur) => ({ ...cur, ...patch }));
  const save = async () => {
    setBusy(true);
    try {
      if (props.offer) await api.patch('PATCH /admin/offers/:id', `/admin/offers/${encodeURIComponent(props.offer.offerId)}`, offerInput(f));
      else await api.post('POST /admin/offers', '/admin/offers', offerInput(f));
      toast(props.offer ? 'Offer saved' : 'Offer added', 'ok');
      props.onDone();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!props.offer || !confirm(`Remove the offer "${props.offer.title || periodWords(props.offer.interval, props.offer.intervalCount)}" for ${props.offer.plan.toUpperCase()}? Singers who paid for it keep what they paid for.`)) return;
    setBusy(true);
    try {
      await api.del('DELETE /admin/offers/:id', `/admin/offers/${encodeURIComponent(props.offer.offerId)}`);
      toast('Offer removed', 'ok');
      props.onDone();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(false);
    }
  };
  const onSale = props.offer ? props.offer.active && (!props.offer.validFrom || Date.parse(props.offer.validFrom) <= Date.now()) && (!props.offer.validUntil || Date.parse(props.offer.validUntil) > Date.now()) && Object.keys(props.offer.prices).length > 0 : false;
  return (
    <div class="row wrap" style="gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line, #ddd)" data-offer-row={props.offer?.offerId ?? 'new'}>
      <select class="input" style="width:7em" value={f.plan} aria-label="Plan" data-offer-plan onChange={(e) => set({ plan: (e.currentTarget as HTMLSelectElement).value as PlanId })}>
        {PAID.map((id) => (
          <option key={id} value={id}>
            {props.plans.find((p) => p.id === id)?.title ?? id}
          </option>
        ))}
      </select>
      <input class="input" style="width:12em" value={f.title} placeholder="Title (Monthly, A year…)" maxLength={60} aria-label="Offer title" data-offer-title onInput={(e) => set({ title: (e.currentTarget as HTMLInputElement).value })} />
      <span class="row" style="gap:4px;align-items:center">
        <input class="input" type="number" min="1" max="36" style="width:4em" value={f.intervalCount} aria-label="How many" data-offer-count onInput={(e) => set({ intervalCount: (e.currentTarget as HTMLInputElement).value })} />
        <select class="input" style="width:6.5em" value={f.interval} aria-label="Period" data-offer-interval onChange={(e) => set({ interval: (e.currentTarget as HTMLSelectElement).value as 'month' | 'year' })}>
          <option value="month">month{Number(f.intervalCount) > 1 ? 's' : ''}</option>
          <option value="year">year{Number(f.intervalCount) > 1 ? 's' : ''}</option>
        </select>
      </span>
      <input class="input" type="number" min="0" step="0.01" style="width:6.5em" value={f.usd} placeholder="USD" aria-label="Price in USD" data-offer-usd onInput={(e) => set({ usd: (e.currentTarget as HTMLInputElement).value })} />
      <input class="input" type="number" min="0" step="0.01" style="width:7em" value={f.inr} placeholder="INR" aria-label="Price in INR" data-offer-inr onInput={(e) => set({ inr: (e.currentTarget as HTMLInputElement).value })} />
      <span class="row" style="gap:4px;align-items:center">
        <span class="small muted">from</span>
        <input class="input" type="date" style="width:9.5em" value={f.from} aria-label="On sale from" data-offer-from onInput={(e) => set({ from: (e.currentTarget as HTMLInputElement).value })} />
        <span class="small muted">until</span>
        <input class="input" type="date" style="width:9.5em" value={f.until} aria-label="On sale until" data-offer-until onInput={(e) => set({ until: (e.currentTarget as HTMLInputElement).value })} />
      </span>
      <label class="switch" style="margin:0">
        <input type="checkbox" checked={f.active} data-offer-active onChange={(e) => set({ active: (e.currentTarget as HTMLInputElement).checked })} />
        <span>
          <div class="small">{f.active ? 'on' : 'off'}</div>
        </span>
      </label>
      {props.offer && <span class={`chip ${onSale ? 'ok' : ''}`} data-offer-standing={onSale ? 'on-sale' : 'off'}>{onSale ? 'on sale' : props.offer.active ? 'not now' : 'off'}</span>}
      <span class="row" style="gap:6px;margin-left:auto">
        <button class="btn sm primary" disabled={busy} data-offer-save onClick={() => void save()}>
          {busy ? <Spinner /> : null} {props.offer ? 'Save' : 'Add'}
        </button>
        {props.offer ? (
          <button class="btn sm danger" disabled={busy} data-offer-delete onClick={() => void remove()}>
            Remove
          </button>
        ) : (
          <button class="btn sm" disabled={busy} onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </span>
    </div>
  );
}

interface PromoForm {
  code: string;
  kind: PromoCode['kind'];
  value: string;
  currency: string;
  plans: PlanId[];
  duration: 'once' | 'forever';
  freePeriods: string;
  maxUses: string;
  until: string;
  active: boolean;
  note: string;
}
const promoForm = (p: PromoCode | null): PromoForm => ({ code: p?.code ?? '', kind: p?.kind ?? 'percent', value: p ? (p.kind === 'amount' ? money(p.value) : String(p.value)) : '20', currency: p?.currency ?? 'usd', plans: p?.plans ?? [], duration: p?.duration ?? 'once', freePeriods: String(p?.freePeriods ?? 1), maxUses: String(p?.maxUses ?? 0), until: dateOf(p?.validUntil ?? null), active: p?.active ?? true, note: p?.note ?? '' });
const promoInput = (f: PromoForm): PromoCodeInput => ({ code: f.code, kind: f.kind, value: f.kind === 'amount' ? cents(f.value) : Number(f.value) || 0, currency: f.kind === 'amount' ? f.currency : null, plans: f.plans, duration: f.duration, freePeriods: Number(f.freePeriods) || 1, maxUses: Number(f.maxUses) || 0, validUntil: endOfDay(f.until), active: f.active, note: f.note.trim() });

function PromoRow(props: { promo: PromoCode | null; plans: PlanDef[]; onDone: () => void; onCancel?: () => void }) {
  const [f, setF] = useState<PromoForm>(() => promoForm(props.promo));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PromoForm>) => setF((cur) => ({ ...cur, ...patch }));
  const save = async () => {
    setBusy(true);
    try {
      if (props.promo) await api.patch('PATCH /admin/promos/:code', `/admin/promos/${encodeURIComponent(props.promo.code)}`, promoInput(f));
      else await api.post('POST /admin/promos', '/admin/promos', promoInput(f));
      toast(props.promo ? 'Code saved' : 'Code added', 'ok');
      props.onDone();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!props.promo || !confirm(`Remove the code ${props.promo.code}? Nobody can use it from now on; what it already gave stays.`)) return;
    setBusy(true);
    try {
      await api.del('DELETE /admin/promos/:code', `/admin/promos/${encodeURIComponent(props.promo.code)}`);
      toast('Code removed', 'ok');
      props.onDone();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(false);
    }
  };
  const togglePlan = (id: PlanId) => set({ plans: f.plans.includes(id) ? f.plans.filter((x) => x !== id) : [...f.plans, id] });
  const expired = props.promo?.validUntil ? Date.parse(props.promo.validUntil) <= Date.now() : false;
  const usedUp = props.promo ? props.promo.maxUses > 0 && props.promo.uses >= props.promo.maxUses : false;
  return (
    <div class="stack" style="gap:6px;padding:6px 0;border-top:1px solid var(--line, #ddd)" data-promo-row={props.promo?.code ?? 'new'}>
      <div class="row wrap" style="gap:8px;align-items:center">
        {props.promo ? <b style="min-width:8em" data-promo-code>{props.promo.code}</b> : <input class="input" style="width:10em;text-transform:uppercase" value={f.code} placeholder="CODE" maxLength={32} aria-label="Code" data-promo-code-input onInput={(e) => set({ code: (e.currentTarget as HTMLInputElement).value })} />}
        <select class="input" style="width:9em" value={f.kind} aria-label="What it gives" data-promo-kind onChange={(e) => set({ kind: (e.currentTarget as HTMLSelectElement).value as PromoCode['kind'] })}>
          <option value="percent">% off</option>
          <option value="amount">amount off</option>
          <option value="free">fee voided</option>
        </select>
        {f.kind === 'percent' && <input class="input" type="number" min="1" max="100" style="width:5em" value={f.value} aria-label="Percent off" data-promo-value onInput={(e) => set({ value: (e.currentTarget as HTMLInputElement).value })} />}
        {f.kind === 'amount' && (
          <span class="row" style="gap:4px;align-items:center">
            <input class="input" type="number" min="0.01" step="0.01" style="width:6.5em" value={f.value} aria-label="Amount off" data-promo-value onInput={(e) => set({ value: (e.currentTarget as HTMLInputElement).value })} />
            <select class="input" style="width:5.5em" value={f.currency} aria-label="Currency" data-promo-currency onChange={(e) => set({ currency: (e.currentTarget as HTMLSelectElement).value })}>
              <option value="usd">USD</option>
              <option value="inr">INR</option>
            </select>
          </span>
        )}
        {f.kind !== 'free' && (
          <select class="input" style="width:11em" value={f.duration} aria-label="On which payments" data-promo-duration onChange={(e) => set({ duration: (e.currentTarget as HTMLSelectElement).value as 'once' | 'forever' })}>
            <option value="once">first payment</option>
            <option value="forever">every payment</option>
          </select>
        )}
        {f.kind === 'free' && (
          <span class="row" style="gap:4px;align-items:center">
            <input class="input" type="number" min="1" max="36" style="width:4.5em" value={f.freePeriods} aria-label="Periods free" data-promo-free onInput={(e) => set({ freePeriods: (e.currentTarget as HTMLInputElement).value })} />
            <span class="small muted">period{Number(f.freePeriods) === 1 ? '' : 's'} free</span>
          </span>
        )}
        <span class="row" style="gap:4px;align-items:center" data-promo-plans>
          {PAID.map((id) => (
            <button key={id} type="button" class={`btn sm ${f.plans.includes(id) ? 'primary' : ''}`} aria-pressed={f.plans.includes(id)} data-promo-plan={id} onClick={() => togglePlan(id)}>
              {props.plans.find((p) => p.id === id)?.title ?? id}
            </button>
          ))}
          <span class="small muted">{f.plans.length ? '' : 'every plan'}</span>
        </span>
      </div>
      <div class="row wrap" style="gap:8px;align-items:center">
        <span class="row" style="gap:4px;align-items:center">
          <span class="small muted">uses</span>
          <input class="input" type="number" min="0" style="width:5em" value={f.maxUses} aria-label="Uses allowed (0 = no limit)" data-promo-max onInput={(e) => set({ maxUses: (e.currentTarget as HTMLInputElement).value })} />
          <span class="small muted">{props.promo ? `(${props.promo.uses} used${Number(f.maxUses) ? '' : ', no limit'})` : '(0 = no limit)'}</span>
        </span>
        <span class="row" style="gap:4px;align-items:center">
          <span class="small muted">until</span>
          <input class="input" type="date" style="width:9.5em" value={f.until} aria-label="Valid until" data-promo-until onInput={(e) => set({ until: (e.currentTarget as HTMLInputElement).value })} />
        </span>
        <input class="input" style="flex:1;min-width:10em" value={f.note} placeholder="A note for you (who got it, why)" maxLength={200} aria-label="Note" data-promo-note onInput={(e) => set({ note: (e.currentTarget as HTMLInputElement).value })} />
        <label class="switch" style="margin:0">
          <input type="checkbox" checked={f.active} data-promo-active onChange={(e) => set({ active: (e.currentTarget as HTMLInputElement).checked })} />
          <span>
            <div class="small">{f.active ? 'on' : 'off'}</div>
          </span>
        </label>
        {props.promo && <span class={`chip ${props.promo.active && !expired && !usedUp ? 'ok' : 'warn'}`} data-promo-standing>{!props.promo.active ? 'off' : expired ? 'expired' : usedUp ? 'used up' : promoLabel(props.promo, moneyLabel)}</span>}
        <span class="row" style="gap:6px;margin-left:auto">
          <button class="btn sm primary" disabled={busy} data-promo-save onClick={() => void save()}>
            {busy ? <Spinner /> : null} {props.promo ? 'Save' : 'Add'}
          </button>
          {props.promo ? (
            <button class="btn sm danger" disabled={busy} data-promo-delete onClick={() => void remove()}>
              Remove
            </button>
          ) : (
            <button class="btn sm" disabled={busy} onClick={props.onCancel}>
              Cancel
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export function AdminOffers(props: { view: AdminBillingOverview; reload: () => Promise<void> | void }) {
  const [newOffer, setNewOffer] = useState(false);
  const [newPromo, setNewPromo] = useState(false);
  const plans = props.view.settings.plans;
  const done = (close: () => void) => () => {
    close();
    void props.reload();
  };
  return (
    <>
      <div class="stack" style="gap:4px" data-offers-admin>
        <div class="row between wrap" style="align-items:center">
          <div>
            <b>Offers — the ways to pay for a plan</b>
            <div class="small muted">A period (a month, a year, three months…) with its prices, on sale between two dates. A plan with offers shows them on the Plans page instead of its one price; a plan with none sells at the price above.</div>
          </div>
          {!newOffer && (
            <button class="btn sm" data-offer-add onClick={() => setNewOffer(true)}>
              Add an offer
            </button>
          )}
        </div>
        {props.view.offers.map((o) => (
          <OfferRow key={`${o.offerId}:${o.updatedAt}`} offer={o} plans={plans} onDone={done(() => undefined)} />
        ))}
        {newOffer && <OfferRow offer={null} plans={plans} onDone={done(() => setNewOffer(false))} onCancel={() => setNewOffer(false)} />}
        {!props.view.offers.length && !newOffer && <div class="small faint">No offers yet — every plan sells at its one price above.</div>}
      </div>

      <div class="stack" style="gap:4px" data-promos-admin>
        <div class="row between wrap" style="align-items:center">
          <div>
            <b>Promo codes</b>
            <div class="small muted">A percentage off, an amount off, or the fee voided (the plan for so many periods with no payment at all). For some plans or every plan, until a date, for so many uses — once per account. A singer types the code on the Plans page; percent and amount codes go to Stripe as a coupon, a fee-void code never reaches Stripe.</div>
          </div>
          {!newPromo && (
            <button class="btn sm" data-promo-add onClick={() => setNewPromo(true)}>
              Add a code
            </button>
          )}
        </div>
        {props.view.promos.map((p) => (
          <PromoRow key={`${p.code}:${p.updatedAt}`} promo={p} plans={plans} onDone={done(() => undefined)} />
        ))}
        {newPromo && <PromoRow promo={null} plans={plans} onDone={done(() => setNewPromo(false))} onCancel={() => setNewPromo(false)} />}
        {!props.view.promos.length && !newPromo && <div class="small faint">No codes yet.</div>}
        {props.view.promos.some((p) => p.validUntil) && <div class="small faint">Dates are the end of the day (UTC). {props.view.promos.filter((p) => p.validUntil && Date.parse(p.validUntil) > Date.now()).map((p) => `${p.code} until ${day(p.validUntil)}`).join(' · ')}</div>}
      </div>
    </>
  );
}
