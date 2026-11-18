/**
 * The super admin's club owner portal — a section of the Admin page: the price of a year and the
 * rules (self-service on the Club owner page, the note shown there, when a year counts as expiring,
 * the grace days after an expiry), every club owner by standing — the expired and the expiring
 * first, with the days left, so the ones to renew or revoke are at the top — with Grant / Renew /
 * Revoke in the row, and the payments on record (Stripe's, and the years granted here).
 */
import { moneyLabel, type ClubOwnerOverview, type ClubOwnerRow, type ClubOwnerSettings, type ClubOwnerStanding } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Spinner, Switch } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { errorText, toast } from '../lib/toast.ts';
import { PaymentLine } from './ClubOwner.tsx';

const day = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString() : '—');

interface Form {
  price: string;
  currency: string;
  selfService: boolean;
  note: string;
  expiringSoonDays: string;
  graceDays: string;
}
const formOf = (s: ClubOwnerSettings): Form => ({ price: (s.priceCents / 100).toFixed(2), currency: s.currency.toUpperCase(), selfService: s.selfService, note: s.note, expiringSoonDays: String(s.expiringSoonDays), graceDays: String(s.graceDays) });

/** The standing in words, with the days: "active · 212 days left", "expiring · 9 days left", "expired · 40 days ago". */
export function standingLabel(r: Pick<ClubOwnerRow, 'standing' | 'daysLeft'>): string {
  const d = r.daysLeft;
  if (r.standing === 'none') return 'no year yet';
  if (r.standing === 'revoked') return 'revoked';
  if (r.standing === 'expired') return d === null ? 'expired' : `expired · ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago`;
  if (d === null) return `${r.standing} · no end date`;
  if (d < 0) return `${r.standing} · ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} past, in the grace days`;
  return `${r.standing} · ${d} day${d === 1 ? '' : 's'} left`;
}
const chipClass: Record<ClubOwnerStanding, string> = { active: 'ok', expiring: 'warn', expired: 'warn', revoked: '', none: '' };

/** `tick` changes when the Accounts list below changed a subscription: the overview follows. */
export function AdminClubOwners(props: { onChanged?: () => void; tick?: number }) {
  const [view, setView] = useState<ClubOwnerOverview | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [allPayments, setAllPayments] = useState(false);

  const load = async () => {
    try {
      const v = await api.get('GET /admin/club-owners', '/admin/club-owners');
      setView(v);
      setForm((f) => f ?? formOf(v.settings));
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    }
  };
  useEffect(() => void load(), [props.tick ?? 0]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const priceCents = Math.round(Number(form.price.replace(',', '.')) * 100);
      const r = await api.put('PUT /admin/club-owners/settings', '/admin/club-owners/settings', {
        priceCents: Number.isFinite(priceCents) && priceCents >= 0 ? priceCents : 0,
        currency: form.currency.trim().toLowerCase() || 'usd',
        selfService: form.selfService,
        note: form.note.trim(),
        expiringSoonDays: Number(form.expiringSoonDays) || 0,
        graceDays: Number(form.graceDays) || 0,
      });
      setForm(formOf(r.settings));
      setView((v) => (v ? { ...v, settings: r.settings } : v));
      toast(r.settings.priceCents > 0 ? `Saved — a club owner year is ${moneyLabel(r.settings.priceCents, r.settings.currency)}` : 'Saved — no price set: years are granted here', 'ok');
      void load(); // standings follow the margins
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setSaving(false);
    }
  };

  const act = async (r: ClubOwnerRow, action: 'grant' | 'renew' | 'revoke', done: string) => {
    setBusy(r.user.userId);
    try {
      await api.patch('PATCH /admin/users/:id', `/admin/users/${encodeURIComponent(r.user.userId)}`, { subscription: { action } });
      toast(`${r.user.name || r.user.email}: ${done}`, 'ok');
      await load();
      props.onChanged?.();
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const payments = view?.payments ?? [];
  const who = (userId: string) => {
    const u = view?.owners.find((o) => o.user.userId === userId)?.user;
    return u ? u.name || u.email : userId;
  };

  return (
    <section class="card stack pad-sm" data-club-owners>
      <div class="row between wrap">
        <div>
          <h3 style="margin:0">Club owners</h3>
          <div class="small muted">The price of a club owner year and how it is sold; every club owner by standing — the expired and the expiring first; the payments.</div>
        </div>
        {view && <span class={`chip ${view.stripe ? 'ok' : 'warn'}`} data-stripe={view.stripe ? 'on' : 'off'}>{view.stripe ? 'Stripe connected — singers pay on the Club owner page' : 'Stripe not set up (STRIPE_SECRET_KEY) — years are granted here'}</span>}
      </div>
      {!view && (
        <div class="row">
          <Spinner /> Loading club owners…
        </div>
      )}

      {form && (
        <div class="stack" style="gap:8px" data-co-settings>
          <div class="row wrap" style="gap:12px;align-items:flex-end">
            <div class="field" style="margin:0">
              <label>Price of a year</label>
              <input class="input" type="number" min="0" step="0.01" style="width:9em" value={form.price} data-co-price onInput={(e) => set({ price: (e.currentTarget as HTMLInputElement).value })} />
            </div>
            <div class="field" style="margin:0">
              <label>Currency</label>
              <input class="input" maxLength={3} style="width:5em" value={form.currency} data-co-currency onInput={(e) => set({ currency: (e.currentTarget as HTMLInputElement).value })} />
            </div>
            <div class="field" style="margin:0">
              <label>Expiring soon (days)</label>
              <input class="input" type="number" min="0" max="365" style="width:7em" value={form.expiringSoonDays} data-co-expiring onInput={(e) => set({ expiringSoonDays: (e.currentTarget as HTMLInputElement).value })} />
            </div>
            <div class="field" style="margin:0">
              <label>Grace days after expiry</label>
              <input class="input" type="number" min="0" max="90" style="width:7em" value={form.graceDays} data-co-grace onInput={(e) => set({ graceDays: (e.currentTarget as HTMLInputElement).value })} />
            </div>
          </div>
          <Switch checked={form.selfService} onChange={(v) => set({ selfService: v })} label="Self-service: singers pay for a year themselves on the Club owner page" hint="Needs Stripe on the service and a price above 0. Off, the page says to ask you, and you grant years below." />
          <div class="field" style="margin:0">
            <label>A note on the Club owner page</label>
            <input class="input" value={form.note} placeholder="What a club owner gets, how to reach you…" maxLength={500} data-co-note onInput={(e) => set({ note: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="row wrap" style="gap:8px;align-items:center">
            <button class="btn primary" disabled={saving} data-co-save onClick={() => void save()}>
              {saving ? <Spinner /> : null} Save
            </button>
            <span class="small faint">0.00 = not for sale here. A year flagged "expiring" this many days before its end; Publishing stays open this many grace days after it. {view?.settings.updatedAt ? `Last saved ${day(view.settings.updatedAt)}.` : ''}</span>
          </div>
        </div>
      )}

      {view && (
        <div class="stack" style="gap:6px" data-co-overview>
          <b>Who has a year</b>
          {!view.owners.length && <div class="muted small">No club owner yet — grant a year to an account below, or set a price and let singers pay.</div>}
          {view.owners.map((r) => {
            const u = r.user;
            const sub = u.subscription;
            const working = busy === u.userId;
            return (
              <div class="row wrap" style="gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line, #ddd)" key={u.userId} data-co-row={u.email} data-co-standing={r.standing}>
                <div style="min-width:12em">
                  <b>{u.name || u.email}</b>
                  <div class="small muted">{u.email}</div>
                </div>
                <span class={`chip ${chipClass[r.standing]}`} data-co-standing-label>
                  {standingLabel(r)}
                </span>
                <span class="small muted">
                  {sub?.startedAt ? `from ${day(sub.startedAt)}` : ''}
                  {sub?.expiresAt ? ` until ${day(sub.expiresAt)}` : sub && r.standing === 'active' ? ' · no end date' : ''}
                </span>
                {sub && <span class="chip">{sub.source === 'stripe' ? 'Stripe' : 'granted'}</span>}
                <span class="small muted" data-co-last-payment>
                  {r.lastPayment ? `last payment ${r.lastPayment.source === 'grant' ? 'granted' : moneyLabel(r.lastPayment.amountCents, r.lastPayment.currency)} on ${day(r.lastPayment.paidAt)}` : 'no payment on record'}
                </span>
                <span class="row" style="gap:6px;margin-left:auto">
                  {(r.standing === 'none' || r.standing === 'expired' || r.standing === 'revoked') && (
                    <button class="btn sm primary" disabled={working} data-co-grant onClick={() => void act(r, 'grant', 'a year granted — Publishing is open')}>
                      Grant a year
                    </button>
                  )}
                  {(r.standing === 'active' || r.standing === 'expiring') && (
                    <button class="btn sm accent" disabled={working} data-co-renew onClick={() => void act(r, 'renew', 'renewed for a year')}>
                      Renew (+1 year)
                    </button>
                  )}
                  {sub && r.standing !== 'revoked' && (
                    <button class="btn sm danger" disabled={working} data-co-revoke onClick={() => confirm(`Revoke ${u.name || u.email}'s club owner year? Publishing mode closes for them at once.`) && void act(r, 'revoke', 'revoked — Publishing is closed')}>
                      Revoke
                    </button>
                  )}
                  {working && <Spinner />}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {view && payments.length > 0 && (
        <div class="stack" style="gap:4px" data-co-payments>
          <b>Payments</b>
          {(allPayments ? payments : payments.slice(0, 12)).map((p) => (
            <PaymentLine key={p.id} p={p} who={who(p.userId)} />
          ))}
          {payments.length > 12 && (
            <button class="btn sm" style="align-self:flex-start" onClick={() => setAllPayments((v) => !v)}>
              {allPayments ? 'Fewer' : `All ${payments.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
