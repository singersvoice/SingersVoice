export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A phone or tablet: the system share sheet is the natural way to pass a link on. */
const handheld = (): boolean =>
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);

/**
 * Pass a link on. On a phone or tablet: the share sheet, with the link alone (a share sheet given a
 * text as well pastes "link text" into whatever receives it). On a computer: the link goes to the
 * clipboard as it is — nothing appended — so it can be pasted anywhere.
 */
export async function shareOrCopy(title: string, text: string, url?: string): Promise<'shared' | 'copied' | 'failed'> {
  if (navigator.share && handheld()) {
    try {
      await navigator.share(url ? { title, url } : { title, text });
      return 'shared';
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return 'failed'; // the sheet was dismissed: nothing to copy
      /* no share target: fall through to the clipboard */
    }
  }
  try {
    await navigator.clipboard.writeText(url ?? text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
