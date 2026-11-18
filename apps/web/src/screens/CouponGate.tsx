/**
 * The Coupon screen — the first thing after sign-in while the coupon gate is on and the account is not in
 * (coupons.ts): one box for the code the SingersVoice admin gave, one Continue button, and the reason in
 * words when the service says no (no coupon issued for this address, the wrong one, expired). The service
 * decides on every request: a coupon the admin changed or withdrew brings this screen back by itself.
 */
import { displayCode } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Logo } from '../components/Shell.tsx';
import { Spinner } from '../components/ui.tsx';
import { api, controlConfigured, refreshAccount } from '../lib/api.ts';
import { errorText } from '../lib/toast.ts';
import { access, profile, setAccess, signOut } from '../state/session.ts';

export function CouponGate() {
  const a = access.value;
  const [code, setCode] = useState(a?.entered ? displayCode(a.entered) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (controlConfigured.value) void refreshAccount(); // the gate as it stands now (a coupon issued a moment ago lets the account in)
  }, []);

  const submit = async () => {
    const c = code.trim();
    if (!c || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post('POST /coupon', '/coupon', { code: c });
      setAccess(user.access);
      if (!user.access.ok) setError(user.access.note || 'That coupon does not open SingersVoice');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const standing = a?.standing ?? 'missing';
  const p = profile.value;
  return (
    <div class="welcome" data-coupon-gate data-coupon-standing={standing}>
      <div class="hero" style="align-content:start;text-align:left;justify-items:stretch">
        <Logo />
        <h1>Your coupon</h1>
        <p class="muted">SingersVoice is open by invitation: the SingersVoice admin gives each singer a coupon with an expiry date. Enter yours to come in{p?.email ? ` (signed in as ${p.email})` : ''}.</p>
        {standing === 'none' && <div class="callout warn" data-coupon-note>{a?.note || 'No coupon is issued for your account — ask the SingersVoice admin for one.'}</div>}
        {standing === 'expired' && <div class="callout warn" data-coupon-note>{a?.note || 'Your coupon expired — ask the SingersVoice admin for a new one.'}</div>}
        {standing === 'wrong' && !error && <div class="callout warn" data-coupon-note>{a?.note || 'That is not the coupon issued for your account.'}</div>}
        <form
          class="stack"
          style="gap:10px"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input class="input mono" style="font-size:1.2em;letter-spacing:0.08em;text-transform:uppercase" placeholder="SV-XXXXXXXX" value={code} autoComplete="off" autoCapitalize="characters" spellcheck={false} data-coupon-code onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)} />
          <button class="btn primary lg block" type="submit" disabled={busy || !code.trim()} data-coupon-submit>
            {busy ? <Spinner /> : null} Continue
          </button>
          {error && <div class="callout warn" data-coupon-error>{error}</div>}
        </form>
        <p class="small faint">A coupon is for the Google account it was issued to, until its date. If yours stopped working, the admin may have changed or withdrawn it — ask them.</p>
        <button class="btn" style="align-self:flex-start" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
