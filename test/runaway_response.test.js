const { test } = require('node:test');
const assert = require('node:assert');

const { closeTruncatedJson, parseJsonWithRepair } = require('../agents/json_parse');
const { normalizeCurrentCharacters } = require('../agents/agent_3_characters');

// The "deterministic gemini-3.1-pro truncation" recorded on 2026-07-30 and blamed on
// response size is not a size problem. Measured 2026-08-03 by dumping the raw output:
// asked to revise ONE character, pro emitted that same character 93 times — 131KB —
// until it hit maxOutputTokens and died mid-string as "Unterminated string in JSON",
// at a consistent offset because the loop is consistent. The elements before the cut
// are complete and correct, so failing the whole revision threw away a good answer.

const character = (name, truth) => ({
    name,
    role: 'Enforcer',
    profile_tier: 'Tier 2',
    brief_summary: 'A deputy.',
    functional_profile: { narrative_function: 'Obstacle.', emotional_truth: truth }
});

/** A response that repeats one character N times and is then cut off mid-string. */
function runawayResponse(copies, truth) {
    const body = Array.from({ length: copies }, () => JSON.stringify(character('Deputy Ray', truth))).join(',');
    return `{"characters":[${body},{"name":"Deputy Ray","role":"Enfor`;
}

test('a runaway response is salvaged instead of failing the revision', () => {
    const raw = runawayResponse(12, 'He is protecting his own place in it.');
    assert.throws(() => JSON.parse(raw), 'precondition: the raw response must be unparseable');

    const parsed = parseJsonWithRepair(raw, { label: 'runaway' });
    assert.equal(parsed.characters.length, 12);
    assert.equal(parsed.characters[0].functional_profile.emotional_truth, 'He is protecting his own place in it.');
});

test('the salvaged cast collapses to one of each character', () => {
    // Salvage keeps every complete element; deduping is what stops 93 copies of one
    // character reaching the writer's cast.
    const parsed = parseJsonWithRepair(runawayResponse(93, 'x'), { label: 'runaway' });
    assert.equal(parsed.characters.length, 93);

    const cast = normalizeCurrentCharacters(parsed);
    assert.equal(cast.length, 1);
    assert.equal(cast[0].name, 'Deputy Ray');
});

test('dedupe is by name, case- and whitespace-insensitive, and keeps the first', () => {
    const cast = normalizeCurrentCharacters([
        character('Nora Vance', 'first'),
        character('  nora vance  ', 'second'),
        character('Deputy Ray', 'ray')
    ]);
    assert.deepEqual(cast.map(c => c.name), ['Nora Vance', 'Deputy Ray']);
    assert.equal(cast[0].functional_profile.emotional_truth, 'first');
});

test('unnamed entries are never deduped against each other', () => {
    // Two blank names are not evidence of the same character, and merging them would
    // silently delete a character the model actually returned.
    const cast = normalizeCurrentCharacters([character('', 'a'), character('', 'b')]);
    assert.equal(cast.length, 2);
});

test('closeTruncatedJson leaves well-formed JSON exactly as it found it', () => {
    for (const text of ['{"a":1}', '[]', '[{"a":[1,2]},{"b":"}"}]', '{"s":"a } ] string"}']) {
        assert.equal(closeTruncatedJson(text), text);
    }
});

test('closeTruncatedJson rewinds past a cut that lands inside a string', () => {
    // B never closed, so B is dropped entirely rather than half-recovered.
    const cut = '{"characters":[{"name":"A"},{"name":"B roken';
    const parsed = JSON.parse(closeTruncatedJson(cut));
    assert.deepEqual(parsed, { characters: [{ name: 'A' }] });
});

test('closeTruncatedJson is not fooled by braces inside strings', () => {
    const cut = '{"characters":[{"name":"A {not a brace} ]"},{"name":"B';
    const parsed = JSON.parse(closeTruncatedJson(cut));
    assert.equal(parsed.characters.length, 1);
    assert.equal(parsed.characters[0].name, 'A {not a brace} ]');
});

test('closeTruncatedJson gives up rather than inventing structure', () => {
    // Nothing has completed yet, so there is nothing to salvage — return the input and
    // let the parse fail honestly instead of manufacturing an empty result.
    const cut = '{"characters":[{"name":"A';
    assert.equal(closeTruncatedJson(cut), cut);
    assert.throws(() => parseJsonWithRepair(cut, { label: 'unsalvageable' }));
});

test('salvage is a last resort — it never reshapes a response that already parses', () => {
    const trailingComma = '{"characters":[{"name":"A"},]}';
    const parsed = parseJsonWithRepair(trailingComma, { label: 'trailing comma' });
    assert.equal(parsed.characters.length, 1);
});
