'use strict';

const TIER1_BACKSTORY_FIELDS = [
    ['Essential History', 'essential_history'],
    ['Formative Event', 'formative_event'],
    ['Relationship History', 'relationship_history'],
    ['Secret / Reveal', 'secret_or_reveal'],
    ['Onscreen Relevance', 'onscreen_relevance']
];

const TIER2_BACKSTORY_FIELDS = [
    ['Relevant History', 'relevant_history'],
    ['Why They Matter Now', 'why_they_matter_now']
];

const ALL_BACKSTORY_FIELDS = [
    ...TIER1_BACKSTORY_FIELDS,
    ...TIER2_BACKSTORY_FIELDS
];

function compactText(value = '', maxChars = 400) {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function isTier2(tier = '') {
    return /\b2\b|functional|supporting/i.test(String(tier || ''));
}

function isTier3(tier = '') {
    return /\b3\b|cameo|utility/i.test(String(tier || ''));
}

function hasMeaningfulBackstory(value) {
    if (!value) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value).some(entry => {
        if (entry == null) return false;
        if (typeof entry === 'object') return hasMeaningfulBackstory(entry);
        return String(entry).trim() !== '';
    });
}

function firstString(...values) {
    for (const value of values) {
        const text = String(value || '').trim();
        if (text) return text;
    }
    return '';
}

function normalizeCharacterBackstory(source, character = {}, tier = '') {
    const backstory = source == null ? character.backstory : source;
    const normalized = {};

    if (typeof backstory === 'string') {
        const text = backstory.trim();
        if (!text) return {};
        if (isTier2(tier) || isTier3(tier)) return { relevant_history: text };
        return { essential_history: text };
    }

    const raw = backstory && typeof backstory === 'object' && !Array.isArray(backstory)
        ? backstory
        : {};

    normalized.essential_history = firstString(raw.essential_history, raw.history, raw.summary, character.essential_history);
    normalized.formative_event = firstString(raw.formative_event, raw.formative_experience, character.formative_event);
    normalized.relationship_history = firstString(raw.relationship_history, raw.relationship_context, character.relationship_history);
    normalized.secret_or_reveal = firstString(raw.secret_or_reveal, raw.secret, raw.reveal, character.secret_or_reveal);
    normalized.onscreen_relevance = firstString(raw.onscreen_relevance, raw.present_day_relevance, raw.plot_relevance, character.onscreen_relevance);
    normalized.relevant_history = firstString(raw.relevant_history, raw.supporting_history, character.relevant_history);
    normalized.why_they_matter_now = firstString(raw.why_they_matter_now, raw.current_relevance, character.why_they_matter_now);

    return Object.entries(normalized).reduce((acc, [key, value]) => {
        const text = String(value || '').trim();
        if (text) acc[key] = text;
        return acc;
    }, {});
}

function backstoryFieldsForTier(tier = '') {
    if (isTier2(tier) || isTier3(tier)) return TIER2_BACKSTORY_FIELDS;
    return TIER1_BACKSTORY_FIELDS;
}

function orderedBackstoryFields(tier = '') {
    const primary = backstoryFieldsForTier(tier);
    const seen = new Set(primary.map(([, key]) => key));
    const extras = ALL_BACKSTORY_FIELDS.filter(([, key]) => !seen.has(key));
    return [...primary, ...extras];
}

function formatCharacterBackstory(backstory = {}, tier = '', { maxPerField = 280, separator = ' | ' } = {}) {
    const normalized = normalizeCharacterBackstory(backstory, { backstory }, tier);
    if (!hasMeaningfulBackstory(normalized)) return '';
    return orderedBackstoryFields(tier)
        .map(([label, key]) => normalized[key] ? `${label}: ${compactText(normalized[key], maxPerField)}` : '')
        .filter(Boolean)
        .join(separator);
}

module.exports = {
    ALL_BACKSTORY_FIELDS,
    TIER1_BACKSTORY_FIELDS,
    TIER2_BACKSTORY_FIELDS,
    backstoryFieldsForTier,
    formatCharacterBackstory,
    hasMeaningfulBackstory,
    normalizeCharacterBackstory
};
