'use strict';

const {
    hasMeaningfulBackstory,
    normalizeCharacterBackstory
} = require('./character_backstory');

const PROFILE_TIERS = {
    FULL: 'Tier 1',
    FUNCTIONAL: 'Tier 2',
    CAMEO: 'Tier 3'
};

function normalizeProjectCharacterName(value = '') {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u2019\u2018`]/g, "'")
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
        const cleanName = String(name || '').trim();
        const normalizedName = normalizeProjectCharacterName(cleanName);
        const normalizedTier = normalizeTierValue(tier);
        if (cleanName && normalizedName && normalizedTier) acc[normalizedName] = normalizedTier;
        return acc;
    }, {});
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
    const normalized = normalizeProjectCharacterName(name);
    if (!normalized) return null;
    return normalizeTierOverrides(tierOverrides)[normalized] || null;
}

function normalizeCharacterProfileTier(value = '', character = {}, tierOverrides = {}) {
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

function normalizeCharacterForPipeline(character = {}, tierOverrides = {}) {
    const core = character.psychological_core || {};
    const voice = character.voice_and_behavior || {};
    const ticks = character.ticks || {};
    const profile_tier = normalizeCharacterProfileTier(character.profile_tier, character, tierOverrides);
    const isFullProfile = profile_tier === PROFILE_TIERS.FULL;
    const backstory = normalizeCharacterBackstory(character.backstory, character, profile_tier);
    const normalized = {
        ...character,
        profile_tier,
        functional_profile: profile_tier === PROFILE_TIERS.FUNCTIONAL ? normalizeFunctionalProfile(character) : {},
        cameo_profile: profile_tier === PROFILE_TIERS.CAMEO ? normalizeCameoProfile(character) : {},
        psychological_core: isFullProfile ? {
            ghost_and_wound: core.ghost_and_wound || core.wound || core.ghost || '',
            the_lie: core.the_lie || core.false_belief || core.lie || '',
            fear: core.fear || '',
            desire: core.desire || '',
            psychological_need: core.psychological_need || core.need || '',
            moral_need: core.moral_need || '',
            paradox: core.paradox || voice.paradox || ''
        } : {},
        voice_and_behavior: isFullProfile ? {
            voice_tag: voice.voice_tag || '',
            pressure_tag: voice.pressure_tag || '',
            humor_tag: voice.humor_tag || '',
            speech_patterns: voice.speech_patterns || '',
            deflection_tactic: voice.deflection_tactic || ''
        } : {},
        arc: isFullProfile ? {
            core_drive: character.arc?.core_drive || '',
            direction: character.arc?.direction || 'Growth'
        } : {},
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

function normalizeCharactersForPipeline(characters = [], tierOverrides = {}) {
    const list = Array.isArray(characters)
        ? characters
        : (Array.isArray(characters?.characters) ? characters.characters : []);
    return list.map(character => normalizeCharacterForPipeline(character, tierOverrides));
}

function normalizeStage3CharactersForPipeline(stage3Characters = {}) {
    const characters = Array.isArray(stage3Characters)
        ? stage3Characters
        : (stage3Characters?.characters || []);
    const tierOverrides = Array.isArray(stage3Characters)
        ? {}
        : (stage3Characters?.tier_overrides || {});
    return normalizeCharactersForPipeline(characters, tierOverrides);
}

module.exports = {
    PROFILE_TIERS,
    hasMeaningfulProfileData,
    normalizeCharacterForPipeline,
    normalizeCharacterProfileTier,
    normalizeCharactersForPipeline,
    normalizeProjectCharacterName,
    normalizeStage3CharactersForPipeline,
    normalizeTierOverrides,
    normalizeTierValue,
    projectTierForCharacterName
};
