/**
 * The Admin page (/admin) — the super admin's: every account with its role and its club owner
 * subscription, changed in place and kept in the SVT DB; the service enforces every change on its
 * next request (Publishing mode opens and closes with the subscription by itself, an audio-only
 * account gets no camera on stage).
 *
 *   Role          — Audio only · Dual (audio + video) · Club owner · Super admin
 *   Subscription  — a club owner's year: Grant a year · Renew (a year on) · Set the dates · Revoke
 */
import { roleTitle, subscriptionStatus, USER_ROLES, type UserRecord, type UserRole } from '@singersvoice/protocol';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Page } from '../components/Shell.tsx';
import { Empty, Spinner } from '../components/ui.tsx';
import { api, controlConfigured, refreshAccount } from '../lib/api.ts';
import { href } from '../lib/nav.ts';
import { errorText, toast } from '../lib/toast.ts';
import { accountUserId, isSuperAdmin } from '../state/session.ts';

const day = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleDateString() : '—');

export function Admin() {
  const [users, setUsers] = useState<UserRecord[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [dates, setDates] = useState<Record<string, { startedAt: string; expiresAt: string }>>({});

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

  const change = async (u: UserRecord, body: Parameters<typeof api.patch<'PATCH /admin/users/:id'>>[2], done: string) => {
    setBusy(u.userId);
    try {
      const r = await api.patch('PATCH /admin/users/:id', `/admin/users/${encodeURIComponent(u.userId)}`, body);
      setUsers((list) => (list ?? []).map((x) => (x.userId === r.user.userId ? r.user : x)));
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
    return (users ?? []).filter((u) => !needle || `${u.name} ${u.email} ${roleTitle(u.role)}`.toLowerCase().includes(needle));
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
        <Empty title="Super admins only" body="This page manages every account's role, publishing access and club owner subscription.">
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
        <section class="card stack pad-sm">
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
              const standing = subscriptionStatus(sub);
              const d = dates[u.userId] ?? { startedAt: (sub?.startedAt ?? '').slice(0, 10), expiresAt: (sub?.expiresAt ?? '').slice(0, 10) };
              const me = u.userId === accountUserId.value;
              const working = busy === u.userId;
              return (
                <div class="item wide-actions" key={u.userId} data-admin-user={u.email} data-user-role={u.role}>
                  <div class="thumb" style="overflow:hidden">
                    {u.picture ? <img src={u.picture} alt="" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover" /> : <span>{(u.name || u.email || '?').slice(0, 1).toUpperCase()}</span>}
                  </div>
                  <div class="meta">
                    <div class="t">
                      {u.name || u.email} {me && <span class="chip">you</span>} {u.role === 'super_admin' && <span class="chip ok">super admin</span>} {u.canPublish && u.role !== 'super_admin' && <span class="chip ok">publishing open</span>}
                    </div>
                    <div class="s">
                      {u.email} · joined {day(u.createdAt)} · last seen {day(u.lastSeenAt)}
                    </div>
                    <div class="row wrap" style="gap:8px;margin-top:6px;align-items:center">
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
                    {(u.role === 'club_owner' || sub) && (
                      <div class="stack" style="gap:6px;margin-top:8px" data-subscription={standing}>
                        <div class="row wrap small" style="gap:8px;align-items:center">
                          <b>Club owner subscription</b>
                          <span class={`chip ${standing === 'active' ? 'ok' : standing === 'none' ? '' : 'warn'}`}>{standing === 'none' ? 'none yet' : standing}</span>
                          {sub?.startedAt && <span class="muted">from {day(sub.startedAt)}</span>}
                          {sub?.expiresAt ? <span class="muted">until {day(sub.expiresAt)}</span> : sub && standing === 'active' ? <span class="muted">no end date</span> : null}
                          {sub?.source === 'stripe' && <span class="chip">Stripe</span>}
                        </div>
                        <div class="row wrap" style="gap:6px">
                          {standing !== 'active' && (
                            <button class="btn sm primary" disabled={working} data-sub-grant onClick={() => void change(u, { subscription: { action: 'grant' } }, 'a year granted — Publishing is open')}>
                              Grant a year
                            </button>
                          )}
                          {sub && standing !== 'revoked' && (
                            <button class="btn sm accent" disabled={working} data-sub-renew onClick={() => void change(u, { subscription: { action: 'renew' } }, 'renewed for a year')}>
                              Renew (+1 year)
                            </button>
                          )}
                          <input class="input" type="date" style="width:auto" value={d.startedAt} disabled={working} aria-label="Start date" onInput={(e) => setDates((x) => ({ ...x, [u.userId]: { ...d, startedAt: (e.currentTarget as HTMLInputElement).value } }))} />
                          <input class="input" type="date" style="width:auto" value={d.expiresAt} disabled={working} aria-label="Expiry date" onInput={(e) => setDates((x) => ({ ...x, [u.userId]: { ...d, expiresAt: (e.currentTarget as HTMLInputElement).value } }))} />
                          <button class="btn sm" disabled={working || !d.startedAt} data-sub-set onClick={() => void change(u, { subscription: { action: 'set', startedAt: `${d.startedAt}T00:00:00Z`, expiresAt: d.expiresAt ? `${d.expiresAt}T23:59:59Z` : null } }, 'dates set')}>
                            Set dates
                          </button>
                          {sub && standing !== 'revoked' && (
                            <button class="btn sm danger" disabled={working} data-sub-revoke onClick={() => confirm(`Revoke ${u.name || u.email}'s club owner subscription? Publishing mode closes for them at once.`) && void change(u, { subscription: { action: 'revoke' } }, 'subscription revoked — Publishing is closed')}>
                              Revoke
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {u.role !== 'club_owner' && !sub && u.role !== 'super_admin' && (
                      <div class="row" style="margin-top:6px">
                        <button class="btn sm" disabled={working} data-sub-grant onClick={() => void change(u, { subscription: { action: 'grant' } }, 'made a club owner with a year — Publishing is open')}>
                          Make a club owner (grant a year)
                        </button>
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
