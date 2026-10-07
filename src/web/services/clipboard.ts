/** Keep denied clipboard writes recoverable without blocking terminal output. */
export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch {}
  document.querySelector('[data-builder-clipboard]')?.remove();
  const dialog = document.createElement('dialog'); dialog.dataset.builderClipboard = ''; dialog.setAttribute('aria-label', 'Copy terminal text');
  const label = document.createElement('p'); label.textContent = 'Clipboard access was denied. Select and copy this text.';
  const field = document.createElement('textarea'); field.value = text; field.readOnly = true; field.setAttribute('aria-label', 'Text to copy');
  const close = document.createElement('button'); close.textContent = 'Done'; close.onclick = () => dialog.close();
  dialog.append(label, field, close); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal(); field.focus(); field.select();
}
