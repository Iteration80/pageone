const test = require('node:test');
const assert = require('node:assert');

const { parseStyleSections, diffStyleSections } = require('../utils/style_diff');
const { stampStyleFrontMatter, parseStyleFile } = require('../agents/agent_7_style');

// The real shape: front matter + the six directive sections.
const DIRECTIVE_V1 = `---
name: "Desert Standoff"
slug: "desert-standoff"
tier: "conversational"
tonal_summary: "Lean, sun-scorched, high-stakes tension"
---

## Scene Construction
Open scenes late and exit early.

## Action Lines
Write short, clipped, muscular prose. Show only what a camera can film or a microphone can pick up.

## Dialogue
Keep dialogue sparse and loaded with unspoken leverage.

## Tone
Maintain an unrelenting, sun-baked pressure.

## Signature Moves
- **The Weary Warning**: a threat delivered through familial phrasing.

## Avoid
- Never write internal monologue.
`;

test('sections are parsed in order, with front matter stripped', () => {
    const sections = parseStyleSections(DIRECTIVE_V1);
    assert.deepStrictEqual(Object.keys(sections), [
        'Scene Construction', 'Action Lines', 'Dialogue', 'Tone', 'Signature Moves', 'Avoid'
    ]);
    assert.match(sections['Action Lines'], /camera can film/);
    // Front matter must not leak in as a section body.
    assert.ok(!JSON.stringify(sections).includes('tonal_summary'));
});

test('parsing a bare body (no front matter) works the same', () => {
    const body = DIRECTIVE_V1.slice(DIRECTIVE_V1.lastIndexOf('---') + 3);
    assert.deepStrictEqual(Object.keys(parseStyleSections(body)).length, 6);
});

test('an identical file reports no change at all', () => {
    const d = diffStyleSections(DIRECTIVE_V1, DIRECTIVE_V1);
    assert.strictEqual(d.changed, false);
    assert.strictEqual(d.changedSections.length, 0);
    assert.strictEqual(d.unchangedSections.length, 6);
});

test('a single-section edit is reported as exactly that — the case the receipt exists for', () => {
    const v2 = DIRECTIVE_V1.replace(
        'Keep dialogue sparse and loaded with unspoken leverage.',
        'Keep dialogue sparse, but allow one shattering moment of direct truth.'
    );
    const d = diffStyleSections(DIRECTIVE_V1, v2);
    assert.strictEqual(d.changed, true);
    assert.deepStrictEqual(d.changedSections, ['Dialogue']);
    assert.deepStrictEqual(d.unchangedSections, [
        'Scene Construction', 'Action Lines', 'Tone', 'Signature Moves', 'Avoid'
    ]);
    assert.match(d.summary, /rewrote Dialogue/);
    assert.match(d.summary, /byte-identical/);
});

// This is the observed 2026-08-05 failure: asked to change ONE dialogue rule, the
// model returned a full paraphrase of every section and the assistant reported
// "Every other constraint remains exactly as it was". The diff has to contradict
// that claim, or the receipt is decorative.
test('a full paraphrase is NOT reported as a preserved refine', () => {
    const paraphrased = DIRECTIVE_V1
        .replace('Open scenes late and exit early.', 'Begin scenes mid-action and cut on the turn.')
        .replace('Write short, clipped, muscular prose. Show only what a camera can film or a microphone can pick up.', 'Write short, clipped, muscular action lines. Use precise verbs and hard-edged nouns.')
        .replace('Keep dialogue sparse and loaded with unspoken leverage.', 'Keep dialogue sparse, but allow one shattering moment of direct truth.')
        .replace('Maintain an unrelenting, sun-baked pressure.', 'Hold a hostile, sun-baked pressure throughout.')
        .replace('- **The Weary Warning**: a threat delivered through familial phrasing.', '- **The Weary Warning:** high-stakes threats in calm paternal logic.')
        .replace('- Never write internal monologue.', '- Internal monologue or thoughts inside action lines.');

    const d = diffStyleSections(DIRECTIVE_V1, paraphrased);
    assert.strictEqual(d.changedSections.length, 6);
    assert.strictEqual(d.unchangedSections.length, 0, 'nothing was preserved, so nothing may be listed as preserved');
    // The specific craft rule that silently vanished must not read as retained.
    assert.ok(!d.unchangedSections.includes('Action Lines'));
});

test('whitespace reflow alone is not an edit', () => {
    const reflowed = DIRECTIVE_V1.replace(
        'Write short, clipped, muscular prose. Show only what a camera can film or a microphone can pick up.',
        'Write short, clipped, muscular prose.\nShow only what a camera can film or a microphone can pick up.'
    );
    const d = diffStyleSections(DIRECTIVE_V1, reflowed);
    assert.deepStrictEqual(d.changedSections, []);
});

test('added and removed sections are named, not silently folded in', () => {
    const withoutAvoid = DIRECTIVE_V1.slice(0, DIRECTIVE_V1.indexOf('## Avoid')) + '## Restraint\n- Hold back.\n';
    const d = diffStyleSections(DIRECTIVE_V1, withoutAvoid);
    assert.deepStrictEqual(d.removedSections, ['Avoid']);
    assert.deepStrictEqual(d.addedSections, ['Restraint']);
    assert.strictEqual(d.changed, true);
});

test('stampStyleFrontMatter overwrites the model\'s slug and adds ownership', () => {
    // The model wrote slug "desert-standoff" but the file was saved as -2.
    const stamped = stampStyleFrontMatter(DIRECTIVE_V1, { slug: 'desert-standoff-2', project_id: '1785433824227' });
    const { meta, body } = parseStyleFile(stamped);
    assert.strictEqual(meta.slug, 'desert-standoff-2');
    assert.strictEqual(meta.project_id, '1785433824227');
    // Untouched fields survive, and the body is not disturbed.
    assert.strictEqual(meta.name, 'Desert Standoff');
    assert.strictEqual(meta.tier, 'conversational');
    assert.match(body, /^## Scene Construction/);
    assert.strictEqual(Object.keys(parseStyleSections(stamped)).length, 6);
});

test('stampStyleFrontMatter creates front matter when the model omitted it', () => {
    const stamped = stampStyleFrontMatter('## Tone\nDry.\n', { slug: 'x', project_id: '1' });
    const { meta } = parseStyleFile(stamped);
    assert.strictEqual(meta.slug, 'x');
    assert.strictEqual(meta.project_id, '1');
    assert.deepStrictEqual(Object.keys(parseStyleSections(stamped)), ['Tone']);
});

test('stampStyleFrontMatter with no fields is a no-op', () => {
    assert.strictEqual(stampStyleFrontMatter(DIRECTIVE_V1, {}), DIRECTIVE_V1);
});

// The stamper originally required the file to begin with EXACTLY `---\n`. Everything
// else was read as "this file has no front matter", so it synthesised a fresh block
// holding only the stamped fields and pushed the model's real name/tier/tonal_summary
// down into the body. Found 2026-08-05 on a trained style that lost `tier` — which then
// defeated the guard that reads `tier` to protect trained styles from in-place rewrites.
// One brittle regex, three consequences.
const MESSY_VARIANTS = {
    'a leading blank line': '\n' + DIRECTIVE_V1,
    'leading indentation': '  ' + DIRECTIVE_V1,
    'CRLF line endings': DIRECTIVE_V1.replace(/\n/g, '\r\n'),
    'trailing space after the opening ---': DIRECTIVE_V1.replace(/^---/, '--- '),
    'a wrapping code fence': '```markdown\n' + DIRECTIVE_V1 + '```\n',
    'a UTF-8 BOM': '﻿' + DIRECTIVE_V1
};

for (const [label, variant] of Object.entries(MESSY_VARIANTS)) {
    test(`front matter survives ${label}`, () => {
        const { meta, body } = parseStyleFile(variant);
        assert.strictEqual(meta.name, 'Desert Standoff', 'name must survive');
        assert.strictEqual(meta.tier, 'conversational', 'tier must survive — a guard reads it');
        assert.strictEqual(meta.tonal_summary, 'Lean, sun-scorched, high-stakes tension');
        assert.match(body, /^## Scene Construction/);
    });

    test(`stamping preserves existing front matter despite ${label}`, () => {
        const stamped = stampStyleFrontMatter(variant, { slug: 'new-slug', project_id: '123' });
        const { meta, body } = parseStyleFile(stamped);
        // The stamped fields land...
        assert.strictEqual(meta.slug, 'new-slug');
        assert.strictEqual(meta.project_id, '123');
        // ...without costing the ones the model wrote.
        assert.strictEqual(meta.tier, 'conversational');
        assert.strictEqual(meta.name, 'Desert Standoff');
        assert.strictEqual(meta.tonal_summary, 'Lean, sun-scorched, high-stakes tension');
        // And the body is still the directive, not the old front matter re-homed into it.
        assert.match(body, /^## Scene Construction/);
        assert.doesNotMatch(body, /tonal_summary/, 'front matter must not be pushed into the body');
        assert.strictEqual(Object.keys(parseStyleSections(stamped)).length, 6);
    });
}

test('a file with genuinely no front matter still gets one, keeping its body', () => {
    const stamped = stampStyleFrontMatter('## Tone\nDry.\n', { slug: 'x' });
    const { meta, body } = parseStyleFile(stamped);
    assert.strictEqual(meta.slug, 'x');
    assert.match(body, /^## Tone/);
});
