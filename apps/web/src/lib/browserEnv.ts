/**
 * Where the app is running. A link to SingersVoice opened from a message, a mail or a social app
 * often lands in that app's built-in browser (a web view), where Google sign-in cannot work: the
 * sign-in window is blocked, and Google refuses to show its sign-in page inside embedded web views
 * at all ("disallowed_useragent"). The cure is to open the same link in the real browser; this
 * module recognises the situation and builds the link that does it.
 */

/** The app whose built-in browser we are in, or null in a real browser (Safari, Chrome, Firefox, Edge, Samsung, an installed PWA). */
export function inAppBrowser(ua: string = navigator.userAgent): string | null {
  const named: [RegExp, string][] = [
    [/FBAN|FBAV|FB_IAB/i, 'Facebook'],
    [/Messenger/i, 'Messenger'],
    [/Instagram/i, 'Instagram'],
    [/WhatsApp/i, 'WhatsApp'],
    [/\bLine\//i, 'LINE'],
    [/MicroMessenger/i, 'WeChat'],
    [/Snapchat/i, 'Snapchat'],
    [/LinkedInApp/i, 'LinkedIn'],
    [/TeamsMobile|Teams\//i, 'Teams'],
    [/\bGSA\//i, 'the Google app'],
    [/Twitter|TwitterAndroid/i, 'X'],
    [/TikTok|Musical_ly|BytedanceWebview/i, 'TikTok'],
    [/\bPinterest\b/i, 'Pinterest'],
    [/Telegram/i, 'Telegram'],
  ];
  for (const [re, name] of named) if (re.test(ua)) return name;
  // Android: a WebView says so; iOS: a web view has no "Safari/" token (Safari, Chrome, Firefox and Edge on iOS all carry one).
  if (/Android/i.test(ua) && /\bwv\b/.test(ua)) return 'this app';
  if (/iPhone|iPad|iPod/i.test(ua) && !/Safari\//i.test(ua)) return 'this app';
  return null;
}

/**
 * A link that opens `url` in the device's real browser from inside a web view: Safari on iOS
 * (the x-safari scheme, iOS 17+), Chrome on Android (an intent with the plain link as fallback).
 * Null when there is no such trick for this device — the page then explains the menu way.
 */
export function openInBrowserUrl(url: string, ua: string = navigator.userAgent): string | null {
  if (/iPhone|iPad|iPod/i.test(ua)) return url.replace(/^https:\/\//, 'x-safari-https://');
  if (/Android/i.test(ua)) {
    const u = new URL(url);
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
  }
  return null;
}
