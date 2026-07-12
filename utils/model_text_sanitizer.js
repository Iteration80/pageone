/**
 * model_text_sanitizer.js — strips model meta-narration from generated text fields.
 *
 * Motivation (2026-07-12 incident): a saved Stage 3 character field contained raw
 * Gemini self-correction narration — `... survival सामुद्रिक . (Note: Removed spurious
 * text, keeping original: ...) Wait, correcting to original: ... Actually, I will just
 * copy exactly: "..."` — persisted into project data and exported to DOCX. These
 * patterns are model process-talk, never legitimate story content.
 *
 * Rules are deliberately conservative: they target narration *about the writing
 * process*, not story text. Legitimate parentheticals like "(42)", "(V.O.)" or
 * "(beat)" are untouched.
 */

// Parentheticals that narrate the model's own editing process.
const NARRATION_PARENTHETICAL = /\s*\((?:Note|Self-correction|Correction|Correcting|Fixed)\b[^)]*\)/gi;

// Sentences of model self-talk. Each alternative is anchored on phrasing that only
// appears when a model narrates its own output ("Wait, correcting…", "Actually, I
// will just copy exactly: …", "Let me correct…", "Self-correction: …").
const NARRATION_SENTENCES = [
    /(?:^|\s)Wait,\s*correct\w*[^.!?\n]*[.!?:]*\s*/gi,
    /(?:^|\s)Actually,\s*I\s+will\s+just\s+copy[^.!?\n]*[.!?:]*\s*/gi,
    /(?:^|\s)Let\s+me\s+correct[^.!?\n]*[.!?:]*\s*/gi,
    /(?:^|\s)Self-correction:[^.!?\n]*[.!?:]*\s*/gi,
    /(?:^|\s)Just\s+copy\s+exactly[^.!?\n]*[.!?:]*\s*/gi
];

// Gemini glitch tokens: an isolated run of Devanagari dropped into otherwise-Latin
// text (observed: "सामुद्रिक"). Only stripped when the string is overwhelmingly
// Latin, so legitimate non-Latin content (names, dialogue) is never touched.
const DEVANAGARI_TOKEN = /\s?[ऀ-ॿ]{1,16}\s?/g;

function latinRatio(text) {
    const letters = text.replace(/[^\p{L}]/gu, '');
    if (!letters.length) return 1;
    const latin = letters.replace(/[^\p{Script=Latin}]/gu, '');
    return latin.length / letters.length;
}

function stripModelNarration(value) {
    if (typeof value !== 'string' || !value) return value;
    let text = value;
    text = text.replace(NARRATION_PARENTHETICAL, ' ');
    for (const pattern of NARRATION_SENTENCES) {
        text = text.replace(pattern, ' ');
    }
    if (latinRatio(text) > 0.9) {
        text = text.replace(DEVANAGARI_TOKEN, ' ');
    }
    // Collapse whitespace artifacts left by removals ("survival  ." → "survival.")
    text = text.replace(/\s+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
    return text;
}

/** Recursively sanitize every string value in an object/array (returns a copy). */
function sanitizeStringsDeep(value) {
    if (typeof value === 'string') return stripModelNarration(value);
    if (Array.isArray(value)) return value.map(sanitizeStringsDeep);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = sanitizeStringsDeep(v);
        return out;
    }
    return value;
}

module.exports = { stripModelNarration, sanitizeStringsDeep };
