import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateControlRequest } from '../../src/server/request-policy.js';

test('loopback control requests require the exact browser origin', () => {
  for (const host of ['127.0.0.1:3500', 'localhost:3500', '[::1]:3500']) {
    assert.equal(validateControlRequest({ host, origin: `http://${host}` }), true);
    for (const origin of [undefined, 'null', 'https://evil.test', `http://${host}/path`, 'http://localhost:3501']) {
      assert.equal(validateControlRequest({ host, origin }), false, `${host} / ${origin}`);
    }
  }
});

test('proxy use accepts exact HTTPS origins without depending on a vendor domain', () => {
  const host = 'builder.example.test';
  assert.equal(validateControlRequest({ host, origin: `https://${host}`, 'x-forwarded-proto': 'https' }), true);
  assert.equal(validateControlRequest({ host, origin: `https://${host}` }), false);
  assert.equal(validateControlRequest({ host, origin: `http://${host}`, 'x-forwarded-proto': 'https' }), false);
  assert.equal(validateControlRequest({ host, origin: `http://${host}` }), false);
  assert.equal(validateControlRequest({ host, origin: 'https://other.example.test', 'x-forwarded-proto': 'https' }), false);
});

test('malformed and ambiguous headers do not grant control access', () => {
  for (const host of ['', 'localhost/path', 'user@localhost', 'localhost:abc', 'localhost,evil.test', 'localhost#x']) {
    assert.equal(validateControlRequest({ host, origin: `http://${host}` }), false, host);
  }
  assert.equal(validateControlRequest({ host: 'localhost', origin: ['http://localhost'] }), false);
});
