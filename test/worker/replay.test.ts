import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../../src/worker/ring-buffer.js';
import { TerminalModeTracker } from '../../src/worker/terminal-modes.js';

test('byte replay stays ordered across wraparound and reports a lost cursor', () => {
  const ring = new RingBuffer(8);
  ring.write(Buffer.from('abcd'));
  ring.write(Buffer.from('éefgh'));
  assert.equal(ring.bytesWritten, 10);
  assert.equal(ring.readSince(0).reset, true);
  assert.deepEqual(ring.readSince(4).data, Buffer.from('éefgh'));
  assert.equal(ring.readSince(10).data.length, 0);
});
test('mode parsing survives chunk boundaries and resets alternate-screen state', () => {
  const modes = new TerminalModeTracker();
  modes.feed(Buffer.from('\x1b[?104'));
  modes.feed(Buffer.from('9h\x1b[?25l\x1b[?2004h'));
  assert.equal(modes.restore(), '\x1b[?1049h\x1b[?25l\x1b[?2004h');
  modes.feed(Buffer.from('\x1bc'));
  assert.equal(modes.restore(), '');
});
