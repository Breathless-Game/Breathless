import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Aquarium needs a DOM and three.js, so this guards feedSchool() at the source level.
const src = readFileSync(new URL('../src/aquarium.ts', import.meta.url), 'utf8');

function method(name) {
  const start = src.indexOf(`private ${name}(`);
  assert.ok(start > 0, `${name}() exists`);
  return src.slice(start, src.indexOf('\n  }\n', start));
}

test('aquarium: Pour button renders the in-flight lock and affordability', () => {
  const body = method('renderFeederButton');
  assert.match(body, /this\.hooks\.pearls\(\)/, 'affordability comes from on-chain PEARL');
  assert.match(body, /feederButton\.disabled\s*=[^;]*this\.feeding/, 'disabled while a payment is in flight');
  assert.match(body, /feederButton\.disabled\s*=[^;]*affordable/, 'disabled when PEARL is short');
});

test('aquarium: school feeding pays once via buyFood and never leaves the Pour button locked', () => {
  const body = method('async feedSchool');
  const lock = body.indexOf('this.feeding = true');
  const guard = body.indexOf('if (this.feeding) return');
  const pay = body.indexOf('await this.hooks.buyFood(food)');
  assert.ok(guard >= 0 && guard < lock, 'a second click while paying is ignored');
  assert.ok(lock > 0 && pay > lock, 'locked before paying');
  assert.match(body.slice(pay), /if \(!paid\) return;/, 'a null payment applies nothing');
  // The unlock + re-render live in finally, so success, null and a throw all release the button.
  const fin = body.indexOf('finally {', pay);
  assert.ok(fin > pay, 'payment is wrapped in try/finally');
  const tail = body.slice(fin);
  const unlock = tail.indexOf('this.feeding = false');
  const rerender = tail.indexOf('this.renderFeederButton()');
  assert.ok(unlock > 0 && rerender > unlock, 'feeding is cleared before the Pour button is re-rendered');
  // Nothing between paying and finally may re-render the feeder while the lock is still held.
  assert.ok(!/renderFeeder(Button|Text)?\(\)/.test(body.slice(pay, fin)), 'no feeder re-render while locked');
});
