const { generateContent } = require('./ai-client');
const {
    buildMemorySourcePromptBlock,
    buildMemorySourceSystemInstruction
} = require('./memory_contract');
const fs = require('fs');
const path = require('path');

const TREATMENT_FIELDS = [
    {
        key: 'title_logline_characters',
        label: 'Title, Logline & Characters',
        scope: 'metadata, title, logline, and character summary'
    },
    {
        key: 'act_1',
        label: 'Act I',
        scope: 'Sequences 1 and 2'
    },
    {
        key: 'act_2a',
        label: 'Act II Part 1',
        scope: 'Sequences 3 and 4'
    },
    {
        key: 'act_2b',
        label: 'Act II Part 2',
        scope: 'Sequences 5 and 6'
    },
    {
        key: 'act_3',
        label: 'Act III',
        scope: 'Sequences 7 and 8'
    }
];

function compactText(value, maxChars = 4000) {
    const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '', null, 2);
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 120).trim()}\n\n[...truncated ${text.length - maxChars + 120} chars...]`;
}

function stripRevisionDelimiters(text) {
    return String(text || '')
        .replace(/<<<\s*TREATMENT_SECTION\s*/gi, '')
        .replace(/^\s*TREATMENT_SECTION\s*$/gim, '')
        .replace(/^\s*<\/?pageone_current_treatment_section>\s*$/gim, '')
        .trim();
}

function isInvalidTreatmentField(text) {
    const cleaned = stripRevisionDelimiters(text);
    if (!cleaned) return true;
    const compact = cleaned.replace(/[\s_-]+/g, '').toLowerCase();
    return compact === 'treatmentsection' || compact === 'pageonecurrenttreatmentsection';
}

function buildTitleLoglineCharacters(pitchData, charactersData) {
    const pitch = pitchData || {};
    const characters = Array.isArray(charactersData) ? charactersData : [];
    const lines = [];

    if (pitch.title) lines.push(`TITLE: ${pitch.title}`);
    if (pitch.genre) lines.push(`GENRE: ${pitch.genre}`);
    if (pitch.logline) lines.push(`LOGLINE: ${pitch.logline}`);
    if (pitch.core_theme) lines.push(`CORE THEME: ${pitch.core_theme}`);

    if (characters.length) {
        lines.push('CHARACTERS:');
        for (const character of characters) {
            const name = character.name || 'Unnamed Character';
            const summary = character.brief_summary || character.role || '';
            lines.push(summary ? `${name}: ${summary}` : name);
        }
    }

    return lines.join('\n');
}

function normalizeTreatment(treatment, pitchData, charactersData) {
    const normalized = TREATMENT_FIELDS.reduce((acc, field) => {
        acc[field.key] = typeof treatment?.[field.key] === 'string' ? treatment[field.key] : '';
        return acc;
    }, {});

    if (isInvalidTreatmentField(normalized.title_logline_characters)) {
        normalized.title_logline_characters = buildTitleLoglineCharacters(pitchData, charactersData);
    } else {
        normalized.title_logline_characters = stripRevisionDelimiters(normalized.title_logline_characters);
    }

    return normalized;
}

function extractSectionHeadings(text) {
    const headings = [];
    const regex = /\[SEQUENCE\s+(\d+)\s+START\][\s\S]*?^\s*SEQUENCE\s+\1\s*:\s*(.+?)\s*$/gim;
    let match;
    while ((match = regex.exec(text || '')) !== null) {
        headings.push(`Sequence ${match[1]}: ${match[2].trim()}`);
    }
    return headings.length ? headings.join('; ') : 'No sequence headers found';
}

function buildTreatmentSectionIndex(treatment) {
    return TREATMENT_FIELDS
        .map(field => `${field.label} (${field.scope}): ${extractSectionHeadings(treatment[field.key])}`)
        .join('\n');
}

function formatCharacterLock(character = {}) {
    const core = character.psychological_core || {};
    const voice = character.voice_and_behavior || {};
    const arc = character.arc || {};
    const deep = character._deep_profile || {};
    return [
        `${character.name || 'Unnamed Character'} (${character.role || 'role unknown'}): ${character.brief_summary || ''}`,
        core.desire ? `Want: ${core.desire}` : '',
        core.psychological_need || core.moral_need ? `Need: ${[core.psychological_need, core.moral_need].filter(Boolean).join(' / ')}` : '',
        core.ghost_and_wound ? `Wound: ${core.ghost_and_wound}` : '',
        arc.direction || arc.core_drive ? `Arc: ${[arc.direction, arc.core_drive].filter(Boolean).join(', ')}` : '',
        voice.voice_tag || voice.pressure_tag ? `Voice/pressure: ${[voice.voice_tag, voice.pressure_tag].filter(Boolean).join(', ')}` : '',
        deep.scene_behavior_predictions ? `Behavior prediction: ${compactText(deep.scene_behavior_predictions, 450)}` : ''
    ].filter(Boolean).join(' | ');
}

function formatBeatForContract(beat = {}, index = 0) {
    const label = beat.beat_name || beat.beat_label || beat.beat || `Beat ${index + 1}`;
    const action = beat.detailed_action || beat.description || '';
    const emotional = beat.emotional_arc ? ` Emotional arc: ${beat.emotional_arc}` : '';
    return `- ${label}: ${compactText(`${action}${emotional}`, 900)}`;
}

function buildTreatmentExpansionContract({ pitchData, charactersData, beatsData }) {
    const pitch = compactText(JSON.stringify(pitchData || {}, null, 2), 2400);
    const characters = Array.isArray(charactersData) && charactersData.length
        ? charactersData.map(formatCharacterLock).join('\n')
        : 'No character profiles provided.';
    const beatMap = Array.isArray(beatsData) && beatsData.length
        ? beatsData.map(sequence => {
            const sequenceNumber = sequence.sequence_number || sequence.sequence || '?';
            const title = sequence.sequence_title || sequence.sequence_number_and_title || `Sequence ${sequenceNumber}`;
            const beats = Array.isArray(sequence.beats)
                ? sequence.beats.map(formatBeatForContract).join('\n')
                : compactText(JSON.stringify(sequence, null, 2), 1200);
            return `Sequence ${sequenceNumber}: ${title}\n${beats}`;
        }).join('\n\n')
        : 'No beat sheet provided.';

    return compactText(`## APPROVED FULL-STORY TREATMENT CONTRACT
Stage 5 is an expansion pass. Be cinematic and specific inside the approved beat sheet, but do not rewrite the story architecture.

### Locked Inputs
Preserve the approved pitch, all named character functions, relationship logic, sequence order, causality, reveals, recurring props, rules, deaths/survival states, family counts, and payoffs established below unless the writer's current notes explicitly change them.

### Creative Latitude
You may add connective tissue, physical action, scene texture, emotional transitions, and subtextual behavior that make the beats read like a treatment. These additions must support the approved sequence, not replace or relocate it.

### Approved Pitch
${pitch}

### Character Locks
${characters}

### Global 8-Sequence Beat Map
Use this full-story map for continuity in every act call. Expand only the target sequences, but preserve setup/payoff logic from the whole map.
${beatMap}

### Fidelity Check
- Do not move a beat into another sequence.
- Do not drop a named reveal, gag, prop path, rule, relationship turn, or endpoint.
- Do not solve local story pressure by inventing a new mechanic that was not in the approved pitch, characters, beat sheet, source packet, or writer notes.
- If the local target section and global map appear to conflict, preserve the most specific approved beat/character fact and keep the output conservative.`, 14_000);
}

function formatPriorGeneratedContext(parts = [], maxChars = 18_000) {
    return compactText(parts.filter(Boolean).join('\n\n'), maxChars);
}

function selectTreatmentFieldsForRevision(notes) {
    const text = String(notes || '');
    const lower = text.toLowerCase();
    const selected = new Set();

    if (/\b(title|logline|character summary|characters section)\b/i.test(text)) {
        selected.add('title_logline_characters');
    }

    if (/\b(act\s*i\b|act\s*1\b)/i.test(text)) selected.add('act_1');
    if (/\b(act\s*iia\b|act\s*ii\s*(part\s*)?1\b|act\s*2a\b)/i.test(text)) selected.add('act_2a');
    if (/\b(act\s*iib\b|act\s*ii\s*(part\s*)?2\b|act\s*2b\b)/i.test(text)) selected.add('act_2b');
    if (/\b(act\s*iii\b|act\s*3\b)/i.test(text)) selected.add('act_3');

    const sequenceMatches = text.matchAll(/\b(?:sequence|seq\.?|s)\s*#?\s*([1-8])\b/gi);
    for (const match of sequenceMatches) {
        const sequenceNumber = Number(match[1]);
        if (sequenceNumber <= 2) selected.add('act_1');
        else if (sequenceNumber <= 4) selected.add('act_2a');
        else if (sequenceNumber <= 6) selected.add('act_2b');
        else selected.add('act_3');
    }

    const globalRevision = /\b(throughout|whole treatment|full treatment|entire treatment|all acts|every act|all sequences|every sequence)\b/i.test(lower);
    if (globalRevision || selected.size === 0) return TREATMENT_FIELDS;

    return TREATMENT_FIELDS.filter(field => selected.has(field.key));
}

/**
 * Stage 5 Treatment Agent (Chained Prompt Architecture)
 * Transform pitch, characters, and 8-sequence beats into a granular 4-act treatment.
 * Uses 4 sequential generateContent() calls to build the treatment piece by piece.
 */
const agent5Treatment = async (pitchData, charactersData, beatsData, currentTreatment = null, notes = null, onProgress = null, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = '',
        generateContentFn = generateContent
    } = modelConfig;

    const skillPath = path.join(__dirname, '../skills/skill_stage5_treatment.md');
    const treatmentSOP = fs.readFileSync(skillPath, 'utf8');

    const systemInstruction = buildMemorySourceSystemInstruction(treatmentSOP, 'Stage 5 Treatment');

    const treatmentSchema = {
        type: 'object',
        properties: {
            title_logline_characters: { type: 'string' },
            act_1: { type: 'string' },
            act_2a: { type: 'string' },
            act_2b: { type: 'string' },
            act_3: { type: 'string' }
        },
        required: ['title_logline_characters', 'act_1', 'act_2a', 'act_2b', 'act_3']
    };

    const baseConfig = {
        systemInstruction,
        temperature: 0.5,
    };
    const sourceBlock = buildMemorySourcePromptBlock(knowledgeContext, 'Stage 5 Treatment');
    const treatmentContract = buildTreatmentExpansionContract({ pitchData, charactersData, beatsData });
    const generationContext = [sourceBlock, treatmentContract].filter(Boolean).join('\n\n');

    // Revision Bypass Logic
    if (notes && currentTreatment) {
        console.log("  Surgical Revision Mode: Applying user notes...");
        const revisedTreatment = normalizeTreatment(currentTreatment, pitchData, charactersData);
        const sectionIndex = buildTreatmentSectionIndex(revisedTreatment);
        const fieldsToRevise = selectTreatmentFieldsForRevision(notes);
        const usageList = [];

        const revisionSystemInstruction = `${systemInstruction}

ROLE: Surgical Script Editor.
You are revising ONE treatment section at a time. Apply the user's notes only when they are relevant to the target section. Do not rewrite or alter plot points, character names, pacing, sequence tags, or formatting outside the scope of the notes. If the notes apply to another section, return this target section unchanged. The JSON response schema overrides the SOP output template; the SOP formatting rules apply only to the text inside "revised_text".`;

        const sectionSchema = {
            type: 'object',
            properties: {
                revised_text: {
                    type: 'string',
                    description: 'The complete revised text for the target treatment section, preserving sequence tags and formatting.'
                }
            },
            required: ['revised_text']
        };

        for (let i = 0; i < fieldsToRevise.length; i++) {
            const field = fieldsToRevise[i];
            const originalText = revisedTreatment[field.key];
            if (onProgress) onProgress(i + 1, fieldsToRevise.length, `Revising ${field.label}...`);

            const revisionPrompt = `${generationContext}

USER NOTES:
${notes}

FULL TREATMENT SECTION INDEX:
${sectionIndex}

TARGET SECTION:
${field.label} (${field.scope})

CURRENT TARGET SECTION TEXT:
<pageone_current_treatment_section>
${originalText}
</pageone_current_treatment_section>

Return the complete target section after applying only the relevant notes. Preserve all unaffected prose exactly. Preserve [SEQUENCE N START] and [SEQUENCE N END] tags exactly. Do not include the <pageone_current_treatment_section> markers in revised_text. Return JSON only with the key "revised_text".`;

            let lastError;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const result = await generateContentFn({
                        model, geminiApiKey, anthropicApiKey,
                        contents: [revisionPrompt],
                        config: {
                            systemInstruction: revisionSystemInstruction,
                            temperature: 0.2,
                            maxOutputTokens: 20000,
                        },
                        schema: sectionSchema
                    });

                    const parsed = JSON.parse(result.text);
                    if (typeof parsed.revised_text !== 'string') {
                        throw new Error(`Revision for ${field.label} did not return revised_text`);
                    }

                    const revisedText = stripRevisionDelimiters(parsed.revised_text);
                    if (isInvalidTreatmentField(revisedText)) {
                        console.warn(`  ${field.label} revision returned delimiter-only text; preserving existing section.`);
                    } else {
                        revisedTreatment[field.key] = revisedText;
                    }
                    usageList.push(result.usage);
                    lastError = null;
                    break;
                } catch (err) {
                    lastError = err;
                    if (attempt < 3) {
                        console.warn(`  ${field.label} revision attempt ${attempt} failed: ${err.message}. Retrying...`);
                        await new Promise(r => setTimeout(r, attempt * 2000));
                    }
                }
            }

            if (lastError) {
                throw new Error(`Failed to revise ${field.label}: ${lastError.message}`);
            }
        }

        return { result: revisedTreatment, usageList };
    }

    // Step 1: Title/Logline/Characters + Act I (Sequences 1 & 2)
    console.log("  Chain Step 1/4: Writing Title, Logline, Characters & Act I...");
    if (onProgress) onProgress(1, 4, 'Writing Act I (Sequences 1–2)...');
    const step1Prompt = `${generationContext}

Read Sequences 1 & 2. You must systematically expand EVERY SINGLE BEAT (Opening Image, Theme Stated, Setup, Catalyst, Debate) into full, multi-paragraph narrative prose. Do not skip any beats. Do not compress the timeline.

PITCH: ${JSON.stringify(pitchData)}
CHARACTERS: ${JSON.stringify(charactersData)}
BEATS (Sequences 1-2): ${JSON.stringify(beatsData.filter(s => s.sequence_number <= 2))}

Return JSON with ONLY 'title_logline_characters' and 'act_1' populated. Leave others empty.`;

    const usageList = [];

    const result1 = await generateContentFn({
        model, geminiApiKey, anthropicApiKey,
        contents: [step1Prompt],
        config: baseConfig,
        schema: treatmentSchema
    });
    usageList.push(result1.usage);
    const parsed1 = JSON.parse(result1.text);

    // Step 2: Act IIA (Sequences 3 & 4)
    console.log("  Chain Step 2/4: Writing Act II (Part 1)...");
    if (onProgress) onProgress(2, 4, 'Writing Act II – Part 1 (Sequences 3–4)...');
    const step2Prompt = `${generationContext}

Read Sequences 3 & 4. You must systematically expand EVERY SINGLE BEAT (Break into Two, B-Story, Fun and Games) into full, multi-paragraph narrative prose. Describe the micro-actions.

PRIOR GENERATED CONTEXT (Sequences 1-2, for continuity only):
${formatPriorGeneratedContext([parsed1.title_logline_characters, parsed1.act_1])}

BEATS (Sequences 3-4): ${JSON.stringify(beatsData.filter(s => s.sequence_number === 3 || s.sequence_number === 4))}

Return JSON with ONLY the 'act_2a' field populated. Leave others empty.`;

    const result2 = await generateContentFn({
        model, geminiApiKey, anthropicApiKey,
        contents: [step2Prompt],
        config: baseConfig,
        schema: treatmentSchema
    });
    usageList.push(result2.usage);
    const parsed2 = JSON.parse(result2.text);

    // Step 3: Act IIB (Sequences 5 & 6)
    console.log("  Chain Step 3/4: Writing Act II (Part 2)...");
    if (onProgress) onProgress(3, 4, 'Writing Act II – Part 2 (Sequences 5–6)...');
    const step3Prompt = `${generationContext}

Read Sequences 5 & 6. You must systematically expand EVERY SINGLE BEAT (Bad Guys Close In, All is Lost, Dark Night of the Soul) into full, multi-paragraph narrative prose. Maximize the emotional toll and physical stakes.

PRIOR GENERATED CONTEXT (Sequences 1-4, for continuity only):
${formatPriorGeneratedContext([parsed1.title_logline_characters, parsed1.act_1, parsed2.act_2a])}

BEATS (Sequences 5-6): ${JSON.stringify(beatsData.filter(s => s.sequence_number === 5 || s.sequence_number === 6))}

Return JSON with ONLY the 'act_2b' field populated. Leave others empty.`;

    const result3 = await generateContentFn({
        model, geminiApiKey, anthropicApiKey,
        contents: [step3Prompt],
        config: baseConfig,
        schema: treatmentSchema
    });
    usageList.push(result3.usage);
    const parsed3 = JSON.parse(result3.text);

    // Step 4: Act III (Sequences 7 & 8)
    console.log("  Chain Step 4/4: Writing Act III...");
    if (onProgress) onProgress(4, 4, 'Writing Act III (Sequences 7–8)...');
    const step4Prompt = `${generationContext}

Read Sequences 7 & 8. You must systematically expand EVERY SINGLE BEAT (Break into Three, Finale, Final Image) into full, multi-paragraph narrative prose. Describe the climax beat-by-beat.

PRIOR GENERATED CONTEXT (Sequences 1-6, for continuity only):
${formatPriorGeneratedContext([parsed1.title_logline_characters, parsed1.act_1, parsed2.act_2a, parsed3.act_2b])}

BEATS (Sequences 7-8): ${JSON.stringify(beatsData.filter(s => s.sequence_number === 7 || s.sequence_number === 8))}

Return JSON with ONLY the 'act_3' field populated. Leave others empty.`;

    const result4 = await generateContentFn({
        model, geminiApiKey, anthropicApiKey,
        contents: [step4Prompt],
        config: baseConfig,
        schema: treatmentSchema
    });
    usageList.push(result4.usage);
    const finalParsed = JSON.parse(result4.text);

    return {
        result: {
            title_logline_characters: parsed1.title_logline_characters,
            act_1: parsed1.act_1,
            act_2a: parsed2.act_2a,
            act_2b: parsed3.act_2b,
            act_3: finalParsed.act_3
        },
        usageList
    };
};

module.exports = { agent5Treatment };
