import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const memory=new Map();
globalThis.localStorage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)};
const source=await readFile(new URL('../src/skin-access.ts',import.meta.url),'utf8');
const wallet='data:text/javascript;base64,'+Buffer.from('export const storageKey=k=>k;').toString('base64');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText.replace("'./wallet'",JSON.stringify(wallet));
const access=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
test('locked skins have two independent trials, then require unlocking',()=>{
 assert.equal(access.skinUnlocked(0),true);assert.equal(access.skinUnlocked(1),false);assert.equal(access.skinUnlocked(2),false);
 assert.equal(access.useSkinTrial(1),true);assert.equal(access.useSkinTrial(1),true);assert.equal(access.useSkinTrial(1),false);
 assert.equal(access.skinTrials(2),2);
 access.visitSkinMap('tianchi');assert.equal(access.skinUnlocked(1),true);assert.equal(access.skinUnlocked(2),false);
 assert.equal(access.useSkinTrial(1),true);
 access.visitSkinMap('ocean');assert.equal(access.skinUnlocked(2),true);
 access.visitSkinMap('fjord');assert.equal(access.skinUnlocked(2),true);
});
