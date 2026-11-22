/**
 * The Admin page (/admin) — the super admin's: the billing portal (AdminBilling.tsx — the plans with
 * their prices, periods, hours and seats; every subscriber by standing; the payments and refunds) and
 * every account with its role and its subscription, changed in place and kept in the SVT DB; the
 * service enforces every change on its next request (the picture on stage and Publishing open and
 * close with the plan by themselves, an audio-only account gets no camera anywhere).
 *
 *   Role          — Audio only · Dual (audio + video) · Club owner · Super admin
 *   Subscription  — a plan (SVV, SVVPro, Club owner) for a period: Grant · Renew · Set the dates · Revoke
 *
 * A subscription's standing (`expired`, after the grace days) is the service's verdict, never recomputed here.
 */
import { hoursLabel, roleTitle, USER_ROLES, type PlanId, type UserRecord, type UserRole } from '@singersvoice/protocol';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Page } from '../components/Shell.tsx';
import { Empty, Spinner } from '../components/ui.tsx';
import { api, controlConfigured, refreshAccount } from '../lib/api.ts';
import { href } from '../lib/nav.ts';
import { errorText, toast } from '../lib/toast.ts';
import { accountUserId, isSuperAdmin } from '../state/session.ts';
import { AdminBilling } from './AdminBilling.tsx';
import { AdminLive } from './AdminLive.tsx';
import { AdminSocial } from './AdminSocial.tsx';

const day = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString() : '—');

export function Admin() {
  const [users, setUsers] = useState<UserRecord[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [dates, setDates] = useState<Record<string, { startedAt: string; expiresAt: string }>>({});
  /** The plan and the months picked per account for a grant (the plan's own period when no months are given). */
  const [grants, setGrants] = useState<Record<string, { plan: PlanId; months: string }>>({});
  const PLAN_TITLES: Record<PlanId, string> = { free: 'Free', svv: 'SVV', svvpro: 'SVVPro', club: 'Club owner' };
  const [tick, setTick] = useState(0); // a change below: the club owner overview above reloads

  const load = async () => {
    try {
      const r = await api.get('GET /admin/users', '/admin/users');
      setUsers(r.users);
    } catch (e) {
      setUsers([]);
      toast(errorText(e), 'error', 8000);
    }
  };
  // The account's role as the service has it right now (a super admin made a minute ago on another device's Admin page
  // opens this one on their next visit), then the accounts.
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!controlConfigured.value) {
      setChecked(true);
      return;
    }
    void refreshAccount().finally(() => setChecked(true));
  }, []);
  useEffect(() => {
    if (checked && isSuperAdmin.value && controlConfigured.value) void load();
  }, [checked, isSuperAdmin.value]);
  // A link to a section of this page (`/admin#billing`, the Home search): scrolled to once the sections are up.
  useEffect(() => {
    if (checked && /^#[a-z]+$/.test(location.hash)) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' }), 300);
  }, [checked]);

  const change = async (u: UserRecord, body: Parameters<typeof api.patch<'PATCH /admin/users/:id'>>[2], done: string) => {
    setBusy(u.userId);
    try {
      const r = await api.patch('PATCH /admin/users/:id', `/admin/users/${encodeURIComponent(u.userId)}`, body);
      setUsers((list) => (list ?? []).map((x) => (x.userId === r.user.userId ? r.user : x)));
      if (body.subscription) setTick((t) => t + 1);
      toast(`${r.user.name || r.user.email}: ${done}`, 'ok');
      if (r.user.userId === accountUserId.value) void refreshAccount(); // my own account changed: the app follows at once
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (users ?? []).filter((u) => !needle || `${u.name} ${u.email} sv-${u.svNo} ${u.phone} ${roleTitle(u.role)}${u.blocked ? ' blocked' : ''}`.toLowerCase().includes(needle));
  }, [users, q]);
  const counts = useMemo(() => {
    const c: Record<UserRole, number> = { audio: 0, dual: 0, club_owner: 0, super_admin: 0 };
    for (const u of users ?? []) c[u.role] += 1;
    return c;
  }, [users]);

  if (!checked)
    return (
      <Page title="Admin">
        <div class="row">
          <Spinner /> Checking your account…
        </div>
      </Page>
    );
  if (!isSuperAdmin.value)
    return (
      <Page title="Admin">
        <Empty title="Super admins only" body="This page manages the plans and their prices, every account's role and plan, the payments.">
          <a class="btn" href={href('/home')}>
            Home
          </a>
        </Empty>
      </Page>
    );
  if (!controlConfigured.value)
    return (
      <Page title="Admin">
        <div class="callout warn">The SingersVoice service is not configured for this build (VITE_CONTROL_URL) — accounts live there.</div>
      </Page>
    );

  return (
    <Page title="Admin">
      <div class="stack" data-admin>
        <AdminLive />
        <AdminSocial />
        <section class="card stack pad-sm" id="coupons" data-coupons-link>
          <div class="row between wrap">
            <div>
              <h3 style="margin:0">Coupons</h3>
              <div class="small muted">Who may use SingersVoice: a coupon with an expiry date per email address, checked on every request.</div>
            </div>
            <a class="btn primary" href={href('/admin/coupons')}>
              Open Coupons
            </a>
          </div>
        </section>
        <AdminBilling onChanged={() => void load()} tick={tick} />
        <section class="card stack pad-sm" id="accounts">
          <div class="row between wrap">
            <div>
              <h3 style="margin:0">Accounts</h3>
              <div class="small muted">Every account that ever signed in. A role takes effect on the account's next request; Publishing mode opens for a club owner while the subscription is active and closes by itself at its expiry.</div>
            </div>
            <div class="row small" style="gap:6px;flex-wrap:wrap">
              {USER_ROLES.map((r) => (
                <span class="chip" key={r.role} data-role-count={r.role}>
                  {r.title}: {counts[r.role]}
                </span>
              ))}
            </div>
          </div>
          <input class="input" placeholder="Find by name, email or role" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} data-admin-search />
          {users === null && (
            <div class="row">
              <Spinner /> Loading accounts…
            </div>
          )}
          {users && !shown.length && <div class="muted small">No account matches.</div>}
          <div class="list">
            {shown.map((u) => {
              const sub = u.subscription;
              const standing = sub?.status ?? 'none';
              const d = dates[u.userId] ?? { startedAt: (sub?.startedAt ?? '').slice(0, 10), expiresAt: (sub?.expiresAt ?? '').slice(0, 10) };
              const g = grants[u.userId] ?? { plan: (sub?.plan && sub.plan !== 'free' ? sub.plan : 'club') as PlanId, months: '' };
              const months = Number(g.months) > 0 ? Math.round(Number(g.months)) : undefined;
              const e = u.entitlement;
              const me = u.userId === accountUserId.value;
              const working = busy === u.userId;
              return (
                <div class="item wide-actions" key={u.userId} data-admin-user={u.email} data-user-role={u.role}>
                  <div class="thumb" style="overflow:hidden">
                    {u.picture ? <img src={u.picture} alt="" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover" /> : <span>{(u.name || u.email || '?').slice(0, 1).toUpperCase()}</span>}
                  </div>
                  <div class="meta">
                    <div class="t">
                      {u.name || u.email} <span class="chip" data-user-sv-no={u.svNo}>SV-{u.svNo}</span> {me && <span class="chip">you</span>} {u.blocked && <span class="chip danger" data-user-blocked>blocked{u.blockedNote ? ` · ${u.blockedNote}` : ''}</span>} {u.role === 'super_admin' && <span class="chip ok">super admin</span>} {u.canPublish && u.role !== 'super_admin' && <span class="chip ok">publishing open</span>}{' '}
                      {u.role !== 'super_admin' && (
                        <span class={`chip ${e.video ? 'ok' : ''}`} data-user-plan={e.plan} data-user-via={e.via}>
                          {e.via === 'club' ? `${e.planTitle} · ${e.clubOwner?.name ?? 'a club'}'s member` : e.planTitle}
                          {e.videoHours > 0 ? ` · video ${hoursLabel(e.videoUsedSeconds)} of ${e.videoHours} h` : ' · voice only'}
                        </span>
                      )}
                    </div>
                    <div class="s">
                      {u.email}
                      {u.phone ? ` · ${u.phone}` : ''} · joined {day(u.createdAt)} · last seen {day(u.lastSeenAt)}
                    </div>
                    <div class="row wrap" style="gap:8px;margin-top:6px;align-items:center">
                      {u.role !== 'super_admin' &&
                        (u.blocked ? (
                          <button class="btn sm" disabled={working} data-unblock onClick={() => void change(u, { blocked: false }, 'let back in')}>
                            Unblock
                          </button>
                        ) : (
                          <button
                            class="btn sm danger"
                            disabled={working}
                            data-block-forever
                            onClick={() => {
                              const note = prompt(`Block ${u.name || u.email} (SV-${u.svNo}) for good? They are refused everything from their next tap. A note for the admins (optional):`);
                              if (note !== null) void change(u, { blocked: true, blockedNote: note.trim() }, 'blocked for good');
                            }}
                          >
                            Block for good
                          </button>
                        ))}
                      <label class="small muted">Role</label>
                      <select class="input" style="width:auto" value={u.role} disabled={working} data-role-select onChange={(e) => void change(u, { role: (e.currentTarget as HTMLSelectElement).value as UserRole }, `now ${roleTitle((e.currentTarget as HTMLSelectElement).value as UserRole)}`)}>
                        {USER_ROLES.map((r) => (
                          <option value={r.role} key={r.role}>
                            {r.title}
                          </option>
                        ))}
                      </select>
                      <span class="small faint">{USER_ROLES.find((r) => r.role === u.role)?.blurb}</span>
                    </div>
                    {u.role !== 'super_admin' && (
                      <div class="stack" style="gap:6px;margin-top:8px" data-subscription={standing} data-subscription-plan={sub?.plan ?? ''}>
                        <div class="row wrap small" style="gap:8px;align-items:center">
                          <b>Plan</b>
                          {sub && standing !== 'none' && <span class="chip">{PLAN_TITLES[(sub.plan as PlanId) ?? 'free'] ?? sub.plan}</span>}
                          <span class={`chip ${standing === 'active' ? 'ok' : standing === 'none' ? '' : 'warn'}`}>{standing === 'none' ? 'none yet' : standing}</span>
                          {sub?.startedAt && standing !== 'none' && <span class="muted">from {day(sub.startedAt)}</span>}
                          {sub?.expiresAt && standing !== 'none' ? <span class="muted">until {day(sub.expiresAt)}</span> : sub && standing === 'active' ? <span class="muted">no end date</span> : null}
                          {sub?.source === 'stripe' && standing !== 'none' && <span class="chip">Stripe</span>}
                        </div>
                        <div class="row wrap" style="gap:6px;align-items:center">
                          <select class="input" style="width:auto" value={g.plan} disabled={working} aria-label="Plan to grant" data-grant-plan onChange={(e) => setGrants((x) => ({ ...x, [u.userId]: { ...g, plan: (e.currentTarget as HTMLSelectElement).value as PlanId } }))}>
                            {(['svv', 'svvpro', 'club'] as PlanId[]).map((id) => (
                              <option value={id} key={id}>
                                {PLAN_TITLES[id]}
                              </option>
                            ))}
                          </select>
                          <input class="input" type="number" min="1" max="120" style="width:6em" placeholder="months" value={g.months} disabled={working} aria-label="Months" data-grant-months onInput={(e) => setGrants((x) => ({ ...x, [u.userId]: { ...g, months: (e.currentTarget as HTMLInputElement).value } }))} />
                          <button class="btn sm primary" disabled={working} data-sub-grant onClick={() => void change(u, { subscription: { action: 'grant', plan: g.plan, months } }, `${PLAN_TITLES[g.plan]} granted${months ? ` for ${months} month${months === 1 ? '' : 's'}` : ''}`)}>
                            Grant
                          </button>
                          {sub && standing !== 'revoked' && standing !== 'none' && (
                            <button class="btn sm accent" disabled={working} data-sub-renew onClick={() => void change(u, { subscription: { action: 'renew', months } }, months ? `renewed for ${months} month${months === 1 ? '' : 's'}` : 'renewed for a period')}>
                              Renew
                            </button>
                          )}
                          <input class="input" type="date" style="width:auto" value={d.startedAt} disabled={working} aria-label="Start date" onInput={(e) => setDates((x) => ({ ...x, [u.userId]: { ...d, startedAt: (e.currentTarget as HTMLInputElement).value } }))} />
                          <input class="input" type="date" style="width:auto" value={d.expiresAt} disabled={working} aria-label="Expiry date" onInput={(e) => setDates((x) => ({ ...x, [u.userId]: { ...d, expiresAt: (e.currentTarget as HTMLInputElement).value } }))} />
                          <button class="btn sm" disabled={working || !d.startedAt} data-sub-set onClick={() => void change(u, { subscription: { action: 'set', plan: g.plan, startedAt: `${d.startedAt}T00:00:00Z`, expiresAt: d.expiresAt ? `${d.expiresAt}T23:59:59Z` : null } }, 'dates set')}>
                            Set dates
                          </button>
                          {sub && standing !== 'revoked' && standing !== 'none' && (
                            <button class="btn sm danger" disabled={working} data-sub-revoke onClick={() => confirm(`Revoke ${u.name || u.email}'s plan? Their picture on stage (and Publishing, for a club owner) closes at once.`) && void change(u, { subscription: { action: 'revoke' } }, 'plan revoked')}>
                              Revoke
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <div class="actions">{working && <Spinner />}</div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </Page>
  );
}
