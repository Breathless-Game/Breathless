import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const load = async (file) => {
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
};
const { coreAsset } = await load('explorer-links.ts');
const { nftName } = await load('nft-uri.ts');

test('coreAsset links the Metaplex Core explorer on devnet', () => {
  assert.equal(
    coreAsset('5cz8aSoUpEg1tqMxJBChujrmBE5hEiL4twqW7fx2oD41'),
    'https://core.metaplex.com/explorer/5cz8aSoUpEg1tqMxJBChujrmBE5hEiL4twqW7fx2oD41?env=devnet',
  );
  assert.equal(coreAsset('a/b?c'), 'https://core.metaplex.com/explorer/a%2Fb%3Fc?env=devnet');
});

test('the Aquarium label (nftName) carries the serial like the NFT; unminted keeps its name', () => {
  assert.equal(nftName({ name: 'Glimmering Azure Tang', serial: 16 }), 'Glimmering Azure Tang #0016');
  assert.equal(nftName({ name: 'Lively Coral Chromis' }), 'Lively Coral Chromis');
});
