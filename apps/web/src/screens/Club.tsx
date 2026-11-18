/**
 * My club (/club) — the club owner's page: the members named so far (email addresses — whoever signs
 * in to SingersVoice with that address has the club's picture on stage, drawing on the club's hours),
 * a plain box and an Add button to name one more, Remove on each, the seats used, and the club's video
 * hours used this month. The owner is in their own club without a seat.
 */
import { hoursLabel, periodLabel, type ClubStatus } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Page } from '../components/Shell.tsx';
import { Empty, Spinner } from '../components/ui.tsx';
import { api, ApiError, controlConfigured, refreshAccount } from '../lib/api.ts';
import { href } from '../lib/nav.ts';
import { errorText, toast } from '../lib/toast.ts';
import { ownsClub } from '../state/session.ts';

export function Club() {
  const [club, setClub] = useState<ClubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);

  const load = async () => {
    try {
      setClub(await api.get('GET /club', '/club'));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'no_club' ? '' : errorText(e));
      if (e instanceof ApiError && e.code === 'no_club') setClub(null);
    }
  };
  useEffect(() => {
    if (!controlConfigured.value) {
      setChecked(true);
      return;
    }
    void refreshAccount().finally(() => {
      setChecked(true);
      void load();
    });
  }, []);

  const add = async () => {
    const e = email.trim();
    if (!e) return;
    setBusy(true);
    try {
      setClub(await api.post('POST /club/members', '/club/members', { email: e }));
      setEmail('');
      toast(`${e.toLowerCase()} is in your club`, 'ok');
      void refreshAccount();
    } catch (err) {
      toast(errorText(err), 'warn', 7000);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (addr: string) => {
    if (!confirm(`Remove ${addr} from your club? Their picture on stage goes with it.`)) return;
    setBusy(true);
    try {
      setClub(await api.del('DELETE /club/members/:email', `/club/members/${encodeURIComponent(addr)}`));
      toast(`${addr} removed`, 'ok');
      void refreshAccount();
    } catch (err) {
      toast(errorText(err), 'error', 7000);
    } finally {
      setBusy(false);
    }
  };

  if (!controlConfigured.value)
    return (
      <Page title="My club">
        <div class="callout warn">Clubs need the SingersVoice service (VITE_CONTROL_URL).</div>
      </Page>
    );
  if (checked && !ownsClub.value && !club)
    return (
      <Page title="My club">
        <Empty title="A club comes with the Club owner plan" body="Name up to 15 members who share 300 hours of video on stage a month with you, and stream your meets with Publishing mode.">
          <a class="btn primary" href={href('/plans')}>
            See the plans
          </a>
        </Empty>
      </Page>
    );
  const pool = club?.pool;
  const left = pool ? Math.max(0, pool.hours * 3600 - pool.usedSeconds) : 0;
  return (
    <Page title="My club">
      <div class="stack" style="gap:18px" data-club>
        {!club && !error && (
          <div class="row">
            <Spinner /> Loading your club…
          </div>
        )}
        {error && <div class="callout warn">{error}</div>}
        {club && pool && (
          <section class="card stack pad-sm" data-club-pool>
            <div class="row between wrap">
              <div>
                <div class="small muted">Your club · {club.plan.title}</div>
                <b style="font-size:1.2em">
                  {club.members.length} of {club.seats} members
                </b>
              </div>
              <div class="small" style="text-align:right">
                <div data-pool-left={left}>
                  Video this month: <b>{hoursLabel(left)}</b> of {pool.hours} h left between all of you · {periodLabel(pool.periodKey)}, starts again on {pool.resetsAt.slice(0, 10)}
                </div>
                <div class="muted">Used so far: {hoursLabel(pool.usedSeconds)} (the clock runs while any member is on stage with the picture on)</div>
              </div>
            </div>
            {club.subscription?.expiresAt && <div class="small faint">Your plan {club.subscription.source === 'stripe' ? 'renews' : 'runs until'} {new Date(club.subscription.expiresAt).toLocaleDateString()}.</div>}
          </section>
        )}
        {club && (
          <section class="card stack" data-club-members>
            <h3 style="margin:0">Members</h3>
            <div class="small muted">Add the Google email address a member signs in to SingersVoice with. From their next visit, their picture is on stage in live meets, on the club's hours. Members do not get Publishing mode — that stays yours.</div>
            <form
              class="row wrap"
              style="gap:8px;align-items:center"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <input class="input" type="email" placeholder="singer@gmail.com" value={email} disabled={busy || club.members.length >= club.seats} style="flex:1;min-width:16em" data-club-email onInput={(e) => setEmail((e.currentTarget as HTMLInputElement).value)} />
              <button class="btn primary" type="submit" disabled={busy || !email.trim() || club.members.length >= club.seats} data-club-add>
                {busy ? <Spinner /> : null} Add
              </button>
            </form>
            {club.members.length >= club.seats && <div class="small faint">Your club has its {club.seats} members — remove one to add another.</div>}
            {!club.members.length && <div class="muted small">Nobody named yet.</div>}
            <div class="list">
              {club.members.map((m) => (
                <div class="item" key={m.email} data-club-member={m.email}>
                  <div class="thumb" style="overflow:hidden">
                    {m.user?.picture ? <img src={m.user.picture} alt="" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover" /> : <span>{m.email.slice(0, 1).toUpperCase()}</span>}
                  </div>
                  <div class="meta">
                    <div class="t">
                      {m.user?.name || m.email} {m.user ? <span class="chip ok">signed in</span> : <span class="chip">not signed in yet</span>}
                    </div>
                    <div class="s">
                      {m.email} · added {new Date(m.addedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div class="actions">
                    <button class="btn sm danger" disabled={busy} data-club-remove onClick={() => void remove(m.email)}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        {club && club.plan.publishing && (
          <section class="card stack">
            <div class="small muted">Stream your club's meets: Publishing mode is open to you.</div>
            <a class="btn" href={href('/publishing')} style="align-self:flex-start">
              Open Publishing
            </a>
          </section>
        )}
      </div>
    </Page>
  );
}
