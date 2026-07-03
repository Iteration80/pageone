const { generateContent } = require('./ai-client');
const { parseJsonWithRepair } = require('./json_parse');
const {
    isBroadRevisionIntent,
    mergeSurgicalLabeledItems
} = require('../utils/revision_patch');
const { loadSkill } = require('../utils/skills_cache');

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
    if (character.cameo_profile) return PROFILE_TIERS.CAMEO;
    if (character.functional_profile) return PROFILE_TIERS.FUNCTIONAL;
    return PROFILE_TIERS.FULL;
}

function normalizeFunctionalProfile(character = {}) {
    const functional = character.functional_profile || {};
    const cameo = character.cameo_profile || {};
    const voice = character.voice_and_behavior || {};
    return {
        narrative_function: functional.narrative_function || character.narrative_function || character.role_in_story || functional.scene_purpose || cameo.scene_purpose || character.scene_purpose || '',
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
        scene_purpose: cameo.scene_purpose || functional.scene_purpose || functional.narrative_function || character.scene_purpose || character.narrative_function || '',
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
    const normalized = {
        ...character,
        profile_tier,
        functional_profile: profile_tier === PROFILE_TIERS.FUNCTIONAL ? normalizeFunctionalProfile(character) : {},
        cameo_profile: profile_tier === PROFILE_TIERS.CAMEO ? normalizeCameoProfile(character) : {},
        psychological_core,
        voice_and_behavior,
        arc,
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
    return list.map(character => normalizeLegacyCharacter(character, tierOverrides));
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
    return {
        ...result,
        tier_overrides: result.tier_overrides || rawTierOverrides || {},
        characters: normalizeCurrentCharacters(result, tierOverrides)
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

function applySurgicalCharacterMerge(currentCharacters = [], modelResult = {}, notes = '', { legacyModernizationNeeded = false, tierOverrides = {} } = {}) {
    if (legacyModernizationNeeded || isBroadRevisionIntent(notes)) return modelResult;
    const currentList = normalizeCurrentCharacters(currentCharacters, tierOverrides);
    const revisedList = normalizeCurrentCharacters(modelResult, tierOverrides);
    if (!currentList.length || !revisedList.length) return modelResult;
    const targetLabels = explicitOnlyCharacterTargets(notes, currentList);

    const merged = mergeSurgicalLabeledItems(currentList, revisedList, notes, {
        targetLabels,
        getLabel: character => character.name || '',
        setLabel: (character, label) => { character.name = label || character.name || 'New Character'; },
        setBody: (character, body) => { character.brief_summary = body || character.brief_summary || ''; },
        buildNewItem: op => characterFromPatchOperation(op, tierOverrides)
    });

    if (!merged.changed) return modelResult;
    return {
        ...modelResult,
        characters: merged.items
    };
}

const agent3Characters = async (pitchData, beatsData, currentCharacters = null, notes = null, pdfFile = null, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = '',
        generateContentFn = generateContent,
        tierOverrides = {}
    } = modelConfig;
    const rawTierOverrides = tierOverrides && typeof tierOverrides === 'object' && !Array.isArray(tierOverrides)
        ? tierOverrides
        : {};
    const normalizedTierOverrides = normalizeTierOverrides(rawTierOverrides);

    const charactersSOP = loadSkill('skill_stage3_characters');

    const characterSchema = {
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
                        profile_tier: { type: 'string', description: "Use exactly one of: Tier 1, Tier 2, Tier 3. Tier 1 = major arc-bearing full profile. Tier 2 = functional recurring/supporting profile. Tier 3 = cameo / scene utility profile." },
                        brief_summary: { type: 'string', description: "A punchy, 1-2 sentence bio encapsulating who they are and their exact narrative function. Keep Tier 3 summaries brief." },
                        functional_profile: {
                            type: 'object',
                            properties: {
                                narrative_function: { type: 'string', description: "Tier 2 only: how this functional supporting character moves story or pressure." },
                                emotional_truth: { type: 'string', description: "Tier 2 only: the simple human truth underneath their function. Not a trauma diagnosis." },
                                comic_or_tension_function: { type: 'string', description: "Tier 2 only: what kind of comedy, friction, or tension they reliably bring." },
                                pressure_behavior: { type: 'string', description: "Tier 2 only: one temptation, choice, or pressure behavior that matters on screen. Not a stress-arrow or arc mechanic." },
                                voice_flavor: { type: 'string', description: "Tier 2 only: broad playable voice flavor without rigid psychological typing or a binding dialogue fingerprint." }
                            }
                        },
                        cameo_profile: {
                            type: 'object',
                            properties: {
                                scene_purpose: { type: 'string', description: "Tier 3 only: the reason this utility role exists in the scene." },
                                casting_energy: { type: 'string', description: "Tier 3 only: fast casting/actor energy." },
                                playable_behavior: { type: 'string', description: "Tier 3 only: one active, playable behavior." },
                                line_style_example: { type: 'string', description: "Tier 3 only: a short line style / dialogue flavor note if useful." }
                            }
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

    const normalizedCurrentCharacters = normalizeCurrentCharacters(currentCharacters, normalizedTierOverrides);
    const fullRegenerationRequested = isFullCharacterRegenerationRequest(notes);
    const legacyModernizationNeeded = normalizedCurrentCharacters.length > 0 && needsCharacterModernization(normalizedCurrentCharacters);

    // Revision Bypass Logic
    if (notes && normalizedCurrentCharacters.length > 0 && !fullRegenerationRequested) {
        console.log("  Surgical Revision Mode: Updating characters...");
        const legacyInstruction = legacyModernizationNeeded
            ? '\n\nLEGACY MODERNIZATION: Some existing character records come from an older schema. Preserve their visible story intent, assign the appropriate profile_tier, and fill only the fields required by that tier. Tier 1 legacy records should receive the full psychological/voice/arc/_deep_profile treatment. Tier 2 records should receive functional_profile fields centered on narrative_function, emotional_truth, comic_or_tension_function, pressure_behavior, and voice_flavor. Tier 3 records should receive cameo_profile fields centered on scene_purpose, casting_energy, playable_behavior, and line_style_example. Do not preserve or invent wounds, lies, fears, psychological needs, moral needs, ticks, arcs, or personality typing for functional supporting or scene utility characters.'
            : '';
        const revisionSystemInstruction = `${charactersSOP}\n\nROLE: Surgical Casting Director. Apply the user's note ONLY to the specific character(s) mentioned in the feedback. Leave all other character profiles 100% identical to the provided JSON. Do not alter unmentioned traits. If the note describes or discusses a new character who is not in the existing list, create a tier-appropriate profile for them and add them to the cast. Maintain the exact same JSON schema.\n\nCRITICAL: Preserve the \`_deep_profile\` field exactly as provided for each character UNLESS the character is Tier 1 and the user's note specifically addresses personality typing, voice, behavioral patterns, or missing Tier 1 deep-profile data. Do not create or regenerate \`_deep_profile\` for Tier 2 or Tier 3 characters unless the writer explicitly asks for hidden drafting guidance for that minor character. If a Tier 1 character's core psychological traits (ghost_and_wound, the_lie, fear, desire, paradox) or voice tags change, regenerate their \`_deep_profile\` to stay consistent. If ANY Tier 1 character's core traits change, regenerate Tier 1 relationship_dynamics for all affected Tier 1 characters (relationships are bidirectional).${legacyInstruction}`;

        const sourceBlock = knowledgeContext ? `PROJECT SOURCE CANON:\n${knowledgeContext}\n\n` : '';
        const revisionPrompt = `${sourceBlock}USER NOTE: ${notes}

EXISTING CHARACTERS:
${JSON.stringify(normalizedCurrentCharacters, null, 2)}

Please apply the note surgically and return the full updated character list in JSON format.`;

        const response = await generateContentFn({
            model, geminiApiKey, anthropicApiKey,
            contents: [revisionPrompt],
            config: {
                systemInstruction: revisionSystemInstruction,
                temperature: 0.3,
                maxOutputTokens: 32000,
            },
            schema: characterSchema
        });

        const parsed = parseJsonWithRepair(response.text, { label: 'Stage 3 character revision response' });
        return {
            result: normalizeCharacterResult(
                applySurgicalCharacterMerge(normalizedCurrentCharacters, parsed, notes, { legacyModernizationNeeded, tierOverrides: normalizedTierOverrides }),
                normalizedTierOverrides,
                rawTierOverrides
            ),
            usage: response.usage
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
        schema: characterSchema
    });

    return { result: normalizeCharacterResult(parseJsonWithRepair(response.text, { label: 'Stage 3 character generation response' }), normalizedTierOverrides, rawTierOverrides), usage: response.usage };
};

module.exports = { agent3Characters };
