// The site's hardening headers, in one place: Cloudflare Pages sends them (_headers, written by postbuild.mjs) and
// `vite preview` sends the same (vite.config.ts), so every browser test runs under the policy the site has.
// GitHub Pages sends no headers of ours (docs/HOSTING.md — one more reason to move).
//
// The Content-Security-Policy: scripts from the site itself, Google's sign-in and Picker loaders and the MediaPipe
// CDN (the segmentation runtime, when the site's own copy is missing), WebAssembly allowed (the segmenter) and
// 'unsafe-eval' with it — MediaPipe's Emscripten runtime evaluates strings and runs nowhere without it (the one
// softening of the policy: no inline script runs, and no script from anywhere but these origins); workers
// from the site and blob: (the feed worker); connections to https anywhere (sv-control's address is the
// deployment's, Drive, YouTube's thumbnails) and blob:/data: (files the app makes); pictures and media the same;
// styles inline (the app styles elements in place) and Google's; frames from Google alone (sign-in, Picker); no
// plugins, no base changes, no forms to anywhere else, never framed.
const SITE_SCRIPTS = ['https://accounts.google.com', 'https://apis.google.com', 'https://www.gstatic.com', 'https://cdn.jsdelivr.net'];
const SITE_FRAMES = ['https://accounts.google.com', 'https://content.googleapis.com', 'https://docs.google.com', 'https://drive.google.com'];

/** `local` adds the local addresses the browser tests talk to (sv-control and the fakes on localhost). */
export function contentSecurityPolicy({ local = false } = {}) {
  const connect = ["'self'", 'https:', 'blob:', 'data:', ...(local ? ['http://localhost:*', 'http://127.0.0.1:*', 'ws://localhost:*'] : [])];
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' ${SITE_SCRIPTS.join(' ')}`,
    "worker-src 'self' blob:",
    `connect-src ${connect.join(' ')}`,
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: data: https:",
    "style-src 'self' 'unsafe-inline' https://accounts.google.com",
    "font-src 'self' data:",
    `frame-src ${SITE_FRAMES.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Every page: the policy and the rest of the hardening set. */
export function siteHeaders({ local = false } = {}) {
  return {
    'Content-Security-Policy': contentSecurityPolicy({ local }),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  };
}
