import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/tutorial.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const tutorial = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const { LESSONS, currentLesson, freshTutorial, normalizeTutorial, recordLesson } = tutorial;

test('the guide has a complete, ordered first-dive path', () => {
  assert.equal(LESSONS[0].id, 'book');
  assert.equal(LESSONS.at(-1).id, 'upgrade');
  assert.equal(new Set(LESSONS.map((lesson) => lesson.id)).size, LESSONS.length);
  assert.ok(LESSONS.every((lesson) => lesson.title && lesson.body && lesson.action));
});

test('disabled tutorial does not record actions, while enabled progress advances once', () => {
  const disabled = freshTutorial();
  assert.deepEqual(recordLesson(disabled, 'bench'), disabled);
  const enabled = { ...disabled, enabled: true, chosen: true };
  const progressed = recordLesson(enabled, 'book');
  assert.deepEqual(progressed.completed, ['book']);
  assert.deepEqual(recordLesson(progressed, 'book'), progressed);
  assert.equal(currentLesson(progressed).id, 'bench');
});

test('stored progress is sanitized to known lessons and booleans', () => {
  const state = normalizeTutorial({ enabled: 1, chosen: true, completed: ['book', 'unknown', 'book'] });
  assert.deepEqual(state, { enabled: false, chosen: true, completed: ['book'] });
});
