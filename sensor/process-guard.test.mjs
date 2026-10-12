import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRejection } from './process-guard.mjs';

test('describeRejection: an RPC error is one quiet line; a TypeError is flagged as a bug', () => {
  const rpc = describeRejection(new Error('429 Too Many Requests:  {"jsonrpc":"2.0"}\n    at ClientBrowser.callServer'));
  assert.equal(rpc.bug, false);
  assert.ok(rpc.line.startsWith('Error: 429 Too Many Requests'));
  assert.ok(!rpc.line.includes('\n'));

  const bug = describeRejection(new TypeError("Cannot read properties of undefined (reading 'owner')"));
  assert.equal(bug.bug, true);
  assert.match(bug.stack, /TypeError/);

  assert.deepEqual(describeRejection('plain string'), { bug: false, line: 'string: plain string', stack: null });
  assert.equal(describeRejection(undefined).bug, false);
});
