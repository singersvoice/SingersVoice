/**
 * The browser's word on the camera or the microphone, where it gives one (lib/permissions.ts): allowed — nothing
 * will be asked; not yet asked — the first stage asks once; blocked — the way back, in this browser's own words,
 * because no page can unblock itself. Settings → Audio and Settings → Camera carry one each.
 */
import { useEffect } from 'preact/hooks';
import { checkMediaPermissions, mediaPermissions, permissionHelp } from '../lib/permissions.ts';
import { isIOS, isStandalone } from '../lib/platform.ts';

export function PermissionLine(props: { what: 'camera' | 'microphone' }) {
  useEffect(() => void checkMediaPermissions(), []);
  const p = mediaPermissions.value[props.what];
  const name = props.what === 'camera' ? 'camera' : 'microphone';
  const word =
    p === 'granted'
      ? `Allowed in this browser — it will not ask again${isIOS && !isStandalone ? ' (Safari on iPhone asks once per visit unless SingersVoice is added to the Home Screen, or its Website Settings say Allow)' : ''}.`
      : p === 'denied'
        ? `Blocked in this browser. ${permissionHelp(props.what)}`
        : p === 'prompt'
          ? 'Not asked yet: the first stage asks once, and the browser remembers.'
          : isIOS
            ? 'Safari asks once per visit, for the camera and the microphone together; added to the Home Screen, SingersVoice is asked once and remembers.'
            : 'This browser keeps the answer itself once it has been given.';
  return (
    <div class={`small ${p === 'denied' ? 'callout warn' : 'muted'}`} data-permission={props.what} data-permission-state={p}>
      <b style="text-transform:capitalize">{name}</b>: {word}
    </div>
  );
}
