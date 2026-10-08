import { test, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
vi.mock('../../src/web/services/http', () => ({ services: { subscribe(callback: (e: unknown) => void, status: (value: boolean) => void) { callback({ type: 'snapshot', snapshot: { epoch: 'test', revision: 1, repos: [{ id: 'repo', root: '/repo', name: 'My project', worktrees: [] }], items: [], capabilities: { home: '/home/test', platform: 'linux' } } }); status(true); return () => {}; } } }));
test('renders a machine-local workspace without a host preload or parent integration', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const { default: App } = await import('../../src/web/App');
  render(<App />);
  expect(screen.getByText('My project')).toBeTruthy();
  expect(screen.getByText('Connected')).toBeTruthy();
  expect('api' in window).toBe(false);
  cleanup(); vi.unstubAllGlobals();
});
