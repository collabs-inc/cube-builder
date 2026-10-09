import { expect, test } from 'vitest';
import { isInstallationMachine } from './machine';

test('only the installation machine can dispatch workspace actions', () => {
  expect(isInstallationMachine('machine')).toBe(true);
  expect(isInstallationMachine('local')).toBe(false);
  expect(isInstallationMachine('cloud')).toBe(false);
  expect(isInstallationMachine('another-machine')).toBe(false);
  expect(isInstallationMachine(null)).toBe(false);
});
