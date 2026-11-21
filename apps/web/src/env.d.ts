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
  /**
   * Where the app now lives (`https://www.singersvoice.com`), set on a build published at an old address: a visitor of that
   * address is sent to the same page there. Empty → no redirect. docs/HOSTING.md.
   */
  readonly VITE_CANONICAL_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
