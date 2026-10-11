import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { sweepDead, watchAlive } from '../heartbeat.mjs';

function socket() {
  const ws = new EventEmitter();
  ws.pings = 0;
  ws.terminated = false;
  ws.ping = () => ws.pings++;
  ws.terminate = () => {
    ws.terminated = true;
  };
  watchAlive(ws);
  return ws;
}

test('a socket that answers pings is kept', () => {
  const ws = socket();
  for (let i = 0; i < 5; i++) {
    assert.equal(sweepDead([ws]), 0);
    ws.emit('pong');
  }
  assert.equal(ws.terminated, false);
  assert.equal(ws.pings, 5);
});

test('a silent (half-open) socket is terminated on the second sweep, freeing its slot', () => {
  const ws = socket();
  assert.equal(sweepDead([ws]), 0, 'first sweep only pings');
  assert.equal(ws.terminated, false);
  assert.equal(sweepDead([ws]), 1, 'no pong since: dropped');
  assert.equal(ws.terminated, true);
});

test('any message counts as alive, so a busy uplink is never dropped', () => {
  const ws = socket();
  sweepDead([ws]);
  ws.emit('message', Buffer.alloc(4), true);
  assert.equal(sweepDead([ws]), 0);
  assert.equal(ws.terminated, false);
});

test('only the dead socket goes', () => {
  const live = socket();
  const dead = socket();
  sweepDead([live, dead]);
  live.emit('pong');
  assert.equal(sweepDead([live, dead]), 1);
  assert.deepEqual([live.terminated, dead.terminated], [false, true]);
});
