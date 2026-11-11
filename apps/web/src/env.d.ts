/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Google OAuth Web client ID (…apps.googleusercontent.com). Empty → Local mode only. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Optional API key to enable the Google Picker (import tracks shared with you). */
  readonly VITE_GOOGLE_API_KEY?: string;
  /** Optional sv-control base URL (wss://…) for live meets. */
  readonly VITE_CONTROL_URL?: string;
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
