const { generateContent } = require('./ai-client');
const { parseJsonWithRepair } = require('./json_parse');
const {
    isBroadRevisionIntent,
    mergeSurgicalLabeledItems,
    notesRequestRemoval
} = require('../utils/revision_patch');
const { sanitizeStringsDeep } = require('../utils/model_text_sanitizer');
const { loadSkill } = require('../utils/skills_cache');
const {
    hasMeaningfulBackstory,
    normalizeCharacterBackstory
} = require('../utils/character_backstory');

const PROFILE_TIERS = {
    FULL: 'Tier 1',
    FUNCTIONAL: 'Tier 2',
    CAMEO: 'Tier 3'
};

function normalizeProjectName(value = '') {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[’‘`]/g, "'")
        .replace(/\b([A-Za-z0-9]+)'s\b/g, '$1s')
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function normalizeTierValue(value = '') {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return null;
    if (/^(?:tier\s*)?1$|full|major|arc-bearing|arc bearing/.test(text)) return PROFILE_TIERS.FULL;
    if (/^(?:tier\s*)?2$|functional|supporting|recurring/.test(text)) return PROFILE_TIERS.FUNCTIONAL;
    if (/^(?:tier\s*)?3$|cameo|scene utility|utility|minor/.test(text)) return PROFILE_TIERS.CAMEO;
    return null;
}

function normalizeTierOverrides(overrides = {}) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return {};
    return Object.entries(overrides).reduce((acc, [name, tier]) => {
        const normalizedName = normalizeProjectName(name);
        const normalizedTier = normalizeTierValue(tier);
        if (normalizedName && normalizedTier) acc[normalizedName] = normalizedTier;
        return acc;
    }, {});
}

// An explicit tier statement — "Tier 1", "a full profile", "a cameo". Ordered most
// specific first so "Tier 1" never falls through to the looser Tier 2 wording.
function explicitTierFromPhrase(text = '') {
    const t = String(text).toLowerCase();
    if (/\btier\s*1\b|\bfull\s+(?:profile|arc)\b|\barc[- ]bearing\b/.test(t)) return PROFILE_TIERS.FULL;
    if (/\btier\s*2\b|\bfunctional\s+(?:profile|character|supporting)\b|\bsupporting\s+(?:profile|character)\b/.test(t)) return PROFILE_TIERS.FUNCTIONAL;
    if (/\btier\s*3\b|\bcameo\b|\bscene[- ]utility\b/.test(t)) return PROFILE_TIERS.CAMEO;
    return null;
}

// A verb that means the writer is CHANGING the tiering, not just describing it.
// The SOP says saved tier assignments are honored "unless the writer's notes
// explicitly change a character's tiering" — so a bare mention isn't enough.
const TIER_CHANGE_INTENT = /\b(?:make|promote|demote|upgrade|downgrade|bump|move|turn|treat|change|set|give|should\s+be|needs?\s+to\s+be|deserves)\b/i;

/**
 * Tier changes the writer stated in their notes, keyed by character name.
 *
 * The pinned tier overrides (`data.stage3_characters.tier_overrides`, set with the
 * Stage 3 tier buttons) used to win unconditionally in normalizeProfileTier — so a
 * note reading "promote Ray to Tier 1" was obeyed by the model and then silently
 * stomped back to the pin by the normalizer. The SOP has always promised the
 * opposite. This restores that precedence by letting a note-stated tier replace the
 * pin for that character, for this run. (Found 2026-07-30, fixed 2026-08-02.)
 *
 * Scoped per SENTENCE, not per character window: "Promote Ray to Tier 1. Separately,
 * sharpen Nora's dialogue." must retier Ray and leave Nora alone, and a fixed-width
 * window around each name reaches across the full stop and retiers both.
 */
function explicitTierChangesFromNotes(notes = '', characterNames = []) {
    const text = String(notes || '');
    if (!text.trim()) return {};
    const names = characterNames.map(name => String(name || '').trim()).filter(Boolean);
    if (!names.length) return {};

    const changes = {};
    for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) {
        const tier = explicitTierFromPhrase(sentence);
        if (!tier || !TIER_CHANGE_INTENT.test(sentence)) continue;
        for (const name of names) {
            if (new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(sentence)) changes[name] = tier;
        }
    }
    return changes;
}

function hasMeaningfulProfileData(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value).some(entry => {
        if (entry == null) return false;
        if (typeof entry === 'object') return hasMeaningfulProfileData(entry);
        return String(entry).trim() !== '';
    });
}

function projectTierForCharacterName(name = '', tierOverrides = {}) {
    const normalized = normalizeProjectName(name);
    if (!normalized) return null;
    return normalizeTierOverrides(tierOverrides)[normalized] || null;
}

function normalizeProfileTier(value = '', character = {}, tierOverrides = {}) {
    const projectTier = projectTierForCharacterName(character.name, tierOverrides);
    if (projectTier) return projectTier;
    const normalizedTier = normalizeTierValue(value);
    if (normalizedTier) return normalizedTier;
    if (hasMeaningfulProfileData(character.cameo_profile)) return PROFILE_TIERS.CAMEO;
    if (hasMeaningfulProfileData(character.functional_profile)) return PROFILE_TIERS.FUNCTIONAL;
    return PROFILE_TIERS.FULL;
}

function normalizeFunctionalProfile(character = {}) {
    const functional = character.functional_profile || {};
    const cameo = character.cameo_profile || {};
    const voice = character.voice_and_behavior || {};
    return {
        narrative_function: functional.narrative_function || character.narrative_function || character.role_in_story || functional.scene_purpose || cameo.scene_purpose || character.scene_purpose || character.brief_summary || '',
        emotional_truth: functional.emotional_truth || character.emotional_truth || '',
        comic_or_tension_function: functional.comic_or_tension_function || functional.comic_function || functional.tension_function || character.comic_or_tension_function || '',
        pressure_behavior: functional.pressure_behavior || functional.temptation_choice_or_pressure || functional.temptation_or_choice || functional.playable_behavior || cameo.playable_behavior || character.playable_behavior || character.pressure_behavior || '',
        voice_flavor: functional.voice_flavor || functional.line_style_or_dialogue_flavor || functional.line_style || functional.dialogue_flavor || character.voice_flavor || character.line_style_or_dialogue_flavor || character.dialogue_flavor || voice.voice_tag || ''
    };
}

function normalizeCameoProfile(character = {}) {
    const cameo = character.cameo_profile || {};
    const functional = character.functional_profile || {};
    return {
        scene_purpose: cameo.scene_purpose || functional.scene_purpose || functional.narrative_function || character.scene_purpose || character.narrative_function || character.brief_summary || '',
        casting_energy: cameo.casting_energy || functional.casting_energy || character.casting_energy || '',
        playable_behavior: cameo.playable_behavior || functional.playable_behavior || functional.pressure_behavior || character.playable_behavior || '',
        line_style_example: cameo.line_style_example || cameo.optional_line_style_example || functional.line_style_or_dialogue_flavor || functional.voice_flavor || character.line_style_example || ''
    };
}

function normalizeLegacyCharacter(character = {}, tierOverrides = {}) {
    const core = character.psychological_core || {};
    const voice = character.voice_and_behavior || {};
    const ticks = character.ticks || {};
    const profile_tier = normalizeProfileTier(character.profile_tier, character, tierOverrides);
    const isFullProfile = profile_tier === PROFILE_TIERS.FULL;
    const psychological_core = isFullProfile
        ? {
            ghost_and_wound: core.ghost_and_wound || core.wound || core.ghost || '',
            the_lie: core.the_lie || core.false_belief || core.lie || '',
            fear: core.fear || '',
            desire: core.desire || '',
            psychological_need: core.psychological_need || core.need || '',
            moral_need: core.moral_need || '',
            paradox: core.paradox || voice.paradox || ''
        }
        : {};
    const voice_and_behavior = isFullProfile
        ? {
            voice_tag: voice.voice_tag || '',
            pressure_tag: voice.pressure_tag || '',
            humor_tag: voice.humor_tag || '',
            speech_patterns: voice.speech_patterns || '',
            deflection_tactic: voice.deflection_tactic || ''
        }
        : {};
    const arc = isFullProfile
        ? {
            core_drive: character.arc?.core_drive || '',
            direction: character.arc?.direction || 'Growth'
        }
        : {};
    const backstory = normalizeCharacterBackstory(character.backstory, character, profile_tier);
    const normalized = {
        ...character,
        profile_tier,
        functional_profile: profile_tier === PROFILE_TIERS.FUNCTIONAL ? normalizeFunctionalProfile(character) : {},
        cameo_profile: profile_tier === PROFILE_TIERS.CAMEO ? normalizeCameoProfile(character) : {},
        psychological_core,
        voice_and_behavior,
        arc,
        backstory: hasMeaningfulBackstory(backstory) ? backstory : {},
        ticks: {
            enabled: isFullProfile && ticks.enabled === true,
            description: isFullProfile ? (ticks.description || '') : '',
            frequency_gate: isFullProfile ? (ticks.frequency_gate || '') : ''
        }
    };
    if (isFullProfile && character._deep_profile) {
        normalized._deep_profile = character._deep_profile;
    } else if (!isFullProfile) {
        delete normalized._deep_profile;
    }
    if (character.subtlety_guidelines) normalized.subtlety_guidelines = character.subtlety_guidelines;
    return normalized;
}

function normalizeCurrentCharacters(currentCharacters, tierOverrides = {}) {
    const list = Array.isArray(currentCharacters)
        ? currentCharacters
        : (Array.isArray(currentCharacters?.characters) ? currentCharacters.characters : []);
    // First occurrence of each name wins. gemini-3.1-pro can re-emit the same
    // character until it runs out of tokens (93 copies of one character, observed
    // 2026-08-03); closeTruncatedJson now salvages those responses instead of failing
    // them, and this is what stops the duplicates reaching the cast. Unnamed entries
    // are left alone — deduping those would silently merge distinct characters.
    const seen = new Set();
    const deduped = list.filter(character => {
        const key = String(character?.name || '').trim().toLowerCase();
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return deduped.map(character => normalizeLegacyCharacter(character, tierOverrides));
}

function needsCharacterModernization(characters = []) {
    return characters.some(char => {
        const tier = normalizeProfileTier(char.profile_tier, char);
        if (tier === PROFILE_TIERS.CAMEO) {
            return !char.cameo_profile?.scene_purpose || !char.cameo_profile?.playable_behavior;
        }
        if (tier === PROFILE_TIERS.FUNCTIONAL) {
            return !char.functional_profile?.narrative_function ||
                !char.functional_profile?.emotional_truth ||
                !char.functional_profile?.comic_or_tension_function ||
                !char.functional_profile?.pressure_behavior ||
                !char.functional_profile?.voice_flavor;
        }
        return !char._deep_profile ||
            !char.psychological_core?.ghost_and_wound ||
            !char.psychological_core?.the_lie ||
            !char.psychological_core?.psychological_need ||
            !char.arc?.core_drive ||
            !char.voice_and_behavior?.voice_tag;
    });
}

function isFullCharacterRegenerationRequest(notes = '') {
    const text = String(notes || '');
    const asksForCharacters = /\b(character|characters|cast|profiles?)\b/i.test(text);
    const asksForFreshPass = /\b(regenerate|re-generate|redo|rebuild|recast|start over|from scratch|fresh pass|fresh set|new cast|new profiles?)\b/i.test(text);
    const surgicalQualifier = /\b(surgical|only|just|specific|one character|single character|leave all other|preserve all other)\b/i.test(text);
    return asksForCharacters && asksForFreshPass && !surgicalQualifier;
}

function characterFromPatchOperation(op = {}, tierOverrides = {}) {
    const labelAndBody = `${op.newLabel || ''} ${op.newBody || ''}`;
    const looksLikeCameo = /\b(receptionist|aide|parent|construction worker|civilian|social worker|guard|clerk|driver|bystander|one-scene|scene utility|cameo)\b/i.test(labelAndBody);
    const projectTier = projectTierForCharacterName(op.newLabel, tierOverrides);
    const profile_tier = projectTier || (looksLikeCameo ? PROFILE_TIERS.CAMEO : PROFILE_TIERS.FUNCTIONAL);
    return normalizeLegacyCharacter({
        name: op.newLabel || 'New Character',
        role: profile_tier === PROFILE_TIERS.CAMEO ? 'Scene Utility' : 'Supporting',
        profile_tier,
        brief_summary: op.newBody || '',
        backstory: {},
        functional_profile: profile_tier === PROFILE_TIERS.FUNCTIONAL ? {
            narrative_function: op.newBody || '',
            emotional_truth: '',
            comic_or_tension_function: '',
            pressure_behavior: '',
            voice_flavor: ''
        } : {},
        cameo_profile: profile_tier === PROFILE_TIERS.CAMEO ? {
            scene_purpose: op.newBody || '',
            casting_energy: '',
            playable_behavior: '',
            line_style_example: ''
        } : {},
        psychological_core: {},
        voice_and_behavior: {},
        arc: {},
        ticks: {}
    }, tierOverrides);
}

function normalizeCharacterResult(result = {}, tierOverrides = {}, rawTierOverrides = tierOverrides) {
    // Strip model meta-narration ("(Note: …)", "Wait, correcting…", glitch tokens)
    // from every string field before the result is saved or rendered.
    const sanitized = sanitizeStringsDeep(result || {});
    return {
        ...sanitized,
        tier_overrides: sanitized.tier_overrides || rawTierOverrides || {},
        characters: normalizeCurrentCharacters(sanitized, tierOverrides)
    };
}

function buildProjectTierGuidance(tierOverrides = {}, ...sources) {
    const normalizedOverrides = normalizeTierOverrides(tierOverrides);
    const overrideEntries = Object.entries(tierOverrides || {})
        .map(([name, tier]) => ({ name, tier: normalizeTierValue(tier), normalizedName: normalizeProjectName(name) }))
        .filter(entry => entry.name && entry.tier && entry.normalizedName && normalizedOverrides[entry.normalizedName]);
    if (!overrideEntries.length) return '';
    const sourceText = sources.map(source => {
        if (!source) return '';
        return typeof source === 'string' ? source : JSON.stringify(source);
    }).join('\n');
    const nameMentioned = name => new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(name)}(?!['’])(?:$|[^A-Za-z0-9])`, 'i').test(sourceText);
    const namesForTier = tier => overrideEntries
        .filter(entry => entry.tier === tier && nameMentioned(entry.name))
        .map(entry => entry.name);
    const mentionedTier1 = namesForTier(PROFILE_TIERS.FULL);
    const mentionedTier2 = namesForTier(PROFILE_TIERS.FUNCTIONAL);
    const mentionedTier3 = namesForTier(PROFILE_TIERS.CAMEO);
    const lines = [];
    if (mentionedTier1.length) {
        lines.push(`- Treat these named arc-bearing characters as Tier 1 unless the outline clearly demotes them: ${mentionedTier1.join(', ')}.`);
    }
    if (mentionedTier2.length) {
        lines.push(`- Treat these functional supporting characters as Tier 2 unless the writer explicitly promotes them to full arc-bearing profiles: ${mentionedTier2.join(', ')}.`);
    }
    if (mentionedTier3.length) {
        lines.push(`- Treat these scene utility / cameo characters as Tier 3 unless the writer explicitly promotes them: ${mentionedTier3.join(', ')}.`);
    }
    if (!lines.length) return '';
    return `\n\nPROJECT-SPECIFIC TIERING SIGNALS:\n${lines.join('\n')}`;
}

function escapeRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function explicitOnlyCharacterTargets(notes = '', currentList = []) {
    const text = String(notes || '');
    if (!/\b(only|just)\s+(update|revise|change|adjust|rewrite|work on)\b/i.test(text)) return [];
    return currentList
        .map(character => character.name || '')
        .filter(name => name && new RegExp(`\\b(?:only|just)\\s+(?:update|revise|change|adjust|rewrite|work on)\\s+(?:the\\s+)?${escapeRegExp(name)}\\b`, 'i').test(text));
}

function applySurgicalCharacterMerge(currentCharacters = [], modelResult = {}, notes = '', { legacyModernizationNeeded = false, tierOverrides = {}, partialReturn = false, restoredFields = [] } = {}) {
    const currentList = normalizeCurrentCharacters(currentCharacters, tierOverrides);
    let candidate = modelResult;

    if (!legacyModernizationNeeded && !isBroadRevisionIntent(notes)) {
        const revisedList = normalizeCurrentCharacters(modelResult, tierOverrides);
        if (currentList.length && revisedList.length) {
            // When the model was asked to return ONLY what it changed, the returned
            // names are the best available signal for what it touched, so they become
            // the target list. Routing them through mergeSurgicalLabeledItems (rather
            // than accepting the response as the new cast) keeps the base as the full
            // saved cast in its original order — every returned character is swapped in
            // place, and nothing can be dropped or reordered.
            //
            // But an EXPLICIT scope in the brief always outranks the model's account of
            // itself. "Only update Mara" means only Mara, even if the model hands back a
            // quietly rewritten June too — trusting the response there would convert the
            // writer's narrowest instruction into the weakest guard we have.
            const explicitTargets = explicitOnlyCharacterTargets(notes, currentList);
            const targetLabels = explicitTargets.length
                ? explicitTargets
                : (partialReturn ? revisedList.map(character => character.name || '').filter(Boolean) : []);
            const merged = mergeSurgicalLabeledItems(currentList, revisedList, notes, {
                targetLabels,
                getLabel: character => character.name || '',
                setLabel: (character, label) => { character.name = label || character.name || 'New Character'; },
                setBody: (character, body) => { character.brief_summary = body || character.brief_summary || ''; },
                buildNewItem: op => characterFromPatchOperation(op, tierOverrides)
            });
            if (merged.changed) candidate = { ...modelResult, characters: merged.items };
        }
    }

    // SAFETY NET (applies on EVERY revision path, including the broad-intent bypass
    // above): a revision may never silently drop existing characters. Any character
    // present before the revision but missing from the model's result is re-appended
    // unchanged, unless the revision brief explicitly asked to remove that character.
    // (2026-07-12: a brief containing the word "full" triggered the broad-intent
    // bypass, the model returned a partial cast, and 29 of 30 characters were lost.)
    // A restore is the guard catching the model mid-erasure. Silence there would hide
    // exactly the failure this function exists to stop — and worse, a restored field
    // is indistinguishable on disk from a field the model simply declined to change,
    // so without this line "the edit didn't land" and "the edit was blanked and put
    // back" look identical when you diff the saved cast.
    const guarded = preserveNonEmptyCharacterFields(
        currentList,
        preserveExistingCharacters(currentList, candidate, notes),
        restoredFields
    );
    if (restoredFields.length) {
        console.log(`  Stage 3 field guard: restored ${restoredFields.length} field(s) the revision blanked without being asked — ${restoredFields.slice(0, 12).join(', ')}${restoredFields.length > 12 ? ', …' : ''}`);
    }
    return guarded;
}

/**
 * Field-level counterpart to preserveExistingCharacters.
 *
 * The list-level net above only asks "is this character still here?", so a model
 * that returns every character but blanks their innards passes straight through —
 * and namedItemDiffAdapter then marks each one a *verified* update, because it
 * only tests whether the object differs, never whether the difference was asked
 * for. (2026-07-30: a note targeting three fields on ONE character came back with
 * 38 fields blanked across all nine, including both Tier 1 psychological cores and
 * every Tier 3 cameo profile, and the assistant reported success.)
 *
 * So: any string field that held content before the revision and is empty or gone
 * after it is restored. Deliberately one-directional — this only ever puts content
 * back, never blocks or rewrites an edit the model actually made. The tradeoff is
 * that a writer explicitly asking to CLEAR a field gets it preserved instead; that
 * is a visible, correctable annoyance, whereas silent mass erasure is neither.
 */
function preserveNonEmptyCharacterFields(currentList = [], resultObj = {}, restoredPaths = []) {
    const resultCharacters = Array.isArray(resultObj?.characters) ? resultObj.characters : [];
    if (!Array.isArray(currentList) || !currentList.length || !resultCharacters.length) return resultObj;

    const nameKey = value => String(value || '').trim().toLowerCase();
    const beforeByName = new Map(
        currentList.map(character => [nameKey(character?.name), character]).filter(([key]) => key)
    );

    const restoreInto = (before, after, trail) => {
        if (!before || typeof before !== 'object' || Array.isArray(before)) return after;
        if (!after || typeof after !== 'object' || Array.isArray(after)) return after;
        for (const [key, beforeValue] of Object.entries(before)) {
            const afterValue = after[key];
            if (typeof beforeValue === 'string') {
                if (beforeValue.trim() && !String(afterValue ?? '').trim()) {
                    after[key] = beforeValue;
                    restoredPaths.push(`${trail}${key}`);
                }
            } else if (beforeValue && typeof beforeValue === 'object' && !Array.isArray(beforeValue)) {
                if (afterValue && typeof afterValue === 'object' && !Array.isArray(afterValue)) {
                    restoreInto(beforeValue, afterValue, `${trail}${key}.`);
                } else if (afterValue === undefined || afterValue === null) {
                    after[key] = JSON.parse(JSON.stringify(beforeValue));
                    restoredPaths.push(`${trail}${key}.*`);
                }
            }
        }
        return after;
    };

    return {
        ...resultObj,
        characters: resultCharacters.map(character => {
            const before = beforeByName.get(nameKey(character?.name));
            return before ? restoreInto(before, character, `${character?.name || '?'}.`) : character;
        })
    };
}

function preserveExistingCharacters(currentList = [], resultObj = {}, notes = '') {
    if (!Array.isArray(currentList) || !currentList.length) return resultObj;
    const resultCharacters = Array.isArray(resultObj?.characters) ? resultObj.characters : [];
    const nameKey = value => String(value || '').trim().toLowerCase();
    const presentNames = new Set(resultCharacters.map(character => nameKey(character?.name)).filter(Boolean));
    const preserved = currentList.filter(character => {
        const key = nameKey(character?.name);
        if (!key || presentNames.has(key)) return false;
        return !notesRequestRemoval(notes, character.name);
    });
    if (!preserved.length) return resultObj;
    return {
        ...resultObj,
        characters: [...resultCharacters, ...preserved.map(character => JSON.parse(JSON.stringify(character)))]
    };
}

const CHARACTER_SCHEMA = {
    type: 'object',
    required: ['characters'],
    properties: {
        characters: {
            type: 'array',
            items: {
                type: 'object',
                required: ['name', 'role', 'profile_tier', 'brief_summary'],
                properties: {
                    name: { type: 'string' },
                    role: { type: 'string', description: "e.g., Protagonist, Antagonist, Catalyst, Adjuster, Supporting" },
                    // "Use exactly one of" was a description, which is a suggestion.
                    // normalizeTierValue mops up the variants it knows ("Tier 2",
                    // "supporting", "2"), but anything outside that list silently
                    // defaults the character to Tier 1 and hands them a full
                    // psychological profile they should not have. An enum is the
                    // contract the description already claimed. (Same class as the
                    // Stage 2 counts below — a rule stated to the model and never
                    // enforced in code.)
                    profile_tier: { type: 'string', enum: ['Tier 1', 'Tier 2', 'Tier 3'], description: "Tier 1 = major arc-bearing full profile. Tier 2 = functional recurring/supporting profile. Tier 3 = cameo / scene utility profile." },
                    brief_summary: { type: 'string', description: "A punchy, 1-2 sentence bio encapsulating who they are and their exact narrative function. Keep Tier 3 summaries brief." },
                    backstory: {
                        type: 'object',
                        description: "Optional. Use only when prior history creates present-tense dramatic value. Empty object when no backstory is useful.",
                        properties: {
                            essential_history: { type: 'string', description: "Tier 1 mostly: the pre-story history that materially affects present behavior, conflict, or plot." },
                            formative_event: { type: 'string', description: "Tier 1 mostly: one specific past event that shaped the character. Leave empty if this repeats ghost_and_wound without adding story utility." },
                            relationship_history: { type: 'string', description: "Tier 1 mostly: relevant shared history with another character that changes current dynamics." },
                            secret_or_reveal: { type: 'string', description: "Optional: hidden history or reveal only when the script can actually use it." },
                            onscreen_relevance: { type: 'string', description: "How this backstory changes choices, conflict, dialogue, staging, or audience understanding on screen." },
                            relevant_history: { type: 'string', description: "Tier 2/3 only when needed: compact past context required to play the character's function." },
                            why_they_matter_now: { type: 'string', description: "Tier 2/3 only when needed: why that past context matters in the current story moment." }
                        }
                    },
                    // ⚠️ `required` on these two is load-bearing, not decoration. A
                    // property that is not required is OPTIONAL to the model, and
                    // gemini-3.1-pro exercises that: asked to revise two fields of one
                    // Tier 2 character it returned a functional_profile holding only
                    // narrative_function and voice_flavor, dropping emotional_truth and
                    // comic_or_tension_function on 5 runs out of 5. A dropped field is
                    // indistinguishable from a cleared one, so the field guard restores
                    // the old value and the writer's edit silently does not land. This
                    // is the real cause of what was recorded as "pro will not rewrite
                    // emotional_truth" — it is a schema gap, not a model refusal.
                    // Requiring the keys costs a few empty strings on the tiers that
                    // don't use the object, and took the same edit from 0/5 landing to
                    // 7/7. Prompt wording alone did nothing. (2026-08-03.)
                    //
                    // ⚠️ `maxItems` on the `characters` array would be the obvious
                    // companion fix for the runaway described in json_parse.js, and it
                    // cannot be done: Gemini rejects minItems/maxItems on an array
                    // whose ITEMS schema itself contains an array, with a bare
                    // `INVALID_ARGUMENT` at request time — and characters[] items
                    // contain arrays. Flat-item arrays (pitch_options, Stage 2 beats)
                    // take the bound fine. See agent_2_outline.js for the measurement.
                    functional_profile: {
                        type: 'object',
                        properties: {
                            narrative_function: { type: 'string', description: "Tier 2 only: how this functional supporting character moves story or pressure." },
                            emotional_truth: { type: 'string', description: "Tier 2 only: the simple human truth underneath their function. Not a trauma diagnosis." },
                            comic_or_tension_function: { type: 'string', description: "Tier 2 only: what kind of comedy, friction, or tension they reliably bring." },
                            pressure_behavior: { type: 'string', description: "Tier 2 only: one temptation, choice, or pressure behavior that matters on screen. Not a stress-arrow or arc mechanic." },
                            voice_flavor: { type: 'string', description: "Tier 2 only: broad playable voice flavor without rigid psychological typing or a binding dialogue fingerprint." }
                        },
                        required: ['narrative_function', 'emotional_truth', 'comic_or_tension_function', 'pressure_behavior', 'voice_flavor']
                    },
                    cameo_profile: {
                        type: 'object',
                        properties: {
                            scene_purpose: { type: 'string', description: "Tier 3 only: the reason this utility role exists in the scene." },
                            casting_energy: { type: 'string', description: "Tier 3 only: fast casting/actor energy." },
                            playable_behavior: { type: 'string', description: "Tier 3 only: one active, playable behavior." },
                            line_style_example: { type: 'string', description: "Tier 3 only: a short line style / dialogue flavor note if useful." }
                        },
                        required: ['scene_purpose', 'casting_energy', 'playable_behavior', 'line_style_example']
                    },
                    psychological_core: {
                        type: 'object',
                        description: "Tier 1 only. Omit or return an empty object for Tier 2 and Tier 3 characters.",
                        properties: {
                            ghost_and_wound: { type: 'string', description: "Tier 1 only. Do not invent trauma for Tier 2 or Tier 3." },
                            the_lie: { type: 'string', description: "Tier 1 only. Do not invent a false worldview for minor or utility roles." },
                            fear: { type: 'string', description: "Tier 1 only. Do not invent fear engines for functional supporting or scene utility roles." },
                            desire: { type: 'string', description: "Tier 1 only: a highly specific, visible, and trackable external goal." },
                            psychological_need: { type: 'string', description: "Tier 1 only: the internal flaw they must overcome that is hurting themselves." },
                            moral_need: { type: 'string', description: "Tier 1 only: the internal flaw they must overcome that is actively hurting others." },
                            paradox: { type: 'string', description: "Optional for Tier 1 only when naturally visible on screen. Do not force paradoxes for functional supporting or cameo characters." }
                        }
                    },
                    voice_and_behavior: {
                        type: 'object',
                        description: "Tier 1 only. Tier 2 and Tier 3 should use functional_profile/cameo_profile line flavor instead.",
                        properties: {
                            voice_tag: { type: 'string', description: "Select from: Sparse & precise, Warm & meandering, Sharp & confrontational, Measured & diplomatic, Stream-of-consciousness, Performative & deflecting, Blunt & clipped, Lyrical & indirect. Or provide a custom tag." },
                            pressure_tag: { type: 'string', description: "How they behave under pressure. Select from: Withdraws, Controls, Lashes out, People-pleases, Dissociates, Doubles down, Goes numb, Deflects with humor. Or provide a custom tag." },
                            humor_tag: { type: 'string', description: "Their humor style. Select from: Dry wit, Self-deprecating, Dark / gallows, Physical, Deflection, None. Or provide a custom tag." },
                            speech_patterns: { type: 'string', description: "Tier 1 only: how they talk and what they NEVER say. Tier 2 should use functional_profile.voice_flavor instead. Tier 3 should use cameo_profile.line_style_example only if useful." },
                            deflection_tactic: { type: 'string', description: "Tier 1 only. Do not create deflection tactics for minor/scene utility characters." }
                        }
                    },
                    arc: {
                        type: 'object',
                        description: "Tier 1 only. Omit or return an empty object for minor/scene utility characters.",
                        properties: {
                            core_drive: { type: 'string', description: "Tier 1 only: select from To be right, To be needed, To succeed, To be unique, To understand, To be safe, To be free, To be in control, To keep peace; or provide a custom drive." },
                            direction: { type: 'string', description: "Tier 1 only: Growth, Decline, or Circular." }
                        }
                    },
                    ticks: {
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean', description: "Optional for Tier 1 only. Use true only when this character has a physical tic or behavioral tell that is naturally visible on screen and useful for the writer/actor." },
                            description: { type: 'string', description: "The specific tic/tell and what psychological function it serves." },
                            frequency_gate: { type: 'string', description: "Exactly when this tic surfaces. For Tier 1, include when it evolves or disappears as the arc completes. Avoid ticks for Tier 2 and Tier 3." }
                        }
                    },
                    _deep_profile: {
                        type: 'object',
                        description: "Tier 1 only. Omit for minor/scene utility characters.",
                        properties: {
                            mbti_type: { type: 'string', description: "Tier 1 only and hidden from the user. Leave empty/omit for Tier 2 and Tier 3." },
                            enneagram_type: { type: 'string', description: "Tier 1 only and hidden from the user. Leave empty/omit for Tier 2 and Tier 3." },
                            enneagram_wing: { type: 'string', description: "Tier 1 only and hidden from the user. Leave empty/omit for Tier 2 and Tier 3." },
                            stress_behavior: { type: 'string', description: "Tier 1 only: concrete behavioral description under maximum pressure." },
                            growth_behavior: { type: 'string', description: "Tier 1 only: concrete behavioral description when growing/healing." },
                            dialogue_fingerprint: { type: 'string', description: "Tier 1 only: technical writing rules for dialogue. For Tier 2/3, do not create binding fingerprints." },
                            relationship_dynamics: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    required: ['with_character', 'dynamic', 'friction_points', 'alliance_points'],
                                    properties: {
                                        with_character: { type: 'string', description: "Name of the other character." },
                                        dynamic: { type: 'string', description: "One-line summary of how these two interact." },
                                        friction_points: { type: 'string', description: "What triggers conflict between them." },
                                        alliance_points: { type: 'string', description: "What creates cooperation or bonding." }
                                    }
                                }
                            },
                            scene_behavior_predictions: { type: 'string', description: "Tier 1 only: low-stakes vs high-stakes behavior predictions. Do not generate for scene utility characters." }
                        }
                    }
                }
            }
        }
    }
};

const agent3Characters = async (pitchData, beatsData, currentCharacters = null, notes = null, pdfFile = null, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = '',
        generateContentFn = generateContent,
        tierOverrides = {}
    } = modelConfig;
    const pinnedTierOverrides = tierOverrides && typeof tierOverrides === 'object' && !Array.isArray(tierOverrides)
        ? tierOverrides
        : {};
    // The SOP promises saved tier assignments are honored "unless the writer's notes
    // explicitly change a character's tiering" — but normalizeProfileTier applied the
    // pin unconditionally, so the model would correctly obey "promote Ray to Tier 1"
    // and the normalizer would put Ray straight back to his pinned tier. A tier the
    // writer states in their notes now replaces the pin, and is persisted as the new
    // pin, exactly as if they had clicked the tier button.
    const castNames = (Array.isArray(currentCharacters)
        ? currentCharacters
        : (Array.isArray(currentCharacters?.characters) ? currentCharacters.characters : []))
        .map(character => String(character?.name || '').trim())
        .filter(Boolean);
    const notedTierChanges = explicitTierChangesFromNotes(notes, castNames);
    if (Object.keys(notedTierChanges).length) {
        console.log(`  Stage 3 tiering: the writer's notes retier ${Object.entries(notedTierChanges).map(([name, tier]) => `${name} → ${tier}`).join(', ')} (overriding the pinned tier).`);
    }
    const rawTierOverrides = { ...pinnedTierOverrides, ...notedTierChanges };
    const normalizedTierOverrides = normalizeTierOverrides(rawTierOverrides);

    const charactersSOP = loadSkill('skill_stage3_characters');

    const normalizedCurrentCharacters = normalizeCurrentCharacters(currentCharacters, normalizedTierOverrides);
    const fullRegenerationRequested = isFullCharacterRegenerationRequest(notes);
    const legacyModernizationNeeded = normalizedCurrentCharacters.length > 0 && needsCharacterModernization(normalizedCurrentCharacters);

    // Revision Bypass Logic
    if (notes && normalizedCurrentCharacters.length > 0 && !fullRegenerationRequested) {
        // A partial return is only correct where the surgical merge actually runs.
        // Legacy modernization rewrites every record by definition, and a broad-intent
        // brief bypasses the merge — both still need the whole cast back.
        const partialReturn = !legacyModernizationNeeded && !isBroadRevisionIntent(notes);
        console.log(`  Surgical Revision Mode: Updating characters... (${partialReturn ? 'changed-only return' : 'full-cast return'})`);
        const legacyInstruction = legacyModernizationNeeded
            ? '\n\nLEGACY MODERNIZATION: Some existing character records come from an older schema. Preserve their visible story intent, assign the appropriate profile_tier, and fill only the fields required by that tier. Tier 1 legacy records should receive the full psychological/voice/arc/_deep_profile treatment. Tier 2 records should receive functional_profile fields centered on narrative_function, emotional_truth, comic_or_tension_function, pressure_behavior, and voice_flavor. Tier 3 records should receive cameo_profile fields centered on scene_purpose, casting_energy, playable_behavior, and line_style_example. Preserve existing backstory when it has present-story value, but do not invent backstory just to fill a field. Do not preserve or invent wounds, lies, fears, psychological needs, moral needs, ticks, arcs, or personality typing for functional supporting or scene utility characters.'
            : '';
        const untouchedRule = partialReturn
            ? 'OMIT every other character from your response entirely — do not echo them back. They are preserved from the saved cast automatically.'
            : 'Leave all other character profiles 100% identical to the provided JSON.';
        const revisionSystemInstruction = `${charactersSOP}\n\nROLE: Surgical Casting Director. Apply the user's note ONLY to the specific character(s) mentioned in the feedback. ${untouchedRule} Do not alter unmentioned traits. If the note describes or discusses a new character who is not in the existing list, create a tier-appropriate profile for them and add them to the cast. Maintain the exact same JSON schema.\n\nCRITICAL: Preserve the \`_deep_profile\` field exactly as provided for each character UNLESS the character is Tier 1 and the user's note specifically addresses personality typing, voice, behavioral patterns, or missing Tier 1 deep-profile data. Preserve the \`backstory\` field exactly as provided unless the writer specifically asks to add, remove, or revise backstory, history, secrets, or past relationships. Do not create or regenerate \`_deep_profile\` for Tier 2 or Tier 3 characters unless the writer explicitly asks for hidden drafting guidance for that minor character. If a Tier 1 character's core psychological traits (ghost_and_wound, the_lie, fear, desire, paradox) or voice tags change, regenerate their \`_deep_profile\` to stay consistent. If ANY Tier 1 character's core traits change, regenerate Tier 1 relationship_dynamics for all affected Tier 1 characters (relationships are bidirectional).${legacyInstruction}`;

        const sourceBlock = knowledgeContext ? `PROJECT SOURCE CANON:\n${knowledgeContext}\n\n` : '';
        // Asking for the whole cast back made a three-field edit re-emit every profile.
        // On a 9-character cast that is ~15KB of output to change ~200 bytes, and it is
        // where gemini-3.1-pro reliably fell into a repetition loop: 123,178 characters
        // in a single string, hard against maxOutputTokens, dying as "Unterminated
        // string in JSON" — deterministically, same byte offset on every retry. The
        // merge has always rebuilt from the saved cast rather than the model's copy of
        // it, so the full list was never load-bearing; it was just a bigger target.
        // ⚠️ The omit-what-you-didn't-touch rule is per CHARACTER. The model will
        // generalize it to FIELDS unless stopped, and an omitted field is
        // indistinguishable from a cleared one, so the field guard restores the old
        // value and the writer's edit silently doesn't land.
        //
        // The prose below is belt-and-braces only — measured on gemini-3.1-pro
        // (2026-08-03) it changed nothing on its own. What actually fixed it was
        // marking the profile fields `required` in CHARACTER_SCHEMA; see the note
        // there. Kept because it also covers objects the schema does not constrain.
        const returnInstruction = partialReturn
            ? `Return ONLY the characters you actually changed, plus any character the note asks you to add. Omit every character you did not touch — they are preserved automatically from the saved cast, and re-sending them unchanged risks corrupting them. If the note changes nothing, return an empty characters array.

For every character you DO return, reproduce its profile objects IN FULL: copy unchanged fields back verbatim and write new text only where the note asks for it. Omitting a field is read as an instruction to erase it, not as "unchanged".`
            : `Return the full updated character list in JSON format.`;
        const revisionPrompt = `${sourceBlock}USER NOTE: ${notes}

EXISTING CHARACTERS:
${JSON.stringify(normalizedCurrentCharacters, null, 2)}

Apply the note surgically. ${returnInstruction}`;

        const response = await generateContentFn({
            model, geminiApiKey, anthropicApiKey,
            contents: [revisionPrompt],
            config: {
                systemInstruction: revisionSystemInstruction,
                temperature: 0.3,
                maxOutputTokens: 32000,
            },
            // On a revision the cast size is known, so bound the array to it rather
            // than the global ceiling: a surgical edit returning more characters than
            // exist is already a runaway, and stopping it early is the difference
            // between a clean result and a 32k-token dead response.
            schema: CHARACTER_SCHEMA
        });

        const parsed = parseJsonWithRepair(response.text, { label: 'Stage 3 character revision response' });
        // Fields the model blanked instead of rewriting. The guard puts the old value
        // back so nothing is lost — but on disk a restored field is indistinguishable
        // from one the model chose not to touch, so without reporting these the writer
        // is told "done" about an edit that never happened. Surfacing them is what lets
        // the assistant say which parts of the note did not land.
        const restoredFields = [];
        return {
            result: normalizeCharacterResult(
                applySurgicalCharacterMerge(normalizedCurrentCharacters, parsed, notes, { legacyModernizationNeeded, tierOverrides: normalizedTierOverrides, partialReturn, restoredFields }),
                normalizedTierOverrides,
                rawTierOverrides
            ),
            usage: response.usage,
            restoredFields
        };
    }

    const systemInstruction = charactersSOP;

    const contents = [];

    if (pdfFile) {
        contents.push({
            inlineData: {
                data: pdfFile.buffer.toString("base64"),
                mimeType: pdfFile.mimetype || "application/pdf"
            }
        });
    }

    const sourceBlock = knowledgeContext ? `PROJECT SOURCE CANON:\n${knowledgeContext}\n\n` : '';
    const projectTierGuidance = buildProjectTierGuidance(rawTierOverrides, pitchData, beatsData, normalizedCurrentCharacters, notes, knowledgeContext);
    let contentsText = `${sourceBlock}MANDATORY FIRST STEP — OUTLINE CHARACTER COVERAGE AND TIERING: Before creating any characters, read the outline below and identify every distinct character it describes — whether referred to by proper name (e.g., "Jax", "Silas") or by a specific role or function (e.g., "a hacker", "the engineer", "an acrobat", "an enforcer"). Every such individual MUST receive a tier-appropriate entry, not necessarily a full psychological profile. Invent a proper name for role-only characters only when they recur, affect story movement, or need to be tracked later; one-scene utility roles may keep functional labels such as "Receptionist" or "Construction Worker." Only after all outline characters are covered may you invent additional characters.

TIERING INSTRUCTIONS:
1. FULL PSYCHOLOGICAL PROFILES: Assign \`profile_tier: "Tier 1"\` only to major or recurring arc-bearing characters with real internal change or sustained moral/psychological pressure. Preserve the full psychological core, arc, voice, relationship, ticks-if-useful, and optional \`_deep_profile\` behavior for these characters.
2. FUNCTIONAL SUPPORTING PROFILES: Assign \`profile_tier: "Tier 2"\` to functional supporting characters who affect story movement but do not need a full therapeutic arc. Fill \`functional_profile\` with narrative_function, emotional_truth, comic_or_tension_function, pressure_behavior, and voice_flavor. Do NOT generate Ghost & Wound, The Lie, Fear, Psychological Need, Moral Need, MBTI/Enneagram logic, ticks, paradoxes, relationship maps, or full arc machinery for Tier 2.
3. SCENE UTILITY / CAMEO PROFILES: Assign \`profile_tier: "Tier 3"\` to one-scene or near-one-scene utility roles. Fill only \`cameo_profile\` with scene_purpose, casting_energy, playable_behavior, and line_style_example. Do NOT generate Ghost & Wound, The Lie, Fear, Psychological Need, Moral Need, MBTI/Enneagram logic, ticks, paradoxes, deep profiles, or full arcs for Tier 3.
4. Ticks and paradox are optional for Tier 1. Include them only when naturally visible on screen and useful for the writer/actor.
5. Do not invent trauma, moral failure, or arc machinery for characters whose only job is scene utility.${projectTierGuidance}

OPTIONAL BACKSTORY INSTRUCTIONS:
1. Backstory is not required. Return \`backstory: {}\` or omit backstory whenever prior history would be decorative lore rather than a useful writing constraint.
2. Backstory is different from Ghost & Wound. Use it for concrete pre-story history that affects present choices, conflict, relationships, reveals, dialogue, or audience understanding.
3. Tier 1 may use essential_history, formative_event, relationship_history, secret_or_reveal, and onscreen_relevance when those details will matter on screen.
4. Tier 2 may use only relevant_history and why_they_matter_now, and only when the history clarifies the character's function now.
5. Tier 3 should have no backstory unless the writer explicitly asks or the scene cannot work without one compact historical fact.

BEHAVIORAL ENGINE INSTRUCTIONS:
1. Run MBTI/Enneagram-style inference ONLY for Tier 1 characters.
2. For Tier 1, select the closest matching tags for voice_tag, pressure_tag, humor_tag, and core_drive from the curated options. Use type inference to guide selection but write all visible fields in concrete, story-specific terms — never expose type codes to the user.
3. Generate \`_deep_profile\` LAST for Tier 1 only. It depends on all visible Tier 1 fields and should be written as technical instructions a downstream drafting agent can follow directly. Omit \`_deep_profile\` for Tier 2 and Tier 3.

Here is the approved pitch:
${JSON.stringify(pitchData, null, 2)}

Here is the broad outline (beats):
${JSON.stringify(beatsData, null, 2)}`;

    if (notes) {
        if (fullRegenerationRequested) {
            contentsText += `\n\nThe user has requested a fresh character regeneration. Create a complete tiered regenerated cast from the approved pitch and outline while honoring these notes. Do not preserve legacy profiles merely because they already exist, and do not promote utility roles into Tier 1 merely because this is a fresh pass.\n\nNOTES: ${notes}`;
        } else if (normalizedCurrentCharacters.length > 0) {
            contentsText += `\n\nThe user has provided feedback for the characters. Revise the existing characters based on these notes.\n\nEXISTING CHARACTERS:\n${JSON.stringify(normalizedCurrentCharacters, null, 2)}\n\nNOTES: ${notes}\n\nEnsure you return the FULL cast of characters, including unrevised ones, in the proper JSON format.`;
        } else {
            contentsText += `\n\nThe user has provided guidance for character generation:\n${notes}`;
        }
    }
    contents.push(contentsText);

    const response = await generateContentFn({
        model, geminiApiKey, anthropicApiKey,
        contents,
        config: {
            systemInstruction,
            temperature: 0.6,
            thinkingConfig: { thinkingLevel: 'HIGH' },
            maxOutputTokens: 32000,
        },
        schema: CHARACTER_SCHEMA
    });

    let result = normalizeCharacterResult(parseJsonWithRepair(response.text, { label: 'Stage 3 character generation response' }), normalizedTierOverrides, rawTierOverrides);
    let usage = response.usage;

    // Completeness repair: with many Tier 1 characters, one generation can hit the
    // output-token ceiling and the tail of the cast arrives skeletal (observed
    // 2026-07-13: 10 Tier 1s requested, the last 5 saved with empty psychological
    // cores). Run ONE focused repair call for the incomplete characters only.
    try {
        for (let round = 0; round < REPAIR_MAX_ROUNDS; round += 1) {
            const incomplete = charactersWithIncompleteProfiles(result.characters || []);
            if (!incomplete.length) break;
            const repair = await runProfileCompletionRepair({
                characters: result.characters || [],
                incomplete,
                pitchData,
                sourceBlock,
                systemInstruction,
                generateContentFn,
                model,
                geminiApiKey,
                anthropicApiKey
            });
            result = normalizeCharacterResult(
                mergeRepairedCharacters(result, repair.repaired),
                normalizedTierOverrides,
                rawTierOverrides
            );
            usage = combineUsage(usage, repair.usage);
        }
        const stillIncomplete = charactersWithIncompleteProfiles(result.characters || []);
        if (stillIncomplete.length) {
            console.warn(`  Stage 3 completeness repair left ${stillIncomplete.length} character(s) incomplete: ${stillIncomplete.map(c => c.name).join(', ')}.`);
        }
    } catch (error) {
        // A failed repair must not fail the generation — the partial cast is
        // still saved and the UI completeness indicators surface the gaps.
        console.warn(`  Stage 3 completeness repair skipped: ${error.message}`);
    }

    return { result, usage };
};

const REPAIR_BATCH_SIZE = 3;
const REPAIR_MAX_ROUNDS = 2;

// A repair must NOT reuse CHARACTER_SCHEMA. That schema exists to cast a whole
// ensemble; handed to the model to fill one gap it burns the entire output
// budget (measured 2026-07-14: 29,992 tokens / 119KB for ONE character, JSON
// truncated at the cap, and the requested field still empty). The same prompt
// with a compact schema answers correctly in 40 tokens. Only completeness-
// required fields belong here — everything else (_deep_profile, ticks,
// backstory) is preserved from the existing profile by mergeRepairedCharacters.
const PROFILE_REPAIR_SCHEMA = {
    type: 'object',
    required: ['characters'],
    properties: {
        characters: {
            type: 'array',
            items: {
                type: 'object',
                required: ['name', 'profile_tier'],
                properties: {
                    name: { type: 'string', description: 'Must exactly match the name of the character being completed.' },
                    profile_tier: { type: 'string', description: 'Copy verbatim from the input character: Tier 1, Tier 2, or Tier 3.' },
                    psychological_core: {
                        type: 'object',
                        description: 'Tier 1 only. Omit entirely for Tier 2/Tier 3.',
                        properties: {
                            ghost_and_wound: { type: 'string' },
                            the_lie: { type: 'string' },
                            fear: { type: 'string' },
                            desire: { type: 'string' },
                            psychological_need: { type: 'string' },
                            moral_need: { type: 'string' },
                            paradox: { type: 'string' }
                        }
                    },
                    voice_and_behavior: {
                        type: 'object',
                        description: 'Tier 1 only. Omit entirely for Tier 2/Tier 3.',
                        properties: {
                            voice_tag: { type: 'string', description: 'One of: Sparse & precise, Warm & meandering, Sharp & confrontational, Measured & diplomatic, Stream-of-consciousness, Performative & deflecting, Blunt & clipped, Lyrical & indirect.' },
                            pressure_tag: { type: 'string', description: 'One of: Withdraws, Controls, Lashes out, People-pleases, Dissociates, Doubles down, Goes numb, Deflects with humor.' },
                            humor_tag: { type: 'string', description: 'One of: Dry wit, Self-deprecating, Dark / gallows, Physical, Deflection, None.' },
                            speech_patterns: { type: 'string' },
                            deflection_tactic: { type: 'string' }
                        }
                    },
                    arc: {
                        type: 'object',
                        description: 'Tier 1 only. Omit entirely for Tier 2/Tier 3.',
                        properties: {
                            core_drive: { type: 'string', description: 'One of: To be right, To be needed, To succeed, To be unique, To understand, To be safe, To be free, To be in control, To keep peace.' },
                            direction: { type: 'string', description: 'Growth, Decline, or Circular.' }
                        }
                    },
                    functional_profile: {
                        type: 'object',
                        description: 'Tier 2 only. Omit entirely for Tier 1/Tier 3.',
                        properties: {
                            narrative_function: { type: 'string' },
                            emotional_truth: { type: 'string' },
                            comic_or_tension_function: { type: 'string' },
                            pressure_behavior: { type: 'string' },
                            voice_flavor: { type: 'string' }
                        }
                    },
                    cameo_profile: {
                        type: 'object',
                        description: 'Tier 3 only. Omit entirely for Tier 1/Tier 2.',
                        properties: {
                            scene_purpose: { type: 'string' },
                            casting_energy: { type: 'string' },
                            playable_behavior: { type: 'string' },
                            line_style_example: { type: 'string' }
                        }
                    }
                }
            }
        }
    }
};

// Exact missing tier-required paths for one character — spelling these out in
// the repair prompt beats asking the model to infer the gaps (observed: it
// filled Brenda's voice but not her arc, and Marcus's arc but not his voice).
function missingProfileFieldPaths(character = {}) {
    const tier = normalizeProfileTier(character.profile_tier, character);
    const filled = value => String(value || '').trim() !== '';
    const missing = [];
    if (tier === PROFILE_TIERS.FULL) {
        const core = character.psychological_core || {};
        for (const field of TIER1_REQUIRED_CORE_FIELDS) {
            if (!filled(core[field])) missing.push(`psychological_core.${field}`);
        }
        if (!filled(character.voice_and_behavior?.voice_tag)) missing.push('voice_and_behavior.voice_tag (plus the other voice fields)');
        if (!filled(character.arc?.core_drive)) missing.push('arc.core_drive');
    } else if (tier === PROFILE_TIERS.FUNCTIONAL) {
        const functional = character.functional_profile || {};
        if (!filled(functional.narrative_function)) missing.push('functional_profile.narrative_function');
        if (!filled(functional.emotional_truth)) missing.push('functional_profile.emotional_truth');
    } else {
        const cameo = character.cameo_profile || {};
        if (!filled(cameo.scene_purpose)) missing.push('cameo_profile.scene_purpose');
        if (!filled(cameo.playable_behavior)) missing.push('cameo_profile.playable_behavior');
    }
    return missing;
}

// Drop empty scaffolding (empty strings/objects/arrays) so the repair prompt
// carries only real data — the normalized empty shells both bloat the prompt
// and invite the model to echo them back.
function compactCharacterForPrompt(character = {}) {
    const compact = {};
    for (const [field, value] of Object.entries(character)) {
        if (value == null) continue;
        if (typeof value === 'string') { if (value.trim()) compact[field] = value; continue; }
        if (Array.isArray(value)) { if (value.length) compact[field] = value; continue; }
        if (typeof value === 'object') { if (hasMeaningfulProfileData(value)) compact[field] = value; continue; }
        compact[field] = value;
    }
    return compact;
}

async function runProfileCompletionRepair({
    characters = [],
    incomplete = [],
    pitchData = {},
    sourceBlock = '',
    systemInstruction = '',
    generateContentFn,
    model,
    geminiApiKey,
    anthropicApiKey
}) {
    console.log(`  Stage 3 completeness repair: ${incomplete.length} character(s) missing tier-required fields (${incomplete.map(c => c.name).join(', ')}).`);
    const castSummary = characters.map(c => `${c.name} (${c.role || 'Unknown'}, ${c.profile_tier || 'Tier 1'})`).join('; ');
    const allRepaired = [];
    let usage = null;

    // Batched: one huge response invites the model to re-emit the whole cast and
    // truncate mid-JSON (observed live 2026-07-14 — a 2-character repair came
    // back as ~138k chars of full-cast output, unterminated at the token cap).
    for (let offset = 0; offset < incomplete.length; offset += REPAIR_BATCH_SIZE) {
        const batch = incomplete.slice(offset, offset + REPAIR_BATCH_SIZE);
        const batchNames = batch.map(c => c.name).join(', ');
        const repairPrompt = `${sourceBlock}PROFILE COMPLETION REPAIR: The character profiles below were saved with tier-required fields missing (usually a truncated generation). Complete ONLY these characters. Preserve name, role, profile_tier, brief_summary, and every already-populated field VERBATIM — fill in only what is empty, at the depth their profile_tier requires. Tier 1 needs the full psychological core (ghost_and_wound, the_lie, fear, desire, psychological_need, moral_need), voice_and_behavior tags, arc with core_drive, and _deep_profile. Tier 2 needs the functional_profile fields. Tier 3 needs the cameo_profile fields.

FULL CAST (reference only, for relationship_dynamics — do NOT include these characters in your response): ${castSummary}

EXACT MISSING FIELDS (fill every one of these — this list is authoritative):
${batch.map(c => `- ${c.name}: ${missingProfileFieldPaths(c).join('; ') || 'tier-required fields'}`).join('\n')}

INCOMPLETE CHARACTERS TO COMPLETE:
${JSON.stringify(batch.map(compactCharacterForPrompt), null, 2)}

Here is the approved pitch for story context:
${JSON.stringify(pitchData, null, 2)}

CRITICAL OUTPUT CONTRACT: Your characters array must contain EXACTLY ${batch.length} entr${batch.length === 1 ? 'y' : 'ies'} — ${batchNames} — and no one else. Do not restate any other cast member. Keep every field value concise; never repeat a sentence.`;

        // One batch failing (e.g. a sampling repetition-loop producing unterminated
        // JSON — observed live 2026-07-14) must not sink the other batches: retry
        // once at a different temperature, then skip and leave those characters
        // for the UI indicators / the next repair round.
        let parsed = null;
        for (const temperature of [0.4, 0.7]) {
            try {
                const repairResponse = await generateContentFn({
                    model, geminiApiKey, anthropicApiKey,
                    contents: [repairPrompt],
                    config: {
                        systemInstruction,
                        temperature,
                        thinkingConfig: { thinkingLevel: 'HIGH' },
                        // Gemini 3 counts THINKING tokens against maxOutputTokens.
                        // A correct repair answer is ~373 tokens, but a tight
                        // ceiling starves the thinking budget and truncates the
                        // JSON mid-answer (measured 2026-07-14: 4000 → truncated
                        // at ~600 chars; 16000 → clean in 13.6s). Do not lower.
                        maxOutputTokens: 16000,
                    },
                    schema: PROFILE_REPAIR_SCHEMA
                });
                parsed = parseJsonWithRepair(repairResponse.text, { label: 'Stage 3 character completion repair response' });
                usage = combineUsage(usage, repairResponse.usage);
                break;
            } catch (error) {
                console.warn(`  Stage 3 completeness repair batch (${batchNames}) failed at temperature ${temperature}: ${error.message}`);
            }
        }
        if (!parsed) continue;
        const batchNameSet = new Set(batch.map(c => String(c.name || '').trim().toLowerCase()));
        for (const character of (parsed?.characters || [])) {
            if (batchNameSet.has(String(character?.name || '').trim().toLowerCase())) allRepaired.push(character);
        }
    }

    return { repaired: { characters: allRepaired }, usage };
}

const TIER1_REQUIRED_CORE_FIELDS = ['ghost_and_wound', 'the_lie', 'fear', 'desire'];

function isIncompleteProfile(character = {}) {
    const tier = normalizeProfileTier(character.profile_tier, character);
    const filled = value => String(value || '').trim() !== '';
    if (tier === PROFILE_TIERS.FULL) {
        const core = character.psychological_core || {};
        return TIER1_REQUIRED_CORE_FIELDS.some(field => !filled(core[field]))
            || !filled(character.voice_and_behavior?.voice_tag)
            || !filled(character.arc?.core_drive);
    }
    if (tier === PROFILE_TIERS.FUNCTIONAL) {
        const functional = character.functional_profile || {};
        return !filled(functional.narrative_function) || !filled(functional.emotional_truth);
    }
    const cameo = character.cameo_profile || {};
    return !filled(cameo.scene_purpose) || !filled(cameo.playable_behavior);
}

function charactersWithIncompleteProfiles(characters = []) {
    return (Array.isArray(characters) ? characters : []).filter(character => character?.name && isIncompleteProfile(character));
}

function mergeRepairedCharacters(result = {}, repaired = {}) {
    const repairedList = Array.isArray(repaired?.characters) ? repaired.characters : [];
    if (!repairedList.length) return result;
    const key = value => String(value || '').trim().toLowerCase();
    const repairedByName = new Map(repairedList.map(character => [key(character?.name), character]).filter(([name]) => name));
    const characters = (result.characters || []).map(character => {
        const replacement = repairedByName.get(key(character?.name));
        if (!replacement) return character;
        // Existing populated values win LEAF BY LEAF; the repair only fills gaps.
        // (A whole-object comparison fails here: the normalizer's arc default
        // `direction: 'Growth'` makes an otherwise-empty arc look populated,
        // which silently discarded the repair's core_drive.)
        const merged = fillEmptyFieldsDeep(character, replacement);
        merged.name = character.name;
        merged.profile_tier = character.profile_tier || replacement.profile_tier;
        return merged;
    });
    return { ...result, characters };
}

function fillEmptyFieldsDeep(existing, replacement) {
    if (existing == null) return replacement ?? existing;
    if (typeof existing === 'string') return existing.trim() ? existing : (replacement ?? existing);
    if (Array.isArray(existing)) return existing.length ? existing : (replacement ?? existing);
    if (typeof existing === 'object') {
        if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) return existing;
        const merged = {};
        for (const field of new Set([...Object.keys(replacement), ...Object.keys(existing)])) {
            merged[field] = fillEmptyFieldsDeep(existing[field], replacement[field]);
        }
        return merged;
    }
    return existing;
}

// Must emit the canonical ai-client shape { model, inputTokens, outputTokens }:
// trackUsage() drops any record without `model` and reads camelCase token counts,
// so a snake_case/model-less merge silently erases the whole stage's spend.
function combineUsage(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return {
        model: a.model || b.model,
        inputTokens: (a.inputTokens || 0) + (b.inputTokens || 0),
        outputTokens: (a.outputTokens || 0) + (b.outputTokens || 0)
    };
}

module.exports = { agent3Characters, normalizeCurrentCharacters, applySurgicalCharacterMerge, preserveExistingCharacters, preserveNonEmptyCharacterFields, charactersWithIncompleteProfiles, isIncompleteProfile, explicitTierChangesFromNotes, PROFILE_REPAIR_SCHEMA };
