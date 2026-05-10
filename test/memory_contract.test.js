const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildMemorySourceContract,
    buildMemorySourcePromptBlock,
    buildMemorySourceSystemInstruction
} = require('../agents/memory_contract');

test('memory source contract defines precedence for source-aware agents', () => {
    const contract = buildMemorySourceContract('Stage 8 Draft Scene');

    assert.match(contract, /Stage 8 Draft Scene/);
    assert.match(contract, /Current user notes\/request/);
    assert.match(contract, /Accepted divergences/);
    assert.match(contract, /Approved stage handoffs/);
    assert.match(contract, /Source bible and source references/);
    assert.match(contract, /compact memory snapshots/);
    assert.match(contract, /style references as tone, rhythm, voice, and texture guidance only/);
});

test('memory source prompt block wraps project knowledge without inventing content', () => {
    const packet = '### Compact Memory Snapshot\nMara keeps the blue key.';
    const block = buildMemorySourcePromptBlock(packet, 'Stage 10 Rewrite');

    assert.match(block, /PROJECT MEMORY AND SOURCE PACKET/);
    assert.match(block, /MEMORY AND SOURCE CONTRACT/);
    assert.match(block, /Stage 10 Rewrite/);
    assert.match(block, /Mara keeps the blue key/);
    assert.equal(buildMemorySourcePromptBlock('', 'Stage 10 Rewrite'), '');
});

test('memory source system instruction appends contract to existing SOP', () => {
    const systemInstruction = buildMemorySourceSystemInstruction('Base SOP', 'Stage 5 Treatment');

    assert.ok(systemInstruction.startsWith('Base SOP'));
    assert.match(systemInstruction, /MEMORY AND SOURCE CONTRACT/);
    assert.match(systemInstruction, /Stage 5 Treatment/);
});
