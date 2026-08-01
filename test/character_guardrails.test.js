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
    const fnStart = source.indexOf('async function runProfileCompletionRepair');
    assert.ok(fnStart > -1, 'runProfileCompletionRepair must exist');
    // Body = from the declaration to the next top-level declaration after it.
    const rest = source.slice(fnStart + 1);
    const nextDecl = rest.search(/\n(?:async function|function|const) /);
    const repairFn = nextDecl > -1 ? rest.slice(0, nextDecl) : rest;
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

// ─── Layer 6: field-level erasure (2026-07-30 incident) ──────────────────────
// A note targeting three fields on ONE character came back with 38 fields blanked
// across all nine — both Tier 1 psychological cores and every Tier 3 cameo profile —
// while the character COUNT was unchanged, so every list-level guard stayed quiet
// and namedItemDiffAdapter marked each one a "verified" update.

const { preserveNonEmptyCharacterFields } = require('../agents/agent_3_characters');

function tier1(name) {
    return {
        name,
        role: 'Protagonist',
        profile_tier: 'Tier 1',
        brief_summary: `${name} summary`,
        backstory: { relevant_history: 'history', onscreen_relevance: 'relevance' },
        psychological_core: { ghost_and_wound: 'ghost', the_lie: 'lie', fear: 'fear', desire: 'desire' },
        voice_and_behavior: { voice_tag: 'Sparse & precise', speech_patterns: 'clipped' }
    };
}

test('a revision may not silently blank fields it was not asked to touch', () => {
    const before = [tier1('Nora Vance'), tier1('Arthur Vance')];
    // Model returned the full cast — nothing to trip the list-level nets — but blanked
    // the psychological core and voice fields on everyone.
    const after = {
        characters: [
            { ...tier1('Nora Vance'), psychological_core: { ghost_and_wound: 'ghost', the_lie: 'lie', fear: '', desire: '' }, voice_and_behavior: { voice_tag: 'Sparse & precise', speech_patterns: '' } },
            { ...tier1('Arthur Vance'), psychological_core: { ghost_and_wound: '', the_lie: '', fear: '', desire: '' }, voice_and_behavior: {} }
        ]
    };
    const guarded = preserveNonEmptyCharacterFields(before, after);
    const [nora, arthur] = guarded.characters;
    assert.strictEqual(nora.psychological_core.fear, 'fear', 'blanked field restored');
    assert.strictEqual(nora.psychological_core.desire, 'desire');
    assert.strictEqual(nora.voice_and_behavior.speech_patterns, 'clipped');
    assert.strictEqual(arthur.psychological_core.ghost_and_wound, 'ghost', 'collateral character restored too');
    assert.strictEqual(arthur.voice_and_behavior.speech_patterns, 'clipped', 'emptied nested object refilled');
});

test('field preservation never overwrites a real edit', () => {
    const before = [tier1('Deputy Ray')];
    const after = {
        characters: [{
            ...tier1('Deputy Ray'),
            backstory: { relevant_history: 'took kickbacks from the reservoir contracts', onscreen_relevance: '' },
            psychological_core: { ghost_and_wound: 'ghost', the_lie: 'lie', fear: 'fear', desire: 'desire' }
        }]
    };
    const guarded = preserveNonEmptyCharacterFields(before, after);
    const ray = guarded.characters[0];
    assert.strictEqual(ray.backstory.relevant_history, 'took kickbacks from the reservoir contracts', 'the requested edit survives');
    assert.strictEqual(ray.backstory.onscreen_relevance, 'relevance', 'the unrequested blanking does not');
});

test('field preservation runs on the real merge path, not just in isolation', () => {
    const before = [tier1('Nora Vance')];
    const notes = "Sharpen Nora's lie.";
    const modelResult = {
        characters: [{ ...tier1('Nora Vance'), psychological_core: { ghost_and_wound: 'ghost', the_lie: 'a sharper lie', fear: '', desire: '' } }]
    };
    const merged = applySurgicalCharacterMerge(before, modelResult, notes);
    const nora = merged.characters.find(c => c.name === 'Nora Vance');
    assert.strictEqual(nora.psychological_core.the_lie, 'a sharper lie', 'requested edit applied');
    assert.strictEqual(nora.psychological_core.fear, 'fear', 'unrequested blanking reverted end-to-end');
});

// ─── Layer 7: protective language must not read as broad intent ──────────────
// The sentence a writer adds to PROTECT the rest of the cast is exactly where a
// universal quantifier shows up — "leave every other character untouched",
// "preserve all other characters". A bare /all|every|full/ test classified those
// as "revise broadly", which BYPASSES the surgical merge (2026-07-30: 38 fields
// blanked across nine characters, reported as a verified success). The assistant's
// own generated briefs end with such a sentence, so this fired near-universally.

const { isBroadRevisionIntent } = require('../utils/revision_patch');

test('scope-limiting language is not broad intent', () => {
    for (const notes of [
        'Update his emotional_truth and pressure_behavior. Leave every other character untouched.',
        'Update Deputy Ray\'s profile.\nPreserve all other characters and their existing fields.',
        'Sharpen Ray, but leave all the others alone.',
        'Rewrite Ray\'s voice; keep the whole rest of the cast intact.',
        'Change Ray only. Do not modify any of the other entries.'
    ]) {
        assert.strictEqual(isBroadRevisionIntent(notes), false, `must stay surgical: ${notes}`);
    }
});

test('genuinely broad intent still registers, including alongside a protective clause', () => {
    assert.strictEqual(isBroadRevisionIntent('Rewrite every character to be more morally compromised.'), true);
    assert.strictEqual(isBroadRevisionIntent('Give the entire cast a harder edge.'), true);
    // The 2026-07-12 incident brief must keep its classification — Layer 1 pins the
    // preserve-net behaviour on exactly this path.
    assert.strictEqual(isBroadRevisionIntent('Populate the full functional profiles for the Tier 2 figments and add the alias.'), true);
    assert.strictEqual(isBroadRevisionIntent('Rewrite every character to be morally compromised. Preserve all existing names.'), true);
});

test('the protective brief now routes through the surgical merge and cannot touch bystanders', () => {
    const before = [tier1('Nora Vance'), tier1('Arthur Vance'), tier1('Deputy Ray')];
    const notes = "Change Deputy Ray's the_lie to self-interest. Leave every other character untouched.";
    // Model returns the whole cast and blanks the bystanders — the 07-30 failure shape.
    const modelResult = {
        characters: [
            { ...tier1('Nora Vance'), psychological_core: { ghost_and_wound: '', the_lie: '', fear: '', desire: '' } },
            { ...tier1('Arthur Vance'), psychological_core: { ghost_and_wound: '', the_lie: '', fear: '', desire: '' } },
            { ...tier1('Deputy Ray'), psychological_core: { ghost_and_wound: 'ghost', the_lie: 'he is protecting his own skin', fear: 'fear', desire: 'desire' } }
        ]
    };
    const merged = applySurgicalCharacterMerge(before, modelResult, notes);
    const byName = Object.fromEntries(merged.characters.map(c => [c.name, c]));
    assert.strictEqual(byName['Deputy Ray'].psychological_core.the_lie, 'he is protecting his own skin', 'target applied');
    assert.strictEqual(byName['Nora Vance'].psychological_core.the_lie, 'lie', 'bystander untouched');
    assert.strictEqual(byName['Arthur Vance'].psychological_core.ghost_and_wound, 'ghost', 'bystander untouched');
});

// ─── Layer 8: partial (changed-only) returns ─────────────────────────────────

test('a changed-only return applies in place, preserving cast order', () => {
    const before = [tier1('Nora Vance'), tier1('Arthur Vance'), tier1('Deputy Ray'), tier1('Jesse')];
    const notes = 'Make Ray self-interested.';
    const modelResult = {
        characters: [{ ...tier1('Deputy Ray'), psychological_core: { ghost_and_wound: 'ghost', the_lie: 'his own skin', fear: 'fear', desire: 'desire' } }]
    };
    const merged = applySurgicalCharacterMerge(before, modelResult, notes, { partialReturn: true });
    assert.deepStrictEqual(
        merged.characters.map(c => c.name),
        ['Nora Vance', 'Arthur Vance', 'Deputy Ray', 'Jesse'],
        'full cast retained in original order'
    );
    assert.strictEqual(merged.characters[2].psychological_core.the_lie, 'his own skin', 'the returned edit applied in place');
    assert.strictEqual(merged.characters[0].psychological_core.the_lie, 'lie', 'omitted characters untouched');
});

test('a changed-only return can still add a genuinely new character', () => {
    const before = [tier1('Nora Vance')];
    const modelResult = { characters: [tier1('Sheriff Blake')] };
    const merged = applySurgicalCharacterMerge(before, modelResult, 'Add a sheriff who leans on Nora.', { partialReturn: true });
    assert.deepStrictEqual(merged.characters.map(c => c.name), ['Nora Vance', 'Sheriff Blake']);
});

test('an empty changed-only return leaves the cast exactly as it was', () => {
    const before = [tier1('Nora Vance'), tier1('Deputy Ray')];
    const merged = applySurgicalCharacterMerge(before, { characters: [] }, 'No change needed.', { partialReturn: true });
    assert.deepStrictEqual(merged.characters.map(c => c.name), ['Nora Vance', 'Deputy Ray']);
    assert.strictEqual(merged.characters[0].psychological_core.fear, 'fear');
});

test('an explicit "only update X" scope outranks the model\'s changed-only self-report', () => {
    const before = [tier1('Mara'), tier1('June')];
    const notes = 'Only update Mara so she admits she needs June.';
    // Model returns Mara (asked for) AND a quietly rewritten June (not asked for).
    const modelResult = {
        characters: [
            { ...tier1('Mara'), brief_summary: 'Mara admits she needs June.' },
            { ...tier1('June'), brief_summary: 'June accidentally rewritten.' }
        ]
    };
    const merged = applySurgicalCharacterMerge(before, modelResult, notes, { partialReturn: true });
    const byName = Object.fromEntries(merged.characters.map(c => [c.name, c]));
    assert.match(byName['Mara'].brief_summary, /admits she needs June/, 'the named target applied');
    assert.strictEqual(byName['June'].brief_summary, 'June summary', 'the unrequested rewrite rejected');
});

test('the field guard reports what it restored, so a blanked edit is not silently a no-op', () => {
    const before = [tier1('Deputy Ray')];
    // Model was told to REWRITE the_lie and returned it empty instead — the 2026-07-31
    // shape. Restoring it prevents data loss but makes the failed instruction look on
    // disk exactly like "the model chose not to change it".
    const modelResult = {
        characters: [{ ...tier1('Deputy Ray'), psychological_core: { ghost_and_wound: 'ghost', the_lie: '', fear: 'fear', desire: 'desire' } }]
    };
    const restoredFields = [];
    const merged = applySurgicalCharacterMerge(before, modelResult, "Rewrite Ray's the_lie.", { partialReturn: true, restoredFields });
    assert.strictEqual(merged.characters[0].psychological_core.the_lie, 'lie', 'value preserved');
    assert.deepStrictEqual(restoredFields, ['Deputy Ray.psychological_core.the_lie'], 'and the restore is reported, not swallowed');
});

test('a clean revision reports no restored fields', () => {
    const before = [tier1('Deputy Ray')];
    const modelResult = {
        characters: [{ ...tier1('Deputy Ray'), psychological_core: { ghost_and_wound: 'ghost', the_lie: 'a real new lie', fear: 'fear', desire: 'desire' } }]
    };
    const restoredFields = [];
    applySurgicalCharacterMerge(before, modelResult, "Rewrite Ray's the_lie.", { partialReturn: true, restoredFields });
    assert.deepStrictEqual(restoredFields, []);
});

// The tool-result projection in app.js is a WHITELIST — anything not named there is
// invisible to the model, however carefully the server fills the receipt. That is
// where unappliedBlankedFields was being dropped on 2026-07-31.
test('the client tool-result projection forwards unapplied blanked fields to the model', () => {
    const fs = require('node:fs');
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    assert.match(appJs, /unappliedBlankedFields/, 'projection must read the receipt field');
    assert.match(appJs, /partialFailure/, 'and state it in prose the model will act on');
});
