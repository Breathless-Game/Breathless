import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Browsers cap live WebGL contexts (~16) and silently drop the oldest one past that.
// These panels need a DOM and three.js, so the guards are at the source level.
const read = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const aquarium = read('aquarium.ts');
const portrait = read('portrait.ts');

function body(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} exists`);
  return src.slice(start, src.indexOf('\n  }\n', start));
}

test('aquarium: the food preview renderer is created in one place, guarded, and kept across closes', () => {
  assert.equal(aquarium.match(/new THREE\.WebGLRenderer\(/g)?.length, 1, 'one renderer construction site');
  const make = body(aquarium, 'private makeFoodPreview(');
  assert.match(make, /if \(!this\.foodPreview\) \{[\s\S]*new THREE\.WebGLRenderer/, 'built only when none exists');
  assert.match(make, /isContextLost\(\)/, 'rebuilt only after a context loss');
  const close = body(aquarium, '  close() {');
  assert.doesNotMatch(close, /disposeFoodPreview\(true\)/, 'close() keeps the renderer for the next show()');
  const ctor = body(aquarium, '  constructor(');
  assert.match(ctor, /this\.renderFeederText\(\);\s*$/, 'no WebGL context before the first show(): text only');
  const feeder = body(aquarium, 'private renderFeeder(');
  assert.doesNotMatch(feeder, /addEventListener\('click'/, 'the click-to-pour listener is not stacked per selection');
  assert.match(make, /addEventListener\('click', \(\) => void this\.feedSchool\(\)\)/, 'the 3D food still pours on click');
});

test('aquarium: a renderer that is thrown away is force-lost first', () => {
  const dispose = body(aquarium, 'private disposeFoodPreview(');
  assert.match(dispose, /forceContextLoss\(\)[\s\S]*\.dispose\(\)/, 'forceContextLoss() before dispose()');
});

test('aquarium: the preview only renders while the tank is up', () => {
  const frame = body(aquarium, 'private frame(');
  const closedReturn = frame.indexOf("if (this.state === 'closed') return;");
  assert.ok(closedReturn >= 0 && closedReturn < frame.indexOf('foodPreview.renderer.render'), 'no offscreen renders');
});

test('portrait: never caches an icon drawn on a lost context, and rebuilds the renderer', () => {
  const icon = portrait.slice(portrait.indexOf('export function fishIcon('));
  assert.match(icon, /if \(!contextLost\(renderer\)\) iconCache\.set/, 'cache only a good render');
  assert.match(portrait, /isContextLost\(\)/, 'checks the context');
  assert.match(portrait, /webglcontextlost[\s\S]{0,40}iconCache\.clear\(\)/, 'forgets icons cached around a loss');
  const get = portrait.slice(portrait.indexOf('function getRenderer('));
  assert.match(get, /if \(contextLost\(renderer\)\) dropRenderer\(\)/, 'lost renderer is replaced');
});

test('tables and the held health report make their WebGL context on first use, not at startup', () => {
  const table = read('table-scene.ts');
  const ctor = body(table, '  constructor(');
  assert.doesNotMatch(ctor, /WebGLRenderer|this\.renderer/, 'no context in the TableScene constructor');
  assert.match(table, /protected get renderer\(\)[\s\S]*if \(!this\.gl\) \{[\s\S]*new THREE\.WebGLRenderer/, 'made once, on first use');
  const desk = read('health-desk.ts');
  assert.equal(desk.match(/new THREE\.WebGLRenderer\(/g)?.length, 1, 'one held renderer site');
  assert.doesNotMatch(body(desk, '  constructor('), /WebGLRenderer|heldGl\(\)/, 'not made with the desk');
  assert.match(body(desk, 'private heldGl('), /if \(!this\.heldRenderer\) \{[\s\S]*new THREE\.WebGLRenderer/, 'made once');
});
