import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSessions } from '../../src/worker/sessions.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(20); } throw new Error('Timed out waiting for PTY'); }

test('a real PTY keeps identity, modes and bounded byte replay through reattachment', async () => {
  const sessions = new TerminalSessions();
  try {
    const input = { requestId: 'same-request', cwd: '/tmp', command: '/bin/sh', args: ['-c', 'printf "\\033[?1049hREADY"; read answer; printf "REPLY:%s" "$answer"; read rest'], cols: 80, rows: 24 };
    const one = sessions.spawn(input);
    assert.equal(sessions.spawn(input).id, one.id);
    await until(() => Buffer.from(sessions.read(one.id, { since: 0 }).data, 'base64').toString().includes('READY'));
    sessions.resize(one.id, 100, 35);
    sessions.write(one.id, Buffer.from('hello\n').toString('base64'));
    await until(() => Buffer.from(sessions.read(one.id, { since: 0 }).data, 'base64').toString().includes('REPLY:hello'));
    const tail = sessions.read(one.id, { since: 0, maxBytes: 5 });
    assert.equal(tail.reset, true);
    assert.ok(Buffer.from(tail.data, 'base64').length <= 5);
    assert.equal(tail.modes, '\x1b[?1049h');
    assert.equal(sessions.list().length, 1);
    assert.equal(sessions.list()[0]!.pid, one.pid);
    sessions.kill(one.id);
    await until(() => sessions.list()[0]!.exited);
    assert.equal(sessions.read(one.id, { since: tail.seq }).exited, true);
  } finally { await sessions.close(); }
});

test('terminal resize reaches the child and completed commands retain exit status', async () => {
  const sessions = new TerminalSessions();
  try {
    const term = sessions.spawn({ requestId: 'size', cwd: '/tmp', command: '/bin/sh', args: ['-c', 'read x; stty size; exit 7'], cols: 80, rows: 24 });
    sessions.resize(term.id, 101, 37);
    sessions.write(term.id, Buffer.from('\n').toString('base64'));
    await until(() => sessions.list()[0]!.exited);
    const result = sessions.read(term.id, { since: 0 });
    assert.match(Buffer.from(result.data, 'base64').toString(), /37 101/);
    assert.equal(result.exitCode, 7);
  } finally { await sessions.close(); }
});

test('invalid operations cannot silently create or write sessions', async () => {
  const sessions = new TerminalSessions();
  try {
    assert.throws(() => sessions.spawn({ requestId: 'bad', cwd: '/no-such-builder-directory', command: '/bin/sh', args: [], cols: 80, rows: 24 }));
    assert.throws(() => sessions.write('missing', 'eA=='));
    assert.throws(() => sessions.spawn({ requestId: 'bad-size', cwd: '/tmp', command: '/bin/sh', args: [], cols: 0, rows: 24 }));
  } finally { await sessions.close(); }
});

test('exit retains absolute byte cursors after compacting a large output tail', async () => {
  const sessions = new TerminalSessions();
  try {
    const term = sessions.spawn({ requestId: 'large', cwd: '/tmp', command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(400000));setTimeout(()=>process.exit(3),50)'], cols: 80, rows: 24 });
    await until(() => sessions.list()[0]!.exited);
    const result = sessions.read(term.id, { since: 399990 });
    assert.equal(result.seq, 400000);
    assert.equal(result.reset, false);
    assert.equal(Buffer.from(result.data, 'base64').toString(), 'xxxxxxxxxx');
  } finally { await sessions.close(); }
});
