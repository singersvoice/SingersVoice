import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './app.tsx';
import { toast } from './lib/toast.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/screens.css';

const root = document.getElementById('app')!;
root.innerHTML = '';
render(<App />, root);

// Service worker: offline shell + "update ready" prompt.
const updateSW = registerSW({
  onNeedRefresh() {
    toast('A new version of SingersVoice is ready', 'info', 0, { label: 'Update', onClick: () => void updateSW(true) });
  },
  onOfflineReady() {
    toast('Ready to work offline', 'ok');
  },
});

// Surface silent failures to the user instead of a frozen screen.
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  if (msg && !/AbortError|The play\(\) request/.test(msg)) toast(msg, 'error', 6000);
});
