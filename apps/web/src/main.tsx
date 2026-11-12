import { effect } from '@preact/signals';
import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './app.tsx';
import { toast } from './lib/toast.ts';
import { activeMeetId } from './portals/meets/activeRoom.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/screens.css';

const root = document.getElementById('app')!;
root.innerHTML = '';
render(<App />, root);

// Service worker: offline shell + updates. A new version is checked for every minute and applied by
// itself the moment it is safe — never in the middle of a meet or a take (that would drop the singer
// mid-song); then it waits with a toast and reloads once they leave.
const busy = () => activeMeetId.value !== null || /\/studio\/sing\//.test(location.pathname) || /\/publishing\/show\//.test(location.pathname);
let updatePending = false;
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, r) {
    if (r) setInterval(() => void r.update().catch(() => undefined), 60_000);
  },
  onNeedRefresh() {
    updatePending = true;
    if (!busy()) {
      void updateSW(true);
      return;
    }
    toast('A new version of SingersVoice is ready — it loads when you leave the meet', 'info', 0, { label: 'Update now', onClick: () => void updateSW(true) });
  },
  onOfflineReady() {
    toast('Ready to work offline', 'ok');
  },
});
effect(() => {
  if (updatePending && activeMeetId.value === null && !busy()) void updateSW(true);
});

// Surface silent failures to the user instead of a frozen screen.
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  if (msg && !/AbortError|The play\(\) request/.test(msg)) toast(msg, 'error', 6000);
});
