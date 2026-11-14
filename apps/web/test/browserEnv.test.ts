import { describe, expect, it } from 'vitest';
import { inAppBrowser, openInBrowserUrl } from '../src/lib/browserEnv.ts';

const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0 Mobile/15E148 Safari/604.1';
const WEBVIEW_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const GMAIL_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 GSA/320.0';
const WHATSAPP_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36 WhatsApp/2.24';
const WEBVIEW_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

describe('in-app browsers', () => {
  it('knows a real browser from an app’s web view, where Google sign-in cannot open', () => {
    expect(inAppBrowser(SAFARI_IOS)).toBeNull();
    expect(inAppBrowser(CHROME_IOS)).toBeNull();
    expect(inAppBrowser(CHROME_ANDROID)).toBeNull();
    expect(inAppBrowser(DESKTOP)).toBeNull();
    expect(inAppBrowser(WEBVIEW_IOS)).toBe('this app');
    expect(inAppBrowser(GMAIL_IOS)).toBe('the Google app');
    expect(inAppBrowser(WHATSAPP_ANDROID)).toBe('WhatsApp');
    expect(inAppBrowser(WEBVIEW_ANDROID)).toBe('this app');
    expect(inAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0')).toBe('Instagram');
  });
  it('builds the link that opens the real browser: Safari on iOS, Chrome on Android, nothing on a desktop', () => {
    const url = 'https://singersvoice.github.io/SingersVoice/meet/abc?x=1';
    expect(openInBrowserUrl(url, WEBVIEW_IOS)).toBe('x-safari-https://singersvoice.github.io/SingersVoice/meet/abc?x=1');
    expect(openInBrowserUrl(url, WEBVIEW_ANDROID)).toBe(`intent://singersvoice.github.io/SingersVoice/meet/abc?x=1#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`);
    expect(openInBrowserUrl(url, DESKTOP)).toBeNull();
  });
});
