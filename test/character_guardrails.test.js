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

// ─── Completeness repair (2026-07-13: 10 Tier 1s hit the output-token ceiling
// and the tail of the cast saved with empty psychological cores) ─────────────

test('incomplete Tier 1/2/3 profiles are detected per tier requirements', () => {
    const { isIncompleteProfile, charactersWithIncompleteProfiles } = require('../agents/agent_3_characters');
    const fullT1 = {
        name: 'Rebecca', profile_tier: 'Tier 1',
        psychological_core: { ghost_and_wound: 'w', the_lie: 'l', fear: 'f', desire: 'd' },
        voice_and_behavior: { voice_tag: 'Sparse & precise' },
        arc: { core_drive: 'To be in control', direction: 'Growth' }
    };
    const skeletalT1 = { name: 'Blounder', profile_tier: 'Tier 1', brief_summary: 'bio only', arc: { core_drive: '', direction: 'Growth' } };
    const fullT2 = { name: 'Moog', profile_tier: 'Tier 2', functional_profile: { narrative_function: 'n', emotional_truth: 'e' } };
    const emptyT2 = { name: 'Pretz', profile_tier: 'Tier 2', functional_profile: {} };
    const fullT3 = { name: 'Molly', profile_tier: 'Tier 3', cameo_profile: { scene_purpose: 's', playable_behavior: 'p' } };

    assert.equal(isIncompleteProfile(fullT1), false);
    assert.equal(isIncompleteProfile(skeletalT1), true, 'empty psychological core = incomplete Tier 1');
    assert.equal(isIncompleteProfile(fullT2), false);
    assert.equal(isIncompleteProfile(emptyT2), true);
    assert.equal(isIncompleteProfile(fullT3), false);
    assert.deepStrictEqual(
        charactersWithIncompleteProfiles([fullT1, skeletalT1, fullT2, emptyT2, fullT3]).map(c => c.name),
        ['Blounder', 'Pretz']
    );
});

test('generation runs a completion repair call when Tier 1 profiles arrive skeletal', async () => {
    const { agent3Characters } = require('../agents/agent_3_characters');
    const fullCore = { ghost_and_wound: 'w', the_lie: 'l', fear: 'f', desire: 'd' };
    const fullBits = { voice_and_behavior: { voice_tag: 'Blunt & clipped' }, arc: { core_drive: 'To be needed', direction: 'Growth' } };
    const firstResponse = {
        characters: [
            { name: 'Rebecca', role: 'Protagonist', profile_tier: 'Tier 1', brief_summary: 'b', psychological_core: fullCore, ...fullBits },
            { name: 'Blounder', role: 'Mentor', profile_tier: 'Tier 1', brief_summary: 'bio only' }
        ]
    };
    const repairResponse = {
        characters: [
            { name: 'Blounder', role: 'Mentor', profile_tier: 'Tier 1', brief_summary: 'bio only', psychological_core: { ghost_and_wound: 'seven empty chairs', the_lie: 'staying is enough', fear: 'being unneeded', desire: 'a kid who keeps him' }, ...fullBits }
        ]
    };
    const calls = [];
    const { result } = await agent3Characters({ title: 'T' }, null, null, null, null, {
        model: 'gemini-test', geminiApiKey: 'x',
        generateContentFn: async request => {
            calls.push(request);
            return { text: JSON.stringify(calls.length === 1 ? firstResponse : repairResponse), usage: { input_tokens: 1, output_tokens: 1 } };
        }
    });
    assert.equal(calls.length, 2, 'a second (repair) model call ran');
    assert.match(calls[1].contents[0], /PROFILE COMPLETION REPAIR/);
    const incompleteBlock = calls[1].contents[0].match(/INCOMPLETE CHARACTERS TO COMPLETE:([\s\S]*?)Here is the approved pitch/)?.[1] || '';
    assert.ok(incompleteBlock.includes('Blounder'), 'repair prompt targets the skeletal character');
    assert.ok(!incompleteBlock.includes('"Rebecca"'), 'complete characters are not re-sent for repair');
    const blounder = result.characters.find(c => c.name === 'Blounder');
    assert.equal(blounder.psychological_core.ghost_and_wound, 'seven empty chairs', 'repair filled the empty core');
    const rebecca = result.characters.find(c => c.name === 'Rebecca');
    assert.equal(rebecca.psychological_core.ghost_and_wound, 'w', 'complete characters untouched');
});

test('completeCharacterProfiles repairs only the incomplete characters, no model call when complete', async () => {
    const { completeCharacterProfiles } = require('../agents/agent_3_characters');
    const fullBits = { voice_and_behavior: { voice_tag: 'Blunt & clipped' }, arc: { core_drive: 'To be needed', direction: 'Growth' } };
    const cast = [
        { name: 'Rebecca', role: 'Protagonist', profile_tier: 'Tier 1', brief_summary: 'b', psychological_core: { ghost_and_wound: 'w', the_lie: 'l', fear: 'f', desire: 'd' }, ...fullBits },
        { name: 'Blounder', role: 'Mentor', profile_tier: 'Tier 1', brief_summary: 'bio only' }
    ];
    const calls = [];
    const repairResponse = {
        characters: [{ name: 'Blounder', role: 'Mentor', profile_tier: 'Tier 1', brief_summary: 'bio only', psychological_core: { ghost_and_wound: 'seven empty chairs', the_lie: 'staying is enough', fear: 'being unneeded', desire: 'a kid who keeps him' }, ...fullBits }]
    };
    const modelConfig = {
        model: 'gemini-test', geminiApiKey: 'x',
        generateContentFn: async request => { calls.push(request); return { text: JSON.stringify(repairResponse), usage: {} }; }
    };

    const { result, repairedNames } = await completeCharacterProfiles(cast, { title: 'T' }, modelConfig);
    assert.equal(calls.length, 1, 'exactly one repair call');
    assert.deepStrictEqual(repairedNames, ['Blounder']);
    assert.equal(result.characters.find(c => c.name === 'Blounder').psychological_core.ghost_and_wound, 'seven empty chairs');
    assert.equal(result.characters.find(c => c.name === 'Rebecca').psychological_core.ghost_and_wound, 'w', 'complete character untouched');

    const completeCast = result.characters;
    const second = await completeCharacterProfiles(completeCast, { title: 'T' }, modelConfig);
    assert.equal(calls.length, 1, 'no model call when every profile is complete');
    assert.deepStrictEqual(second.repairedNames, []);
});

test('the repair call uses the compact schema, never the full casting schema', () => {
    // 2026-07-14, measured live: handing CHARACTER_SCHEMA (75 nodes / 8KB) to the
    // repair made Gemini burn 29,992 output tokens producing 119KB for ONE
    // character, truncate the JSON at the cap, and still leave the requested
    // field empty. PROFILE_REPAIR_SCHEMA answers the same prompt in ~373 tokens.
    const { PROFILE_REPAIR_SCHEMA } = require('../agents/agent_3_characters');
    const countNodes = node => {
        if (!node || typeof node !== 'object') return 0;
        return 1 + Object.values(node).reduce((sum, value) => sum + countNodes(value), 0);
    };
    // The full casting schema measures 75 nodes / ~8KB; this one is 42 / ~2.3KB.
    // The thresholds sit between them, so reverting to the full schema fails here.
    assert.ok(countNodes(PROFILE_REPAIR_SCHEMA) < 55, 'repair schema must stay compact');
    assert.ok(JSON.stringify(PROFILE_REPAIR_SCHEMA).length < 4000, 'repair schema must stay small');
    for (const bloatField of ['_deep_profile', 'relationship_dynamics', 'ticks', 'backstory']) {
        assert.ok(!JSON.stringify(PROFILE_REPAIR_SCHEMA).includes(bloatField),
            `repair schema must not ask for "${bloatField}" — existing values are preserved by the merge`);
    }
    // Every completeness-required field must be reachable, or a repair can never satisfy the check.
    const schemaText = JSON.stringify(PROFILE_REPAIR_SCHEMA);
    for (const required of ['ghost_and_wound', 'the_lie', 'fear', 'desire', 'voice_tag', 'core_drive', 'narrative_function', 'emotional_truth', 'scene_purpose', 'playable_behavior']) {
        assert.ok(schemaText.includes(required), `repair schema must be able to fill "${required}"`);
    }

    const source = require('node:fs').readFileSync(require.resolve('../agents/agent_3_characters.js'), 'utf8');
    const repairFn = source.slice(source.indexOf('async function runProfileCompletionRepair'), source.indexOf('// Standalone repair'));
    assert.ok(repairFn.includes('schema: PROFILE_REPAIR_SCHEMA'), 'repair must pass the compact schema');
    assert.ok(!repairFn.includes('schema: CHARACTER_SCHEMA'), 'repair must never pass the full casting schema');
    // Thinking tokens share maxOutputTokens on Gemini 3; a tight ceiling starves
    // the answer and truncates the JSON (4000 → truncated, 16000 → clean).
    const budget = Number(repairFn.match(/maxOutputTokens:\s*(\d+)/)?.[1] || 0);
    assert.ok(budget >= 8000, `repair output budget must leave room for thinking (found ${budget})`);
});

// ─── Layer 5: no project-specific tiering machinery ──────────────────────────

test('Stage 3 SOP contains no project-specific character names', () => {
    const fs = require('node:fs');
    const sop = fs.readFileSync(require.resolve('../skills/skill_stage3_characters.md'), 'utf8');
    assert.doesNotMatch(sop, /\bIn this project\b/i, 'SOP must stay project-agnostic');
    for (const name of ['Pono', 'Moog', 'Big Doll', 'Pretz', 'Dapple', 'Ms. Alvarado', 'Furdlegurr']) {
        assert.ok(!sop.includes(name), `SOP must not hardcode cast member "${name}"`);
    }
});

test('export pipeline contains no hardcoded cast-tier name lists', () => {
    const fs = require('node:fs');
    const exportJs = fs.readFileSync(require.resolve('../agents/export.js'), 'utf8');
    assert.doesNotMatch(exportJs, /TIER_\d_PROJECT_CHARACTER_NAMES|projectTierForCharacterName/, 'export tier must come from saved profile_tier, not a name list');
    for (const name of ['Furdlegurr', 'Blounder', 'Robotobob', 'Pretz']) {
        assert.ok(!exportJs.includes(`'${name}'`), `export.js must not hardcode cast member "${name}"`);
    }
});

test('server startup does not force-seed project-specific tier overrides', () => {
    const fs = require('node:fs');
    const serverJs = fs.readFileSync(require.resolve('../server.js'), 'utf8');
    assert.doesNotMatch(serverJs, /seedStage3TierOverridesForDirectory/, 'tier seeding is manual-only (CLI or maintenance endpoint)');
});
