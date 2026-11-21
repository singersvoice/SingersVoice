/**
 * The Blocked screen: an account a super admin blocked for good sees this in place of every page (app.tsx
 * Guard) — the service refuses it everything but its own standing, on every request.
 */
import { useEffect } from 'preact/hooks';
import { Logo } from '../components/Shell.tsx';
import { controlConfigured, refreshAccount } from '../lib/api.ts';
import { account, profile, signOut } from '../state/session.ts';

export function Blocked() {
  useEffect(() => {
    if (controlConfigured.value) void refreshAccount(); // let back in a moment ago: the notice goes by itself
  }, []);
  const p = profile.value;
  const a = account.value;
  return (
    <div class="welcome" data-blocked-screen>
      <div class="hero" style="align-content:start;text-align:left;justify-items:stretch">
        <Logo />
        <h1>This account is blocked</h1>
        <p class="muted">
          SingersVoice is closed to this account{p?.email ? ` (${p.email})` : ''}{a?.svNo ? `, SV-${a.svNo}` : ''}: a SingersVoice admin blocked it for good. If you think this is a mistake, write to the admin and quote your number.
        </p>
        <button class="btn" style="align-self:flex-start" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
