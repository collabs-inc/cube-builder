import { test, expect, vi } from 'vitest';
import { copyText } from '../../src/web/services/clipboard';
test('denied clipboard writes provide selected text and an explicit dismissal', async () => {
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
  await copyText('retain this text');
  const textarea = document.querySelector('textarea')!;
  expect(textarea.value).toBe('retain this text'); expect(textarea.selectionStart).toBe(0); expect(textarea.selectionEnd).toBe(16);
  document.querySelector<HTMLButtonElement>('dialog button')!.click();
  expect(document.querySelector('dialog')).toBeNull(); write.mockRestore();
});
