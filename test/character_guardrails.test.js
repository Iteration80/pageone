const { test } = require('node:test');
const assert = require('node:assert');

const { applySurgicalCharacterMerge, preserveExistingCharacters } = require('../agents/agent_3_characters');
const { characterRevisionAdapter, createRevisionTransaction } = require('../utils/revision_transaction');
const { stripModelNarration } = require('../utils/model_text_sanitizer');
const { notesRequestRemoval } = require('../utils/revision_patch');

// Regression suite for the 2026-07-12 incident: a Stage 3 chat revision whose brief
// contained the word "full" bypassed the surgical merge, the model returned a
// partial cast, 29 of 30 characters were silently deleted, and verification
// reported success. These tests pin all four guard layers.

function cast(names) {
    return names.map(name => ({ name, role: 'Supporting', profile_tier: 'Tier 2', brief_summary: `${name} summary` }));
}

// ─── Layer 1: preservation pass in the merge (root cause) ────────────────────

test('broad-intent revision cannot silently drop existing characters', () => {
    const current = cast(['Rebecca', 'Dapple', 'Dave', 'Terry', 'Elliot']);
    // "full" triggers isBroadRevisionIntent → merge bypass, exactly like the incident.
    const notes = 'Populate the full functional profiles for the Tier 2 figments and add the alias.';
    const modelResult = { characters: cast(['Rebecca']) }; // model returned a partial cast
    const merged = applySurgicalCharacterMerge(current, modelResult, notes);
    const names = merged.characters.map(c => c.name).sort();
    assert.deepStrictEqual(names, ['Dapple', 'Dave', 'Elliot', 'Rebecca', 'Terry']);
});

test('on the broad-intent path, explicitly requested removals are honored; everyone else preserved', () => {
    const current = cast(['Rebecca', 'Gary', 'Tyler']);
    // "full" → broad-intent bypass (the dangerous path); Gary's removal is explicit.
    const notes = 'Remove Gary and update the full cast tiering to match.';
    const modelResult = { characters: cast(['Rebecca']) }; // model dropped Tyler too — unrequested
    const merged = applySurgicalCharacterMerge(current, modelResult, notes);
    const names = merged.characters.map(c => c.name).sort();
    assert.deepStrictEqual(names, ['Rebecca', 'Tyler'], 'Gary stays deleted (requested); Tyler restored (unrequested)');
});

test('preserveExistingCharacters matches names case-insensitively (no duplicates)', () => {
    const current = cast(['REBECCA FAIRVIEW']);
    const result = preserveExistingCharacters(current, { characters: cast(['Rebecca Fairview']) }, '');
    assert.strictEqual(result.characters.length, 1);
});

// ─── Layer 2: verification guard (backstop) ──────────────────────────────────

test('unrequested character deletions fail verification', () => {
    const before = cast(['A', 'B', 'C', 'D', 'E', 'F']);
    const after = cast(['A']);
    const tx = createRevisionTransaction({
        stageId: 'stage3_characters',
        before, after,
        notes: 'Tighten the full profiles.',
        adapter: characterRevisionAdapter
    });
    assert.strictEqual(tx.receipt.verified, false);
    assert.ok(tx.receipt.failures.length >= 5, 'each unrequested deletion is a failure');
    assert.ok(tx.receipt.failures.some(f => f.type === 'mass_shrink'), 'mass shrink flagged');
});

test('explicitly requested single deletion passes verification', () => {
    const before = cast(['A', 'B', 'C', 'D', 'E', 'Gary']);
    const after = cast(['A', 'B', 'C', 'D', 'E']);
    const tx = createRevisionTransaction({
        stageId: 'stage3_characters',
        before, after,
        notes: 'Delete Gary; he duplicates Tyler.',
        adapter: characterRevisionAdapter
    });
    assert.strictEqual(tx.receipt.verified, true);
    assert.strictEqual(tx.receipt.failures.length, 0);
});

test('pure updates still verify (no false positives)', () => {
    const before = cast(['A', 'B', 'C']);
    const after = cast(['A', 'B', 'C']).map((c, i) => i === 0 ? { ...c, brief_summary: 'revised' } : c);
    const tx = createRevisionTransaction({
        stageId: 'stage3_characters',
        before, after,
        notes: 'Polish A\'s summary.',
        adapter: characterRevisionAdapter
    });
    assert.strictEqual(tx.receipt.verified, true);
});

// ─── Layer 3: notesRequestRemoval semantics ──────────────────────────────────

test('notesRequestRemoval requires BOTH a removal verb and the name', () => {
    assert.strictEqual(notesRequestRemoval('Remove Gary entirely.', 'Gary'), true);
    assert.strictEqual(notesRequestRemoval('Remove Gary entirely.', 'Tyler'), false);
    assert.strictEqual(notesRequestRemoval('Give Gary a warmer voice.', 'Gary'), false);
    assert.strictEqual(notesRequestRemoval('', 'Gary'), false);
});

// ─── Layer 4: model meta-narration sanitizer ─────────────────────────────────

test('strips the observed Gemini self-talk leak, preserving the real sentence', () => {
    const observed = 'Imagination and childish things are a dangerous distraction from survival सामुद्रिक . '
        + '(Note: Removed spurious text, keeping original: Imagination and childish things are a dangerous distraction from survival.) '
        + 'Wait, correcting to original: Imagination and childish things are a dangerous distraction from survival. (Self-correction: Just copy exactly). '
        + 'Actually, I will just copy exactly: "Imagination and childish things are a dangerous distraction from survival."';
    const cleaned = stripModelNarration(observed);
    assert.ok(cleaned.startsWith('Imagination and childish things are a dangerous distraction from survival.'));
    assert.ok(!/Note:|Self-correction|correcting|copy exactly/i.test(cleaned));
    assert.ok(!/[ऀ-ॿ]/.test(cleaned), 'glitch token removed');
});

test('sanitizer leaves legitimate content untouched', () => {
    for (const legit of [
        'REBECCA FAIRVIEW (42) stares at the storm drain.',
        'DAPPLE (V.O.): You forgot me, Becky.',
        'A note (folded twice) sits on the windowsill.',
        'He waits. Actually waiting is the hard part.'
    ]) {
        assert.strictEqual(stripModelNarration(legit), legit);
    }
});
