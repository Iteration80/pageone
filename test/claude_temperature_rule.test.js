const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { claudeRejectsTemperature } = require('../agents/ai-client');

// Opus 4.7+ and the whole Claude 5 family return 400 on `temperature`. This used to be
// an exact-id list, which is a trap in a project where an admin can add a Claude
// model from the Settings form without a deploy: the first request on the new id
// would carry `temperature` and be rejected, with nothing in the add form able to
// warn. Guard breaks: pattern removed → the "unlisted future id" cases fail · a
// 5-family row added to the bundle without the rule matching → the registry sweep
// fails · Haiku/4.6 wrongly matched → the accepts-temperature cases fail.

test('the rule covers the listed ids AND unlisted ids of the same families', () => {
    for (const id of [
        'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
        'claude-fable-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-mythos-5-1',
        'claude-opus-5-6', 'claude-sonnet-5-1', 'claude-opus-4-9' // not yet registered anywhere
    ]) {
        assert.equal(claudeRejectsTemperature(id), true, `${id} must not be sent a temperature`);
    }
});

test('models that still accept temperature are left alone', () => {
    for (const id of ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6', 'gemini-3.6-flash', 'kimi-k3', '', undefined]) {
        assert.equal(claudeRejectsTemperature(id), false, `${id} still accepts temperature`);
    }
});

test('every enabled Anthropic row in the bundled registry is classified deliberately', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'models.json'), 'utf8'));
    const ACCEPTS_TEMPERATURE = new Set(['claude-haiku-4-5-20251001']);
    for (const row of registry.models.filter(m => m.enabled && m.provider === 'anthropic')) {
        const expected = !ACCEPTS_TEMPERATURE.has(row.id);
        assert.equal(claudeRejectsTemperature(row.id), expected,
            `${row.id}: registry row is enabled but the temperature rule says ${claudeRejectsTemperature(row.id)} — add it to the rule or to ACCEPTS_TEMPERATURE here, on evidence`);
    }
    const opus55 = registry.models.find(m => m.id === 'claude-opus-5-5');
    assert.ok(opus55?.enabled, 'Claude Opus 5.5 is in the bundle and enabled');
    assert.deepEqual([opus55.pricing.inputPerMTok, opus55.pricing.outputPerMTok], [4, 20]);
    const sonnet5 = registry.models.find(m => m.id === 'claude-sonnet-5');
    assert.deepEqual([sonnet5.pricing.inputPerMTok, sonnet5.pricing.outputPerMTok], [2, 10], 'the $2/$10 launch price became standard (pricing page, 2026-09-25)');
});
