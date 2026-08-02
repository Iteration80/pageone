const { test } = require('node:test');
const assert = require('node:assert');

const { characterRevisionAdapter, sceneBlueprintRevisionAdapter } = require('../utils/revision_transaction');
const { explicitTierChangesFromNotes } = require('../agents/agent_3_characters');

// Bug 8 (found 2026-07-30, fixed 2026-08-02): the verifier checked only whether an
// object DIFFERED, never whether the difference landed on the character the brief
// named. A brief naming Deputy Ray three times, which left Ray untouched and rewrote
// Nora Vance instead, produced `operations: [{type: update, label: "Nora Vance",
// status: verified}]` / "1/1 character operation(s) verified" — and the assistant
// told the writer it was done. Same false-success family as the July cold-open saga.

const CAST = [
    { name: 'Deputy Ray', functional_profile: { emotional_truth: 'He wants out.' } },
    { name: 'Nora Vance', psychological_core: { fear: 'Being believed.' } },
    { name: 'Mayor Hale', cameo_profile: { scene_purpose: 'Stonewalls the inspection.' } },
];

const withChange = (name, patch) => CAST.map(c => (c.name === name ? { ...c, ...patch } : c));

test('a revision that changes the wrong character is reported as a FAILURE', () => {
    const notes = "Update Deputy Ray's emotional truth, pressure behavior and relevant history. Leave every other character untouched.";
    const after = withChange('Nora Vance', { psychological_core: { fear: 'Something else entirely.' } });

    const result = characterRevisionAdapter({ before: CAST, after, notes });

    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].type, 'target_missed');
    assert.match(result.summary, /^FAILED:/);
    assert.match(result.summary, /Deputy Ray/);
    assert.match(result.summary, /Nora Vance/); // says what it changed instead
    assert.match(result.summary, /do not tell the writer the edit was applied/i);
});

test('the same brief passes once it actually hits the named character', () => {
    const notes = "Update Deputy Ray's emotional truth. Leave every other character untouched.";
    const after = withChange('Deputy Ray', { functional_profile: { emotional_truth: 'He wants to be caught.' } });

    const result = characterRevisionAdapter({ before: CAST, after, notes });

    assert.deepEqual(result.failures, []);
    assert.match(result.summary, /1\/1 character operation\(s\) verified/);
});

test('a first name finds a character stored under a title ("Ray" → "Deputy Ray")', () => {
    const result = characterRevisionAdapter({
        before: CAST,
        after: withChange('Nora Vance', { psychological_core: { fear: 'Changed.' } }),
        notes: 'Give Ray more to lose in the third act.'
    });
    assert.equal(result.failures[0]?.type, 'target_missed');
});

test('a role word alone does not name anyone — it would name the whole cast', () => {
    // "the deputy" / "the mayor" are roles, not identities. Matching on them would
    // let any brief satisfy the check by touching any character with a title.
    const result = characterRevisionAdapter({
        before: CAST,
        after: withChange('Nora Vance', { psychological_core: { fear: 'Changed.' } }),
        notes: 'The mayor should feel more present in Act II.'
    });
    assert.deepEqual(result.failures, []);
});

test('mentioning a second character in passing does not cause a false failure', () => {
    // The rule is the weakest one that catches the bug: fail only when NONE of the
    // named characters changed. Nora is named and Nora changed, so this passes even
    // though Ray is named too.
    const notes = "Sharpen Nora Vance's fear so it plays against Ray's cynicism.";
    const after = withChange('Nora Vance', { psychological_core: { fear: 'Being right.' } });

    const result = characterRevisionAdapter({ before: CAST, after, notes });
    assert.deepEqual(result.failures, []);
});

test('a requested deletion counts as touching the named character', () => {
    const notes = 'Remove Mayor Hale from the cast entirely.';
    const after = CAST.filter(c => c.name !== 'Mayor Hale');

    const result = characterRevisionAdapter({ before: CAST, after, notes });
    assert.equal(result.failures.filter(f => f.type === 'target_missed').length, 0);
});

test('a brief naming nobody in the cast keeps the old behaviour', () => {
    const result = characterRevisionAdapter({
        before: CAST,
        after: withChange('Nora Vance', { psychological_core: { fear: 'Changed.' } }),
        notes: 'Make the whole cast feel more desperate.'
    });
    assert.deepEqual(result.failures, []);
    assert.match(result.summary, /verified/);
});

test('the target check does not run on scene blueprints', () => {
    // Scene labels are headings ("Scene 12: INT. RESERVOIR - NIGHT"), so tokenizing
    // them as names would match almost any brief.
    const before = [{ sequence_number: 1, scenes: [{ scene_number: 1, scene_heading: 'INT. RESERVOIR - NIGHT', beat: 'a' }] }];
    const after = [{ sequence_number: 1, scenes: [{ scene_number: 1, scene_heading: 'INT. RESERVOIR - NIGHT', beat: 'b' }] }];

    const result = sceneBlueprintRevisionAdapter({ before, after, notes: 'Tighten the reservoir night scene.' });
    assert.deepEqual(result.failures, []);
});

// ---------------------------------------------------------------------------
// Tier precedence: the SOP promises saved tier assignments are honored "unless the
// writer's notes explicitly change a character's tiering", but normalizeProfileTier
// applied the pin unconditionally — so the model obeyed "promote Ray to Tier 1" and
// the normalizer put him straight back. (Noted 2026-07-30, fixed 2026-08-02.)

const NAMES = ['Deputy Ray', 'Nora Vance', 'Mayor Hale'];

test('an explicit tier instruction in the notes is picked up', () => {
    assert.deepEqual(explicitTierChangesFromNotes('Promote Deputy Ray to Tier 1.', NAMES), { 'Deputy Ray': 'Tier 1' });
    assert.deepEqual(explicitTierChangesFromNotes('Mayor Hale should be a cameo now.', NAMES), { 'Mayor Hale': 'Tier 3' });
    assert.deepEqual(explicitTierChangesFromNotes('Give Nora Vance a full profile.', NAMES), { 'Nora Vance': 'Tier 1' });
});

test('describing a tier is not the same as changing one', () => {
    // "explicitly change a character's tiering" — a bare observation must not retier.
    assert.deepEqual(explicitTierChangesFromNotes('Nora Vance is our Tier 1 lead.', NAMES), {});
    assert.deepEqual(explicitTierChangesFromNotes('Deputy Ray carries the second act.', NAMES), {});
});

test('a tier instruction for one character does not spill onto another', () => {
    const notes = 'Promote Deputy Ray to Tier 1. Separately, sharpen Nora Vance\'s dialogue in the diner.';
    assert.deepEqual(explicitTierChangesFromNotes(notes, NAMES), { 'Deputy Ray': 'Tier 1' });
});

test('Tier 1 wording is not swallowed by the looser Tier 2 patterns', () => {
    assert.deepEqual(explicitTierChangesFromNotes('Make Deputy Ray Tier 1, not a supporting player.', NAMES), { 'Deputy Ray': 'Tier 1' });
});

test('empty or characterless notes retier nobody', () => {
    assert.deepEqual(explicitTierChangesFromNotes('', NAMES), {});
    assert.deepEqual(explicitTierChangesFromNotes('Make everyone Tier 1.', []), {});
});
