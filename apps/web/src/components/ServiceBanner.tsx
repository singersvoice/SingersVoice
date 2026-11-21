/**
 * One line about the service when something is wrong with it, said as it is (lib/api.ts tells the cases apart):
 * no answer at all (the network, or the service down — "retrying"), a failure the service answered with, or its
 * storage allowance spent for the day (nothing can be saved until 00:00 UTC — the time in the singer's own clock).
 * Nothing at all while everything is fine.
 */
import { controlStatus, serviceNotice } from '../lib/api.ts';

export function ServiceBanner(props: { /** What this screen is about, for the words ("Live meets", "the room"). */ what?: string }) {
  const notice = serviceNotice.value;
  if (notice?.kind === 'storage_limit') {
    const until = notice.until ? new Date(notice.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
    return (
      <div class="callout danger" data-service="storage_limit">
        {notice.message}
        {until ? ` That is ${until} your time.` : ''} {props.what ? `${props.what} will not run until then.` : ''}
      </div>
    );
  }
  if (controlStatus.value === 'offline') {
    return (
      <div class="callout danger" data-service="offline">
        No answer from the SingersVoice service — your connection, or the service, is down right now. Trying again in the background.
      </div>
    );
  }
  if (notice?.kind === 'failing') {
    return (
      <div class="callout warn" data-service="failing">
        The SingersVoice service answered with a failure: {notice.message} — trying again.
      </div>
    );
  }
  return null;
}
