const { generateContent } = require('./ai-client');
const { parseJsonWithRepair } = require('./json_parse');
const fs = require('fs');
const path = require('path');

function normalizeOutlineInput(outline) {
    if (!outline || typeof outline !== 'object') return null;
    if (outline.outline && typeof outline.outline === 'object' && !Array.isArray(outline.outline)) {
        return outline.outline;
    }
    return outline;
}

function outlineHasContent(outline) {
    const normalized = normalizeOutlineInput(outline);
    if (!normalized) return false;

    const acts = [normalized.act_1, normalized.act_2, normalized.act_3];
    return acts.some(act => Array.isArray(act) && act.some(sequence => {
        if (!sequence || typeof sequence !== 'object') return false;
        if (String(sequence.sequence_number_and_title || '').trim()) return true;
        const beats = Array.isArray(sequence.beats) ? sequence.beats : [];
        return beats.some(beat => (
            String(beat?.beat_label || '').trim() ||
            String(beat?.beat || '').trim() ||
            String(beat?.description || '').trim()
        ));
    }));
}

function combineUsage(...usages) {
    const valid = usages.filter(Boolean);
    if (!valid.length) return undefined;
    return valid.reduce((acc, usage) => ({
        model: usage.model || acc.model,
        inputTokens: (acc.inputTokens || 0) + (usage.inputTokens || 0),
        outputTokens: (acc.outputTokens || 0) + (usage.outputTokens || 0)
    }), { model: valid[0].model, inputTokens: 0, outputTokens: 0 });
}

function isTransientAiError(error) {
    const code = String(error?.code || error?.cause?.code || '');
    if (/ECONNRESET|ETIMEDOUT|UND_ERR|EPIPE|ECONNREFUSED/i.test(code)) return true;
    const message = String(error?.message || error || '');
    return /terminated|socket|network|fetch failed|aborted|timeout|temporarily unavailable/i.test(message);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function compactText(value, maxChars = 900) {
    const text = typeof value === 'string' ? value.trim() : JSON.stringify(value ?? '', null, 2);
    if (!text || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 80).trim()} [...truncated]`;
}

function latestConcreteRevisionText(notes = '') {
    const text = String(notes || '').trim();
    const sectionPattern = /LATEST USER REQUEST:\r?\n([\s\S]*?)(?=\r?\n\r?\n(?:USER REQUESTS|RECENT ASSISTANT CONTEXT|RECENT CONVERSATION CONTEXT|ASSISTANT DIRECTION):|$)/g;
    const matches = Array.from(text.matchAll(sectionPattern));
    const latest = matches.length ? matches[matches.length - 1][1] : '';
    let extracted = (latest || '').trim();

    if (!extracted && /RECENT CONVERSATION CONTEXT:/i.test(text)) {
        const recent = text.split(/RECENT CONVERSATION CONTEXT:\r?\n/i).pop() || '';
        const userMatches = Array.from(recent.matchAll(/(?:^|\n)USER:\r?\n([\s\S]*?)(?=\r?\n\r?\n---\r?\n\r?\n(?:USER|ASSISTANT):|$)/g));
        extracted = (userMatches.length ? userMatches[userMatches.length - 1][1] : '').trim();
    }

    if (!extracted && !/(?:USER REQUESTS|RECENT ASSISTANT CONTEXT|RECENT CONVERSATION CONTEXT|ASSISTANT DIRECTION):/i.test(text)) {
        extracted = text;
    }

    if (extracted && !/^(yes|yep|yeah|sure|ok|okay|go ahead|do it|apply|revise|sounds good)[\s.!]*$/i.test(extracted)) {
        return extracted;
    }
    const direction = text.match(/ASSISTANT DIRECTION:\n([\s\S]*)$/);
    return (direction ? direction[1] : extracted || text).trim();
}

function looksLikeChecklistHeader(line = '') {
    const clean = String(line || '').trim();
    if (!clean || clean.length > 90) return false;
    if (/[.!?]$/.test(clean)) return false;
    if (/^(stuff to restore|things to restore|recommended|next move|on it|understood|user requests|assistant direction)$/i.test(clean)) return false;
    return /\b(restore|aftermath|closing|image|coda|finale|surrender|setup|payoff|beat|scene|ending|origin|canon)\b/i.test(clean)
        || /^[A-Z][A-Za-z0-9' -]{2,}$/.test(clean);
}

function buildRevisionChecklist(notes = '', maxItems = 12) {
    const text = latestConcreteRevisionText(notes);
    if (!text) return [];
    if (!/\n/.test(text)) {
        return /\b(kitchen|closing image|final image|photo|breakfast|visitor pass|visitor passes|surrender|aftermath|restore)\b/i.test(text)
            && text.length > 40
            ? [compactText(text, 800)]
            : [];
    }

    const blocks = text
        .split(/\n\s*\n/)
        .map(block => block.trim())
        .filter(Boolean);
    const items = [];

    for (const block of blocks) {
        const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!lines.length) continue;

        for (const line of lines) {
            const bullet = line.match(/^(?:[-*]|\d+[.)])\s+(.+)/);
            if (bullet && bullet[1].length > 18) items.push(compactText(bullet[1], 700));
        }

        if (lines.length >= 2 && looksLikeChecklistHeader(lines[0])) {
            const body = lines.slice(1).join(' ');
            if (body.length > 20) items.push(compactText(`${lines[0]}: ${body}`, 800));
        }
        if (items.length >= maxItems) break;
    }

    return Array.from(new Set(items)).slice(0, maxItems);
}

const CHECKLIST_STOPWORDS = new Set([
    'about', 'above', 'absolutely', 'across', 'after', 'again', 'also', 'because', 'before', 'being',
    'both', 'chunk', 'chunks', 'doing', 'ensure', 'every', 'final', 'from', 'have', 'image', 'into',
    'keeps', 'last', 'lets', 'more', 'much', 'needs', 'note', 'old', 'only', 'outline', 'real',
    'missing', 'please', 'restore', 'restoring', 'should', 'specific', 'still', 'that', 'their', 'there', 'these', 'thing',
    'three', 'through', 'visible', 'with', 'work', 'would'
]);

function checklistTerms(item = '') {
    const normalized = String(item || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ');
    return Array.from(new Set(normalized.split(/\s+/)
        .map(token => token.replace(/^'+|'+$/g, ''))
        .filter(token => token.length >= 4 && !CHECKLIST_STOPWORDS.has(token))));
}

function outlineCoverageUnits(outlineResult = {}) {
    const outline = outlineResult?.outline || outlineResult || {};
    const acts = [outline.act_1, outline.act_2, outline.act_3].filter(Array.isArray);
    const beatUnits = [];
    const sequenceUnits = [];

    for (const act of acts) {
        for (const sequence of act) {
            if (!sequence || typeof sequence !== 'object') continue;
            const sequenceTitle = sequence.sequence_number_and_title || '';
            const beatTexts = [];
            for (const beat of sequence.beats || []) {
                const text = [
                    sequenceTitle,
                    beat?.beat_label || beat?.beat || '',
                    beat?.description || ''
                ].join(' ').toLowerCase();
                if (text.trim()) {
                    beatUnits.push(text);
                    beatTexts.push(text);
                }
            }
            const sequenceText = [sequenceTitle, ...beatTexts].join(' ').toLowerCase();
            if (sequenceText.trim()) sequenceUnits.push(sequenceText);
        }
    }

    return { beatUnits, sequenceUnits };
}

function requiresBeatLevelCoverage(item = '') {
    return /\b(kitchen|closing image|final image|photo|breakfast|visitor pass|visitor passes|framed in the light)\b/i.test(item);
}

function unitCoversChecklistItem(unit = '', terms = [], item = '') {
    if (!terms.length) return true;
    const found = terms.filter(term => unit.includes(term)).length;
    const required = requiresBeatLevelCoverage(item)
        ? Math.min(8, Math.max(4, Math.ceil(terms.length * 0.55)))
        : Math.min(7, Math.max(3, Math.ceil(terms.length * 0.45)));
    return found >= required;
}

function findUndercoveredChecklistItems(checklist = [], outlineResult = {}) {
    if (!checklist.length) return [];
    const { beatUnits, sequenceUnits } = outlineCoverageUnits(outlineResult);
    return checklist.filter(item => {
        const terms = checklistTerms(item);
        if (terms.length < 4) return false;
        const units = requiresBeatLevelCoverage(item) ? beatUnits : beatUnits.concat(sequenceUnits);
        return !units.some(unit => unitCoversChecklistItem(unit, terms, item));
    });
}

function titleCaseLabel(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s'-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 7)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ') || 'Restored Beat';
}

function beatLabelForChecklistItem(item = '') {
    const text = String(item || '');
    if (/\b(?:kitchen|itchen|closing image|final image|photo|breakfast|visitor passes?)\b/i.test(text)) {
        return 'Kitchen Closing Image';
    }
    const colon = text.match(/^([^:]{4,80}):/);
    if (colon) return titleCaseLabel(colon[1]);
    return titleCaseLabel(text);
}

function beatDescriptionForChecklistItem(item = '') {
    let text = String(item || '')
        .replace(/\s*-->[\s\S]*$/g, '')
        .replace(/\bthis is still missing\b[\s\S]*$/i, '')
        .replace(/\bplease restore\.?$/i, '')
        .trim();

    const colon = text.match(/^[^:]{4,80}:\s*([\s\S]+)$/);
    if (colon?.[1]) text = colon[1].trim();

    const photoIndex = text.search(/\bphoto\b/i);
    if (photoIndex > 0 && /\b(?:kitchen|itchen|closing image|final image)\b/i.test(item)) {
        text = text.slice(photoIndex).trim();
    }
    if (/^photo of\b/i.test(text)) text = text.replace(/^photo of/i, 'a photo of');
    if (/\b(?:kitchen|itchen|closing image)\b/i.test(item) && !/^in the kitchen\b/i.test(text)) {
        text = `In the kitchen, ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    }
    if (text && !/[.!?]$/.test(text)) text += '.';
    return text || compactText(item, 800);
}

function finalOutlineSequence(outline = {}, item = '') {
    const acts = [outline.act_3, outline.act_2, outline.act_1].filter(Array.isArray);
    for (const act of acts) {
        if (!act.length) continue;
        const explicitH = act.find(sequence => /sequence\s*h\b/i.test(sequence?.sequence_number_and_title || ''));
        if (explicitH && /\b(?:sequence\s*h|closing|final|coda|ending|kitchen|photo|breakfast|visitor passes?)\b/i.test(item)) {
            return explicitH;
        }
        return act[act.length - 1];
    }
    outline.act_3 = [{ sequence_number_and_title: 'Sequence H: Resolution', beats: [] }];
    return outline.act_3[0];
}

function appendMissingChecklistBeats(outlineResult = {}, missingItems = []) {
    if (!missingItems.length) return outlineResult;
    const outline = outlineResult?.outline || outlineResult || {};
    if (!outline.act_1) outline.act_1 = [];
    if (!outline.act_2) outline.act_2 = [];
    if (!outline.act_3) outline.act_3 = [];

    for (const item of missingItems) {
        const sequence = finalOutlineSequence(outline, item);
        if (!Array.isArray(sequence.beats)) sequence.beats = [];
        sequence.beats.push({
            beat_label: beatLabelForChecklistItem(item),
            description: beatDescriptionForChecklistItem(item)
        });
    }
    return outlineResult;
}

async function callOutlineModel(generateContentFn, request, { label = 'Stage 2 outline call', retries = 2, delayMs = 750 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await generateContentFn(request);
        } catch (error) {
            lastError = error;
            const message = error.message || String(error);
            if (!isTransientAiError(error)) throw error;
            if (attempt >= retries) {
                const finalError = new Error(`${label} failed after ${attempt + 1} attempts: ${message}`);
                finalError.cause = error;
                throw finalError;
            }
            console.warn(`${label} failed with transient error "${message}". Retrying (${attempt + 1}/${retries})...`);
            if (delayMs > 0) await wait(delayMs * (attempt + 1));
        }
    }
    throw lastError;
}

async function parseOutlineResponse(response, {
    outlineSchema,
    generateContentFn,
    model,
    geminiApiKey,
    anthropicApiKey,
    retryDelayMs
}) {
    try {
        return {
            result: parseJsonWithRepair(response.text, { schema: outlineSchema, label: 'Stage 2 outline response' }),
            usage: response.usage
        };
    } catch (parseError) {
        console.warn(`Stage 2 outline JSON repair failed locally; retrying with model repair: ${parseError.message}`);
        const repairResponse = await callOutlineModel(generateContentFn, {
            model,
            geminiApiKey,
            anthropicApiKey,
            contents: [`The text below was intended to be a complete Stage 2 outline JSON object, but it contains JSON syntax errors such as an unterminated string, missing comma, or unescaped quote.

Repair ONLY the JSON syntax. Preserve every available story detail, field name, act, sequence, beat label, and beat description. If a string is cut off, close it cleanly without inventing new plot. Return valid JSON only.

MALFORMED JSON:
${response.text}`],
            config: {
                systemInstruction: 'You are a strict JSON repair tool. Return only valid JSON conforming to the provided schema. Do not add commentary, markdown, or new story content.',
                temperature: 0,
                maxOutputTokens: 32000
            },
            schema: outlineSchema
        }, {
            label: 'Stage 2 outline JSON repair',
            retries: 2,
            delayMs: retryDelayMs
        });

        try {
            return {
                result: parseJsonWithRepair(repairResponse.text, { schema: outlineSchema, label: 'Stage 2 repaired outline response' }),
                usage: combineUsage(response.usage, repairResponse.usage)
            };
        } catch (repairError) {
            const error = new Error(`Stage 2 outline response could not be repaired after retry: ${repairError.message}`);
            error.cause = parseError;
            throw error;
        }
    }
}

const agent2Outline = async (pitchData, currentOutline, notes, pdfFile, modelConfig = {}) => {
    const {
        model = process.env.GEMINI_MODEL,
        geminiApiKey = process.env.GEMINI_API_KEY,
        anthropicApiKey = process.env.ANTHROPIC_API_KEY,
        knowledgeContext = '',
        generateContentFn = generateContent,
        retryDelayMs = 750
    } = modelConfig;
    const hasCurrentOutline = outlineHasContent(currentOutline);

    const skillPath = path.join(__dirname, '../skills/skill_stage2_outline.md');
    const outlineSOP = fs.readFileSync(skillPath, 'utf8');

    const beatItemSchema = {
        type: 'object',
        properties: {
            beat_label: { type: 'string' },
            description: { type: 'string' }
        },
        required: ["beat_label", "description"]
    };

    const sequenceItemSchema = {
        type: 'object',
        properties: {
            sequence_number_and_title: { type: 'string' },
            beats: {
                type: 'array',
                items: beatItemSchema
            }
        },
        required: ["sequence_number_and_title", "beats"]
    };

    const outlineSchema = {
        type: 'object',
        properties: {
            title: { type: 'string' },
            genre: { type: 'string' },
            logline: { type: 'string' },
            outline: {
                type: 'object',
                properties: {
                    act_1: { type: 'array', items: sequenceItemSchema },
                    act_2: { type: 'array', items: sequenceItemSchema },
                    act_3: { type: 'array', items: sequenceItemSchema }
                },
                required: ["act_1", "act_2", "act_3"]
            }
        },
        required: ["title", "genre", "logline", "outline"]
    };

    // Revision Bypass Logic
    if (notes && hasCurrentOutline) {
        console.log("  Surgical Revision Mode: Updating outline...");
        const revisionSystemInstruction = `${outlineSOP}\n\nROLE: Structural Story Analyst. Apply the user's note to the existing 8-sequence outline. You MUST keep unaffected sequences 100% identical to the current draft. HOWEVER, if the user's note creates a logical narrative ripple effect (e.g., changing the Midpoint changes the Finale), you are authorized to update subsequent sequences so the story's cause-and-effect makes logical sense. Maintain the exact same JSON schema.`;

        const sourceBlock = knowledgeContext ? `PROJECT SOURCE CANON:\n${knowledgeContext}\n\n` : '';
        const activeRevisionRequest = latestConcreteRevisionText(notes);
        const revisionChecklist = buildRevisionChecklist(notes);
        const checklistBlock = revisionChecklist.length
            ? `\nREVISION CHECKLIST:\nTreat each item below as a concrete obligation. It must be visibly present in the revised outline, unless the current outline already contains it.\n${revisionChecklist.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n`
            : '';
        const backgroundNotes = activeRevisionRequest && notes && activeRevisionRequest !== String(notes).trim()
            ? `\nBACKGROUND CONVERSATION NOTES (context only; do not treat older requests here as required unless repeated in the active request):\n${compactText(notes, 5000)}\n`
            : '';
        const revisionPrompt = `${sourceBlock}ACTIVE REVISION REQUEST:
${activeRevisionRequest || notes}
${checklistBlock}
${backgroundNotes}

EXISTING OUTLINE:
${JSON.stringify(currentOutline, null, 2)}

Please apply the note surgically (allowing for ripple effects) and return the full updated outline in JSON format.`;

        const response = await callOutlineModel(generateContentFn, {
            model, geminiApiKey, anthropicApiKey,
            contents: [revisionPrompt],
            config: {
                systemInstruction: revisionSystemInstruction,
                temperature: 0.5,
            },
            schema: outlineSchema
        }, {
            label: 'Stage 2 outline revision',
            retries: 2,
            delayMs: retryDelayMs
        });

        let parsed = await parseOutlineResponse(response, {
            outlineSchema,
            generateContentFn,
            model,
            geminiApiKey,
            anthropicApiKey,
            retryDelayMs
        });

        let missingChecklistItems = findUndercoveredChecklistItems(revisionChecklist, parsed.result);
        if (missingChecklistItems.length) {
            const repairPrompt = `${sourceBlock}MANDATORY CHECKLIST REPAIR:
The previous outline revision changed the file, but it still appears to omit or underrepresent concrete requested checklist items.

MISSING OR UNDERREPRESENTED CHECKLIST ITEMS:
${missingChecklistItems.map((item, index) => `${index + 1}. ${item}`).join('\n')}

ORIGINAL USER NOTE:
${activeRevisionRequest || notes}

EXISTING OUTLINE BEFORE REVISION:
${JSON.stringify(currentOutline, null, 2)}

PREVIOUS REVISED OUTLINE:
${JSON.stringify(parsed.result?.outline || parsed.result || {}, null, 2)}

Revise the outline again. Add or adjust the minimum necessary beats so every missing checklist item is visibly present in the outline. Keep unrelated sequences and beats unchanged. Return the full Stage 2 outline JSON.`;

            const repairResponse = await callOutlineModel(generateContentFn, {
                model, geminiApiKey, anthropicApiKey,
                contents: [repairPrompt],
                config: {
                    systemInstruction: revisionSystemInstruction,
                    temperature: 0.35,
                },
                schema: outlineSchema
            }, {
                label: 'Stage 2 outline checklist repair',
                retries: 2,
                delayMs: retryDelayMs
            });

            const repaired = await parseOutlineResponse(repairResponse, {
                outlineSchema,
                generateContentFn,
                model,
                geminiApiKey,
                anthropicApiKey,
                retryDelayMs
            });
            repaired.usage = combineUsage(parsed.usage, repaired.usage);
            parsed = repaired;
            missingChecklistItems = findUndercoveredChecklistItems(revisionChecklist, parsed.result);
            if (missingChecklistItems.length) {
                appendMissingChecklistBeats(parsed.result, missingChecklistItems);
                missingChecklistItems = findUndercoveredChecklistItems(revisionChecklist, parsed.result);
            }
        }

        if (missingChecklistItems.length) {
            const error = new Error(`Stage 2 outline revision did not satisfy required checklist item(s): ${missingChecklistItems.map(item => `"${compactText(item, 180)}"`).join('; ')}`);
            error.code = 'STAGE2_CHECKLIST_UNMET';
            throw error;
        }

        return parsed;
    }

    const systemInstruction = outlineSOP;

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
    let contentsText = `${sourceBlock}Here is the approved pitch: ${JSON.stringify(pitchData)}. You MUST generate the full JSON structure including title, genre, logline, and the 8-sequence outline containing act_1, act_2, and act_3.`;
    if (notes && hasCurrentOutline) {
        contentsText = `${sourceBlock}Here is the approved pitch: ${JSON.stringify(pitchData)}. Here is the current working outline: ${JSON.stringify(currentOutline)}. Please revise the outline specifically based on these User Notes: ${notes}. You MUST generate the full JSON structure including title, genre, logline, and the entirely revised 8-sequence outline containing act_1, act_2, and act_3.`;
    } else if (notes) {
        contentsText += ` User Notes: ${notes}`;
    }
    contents.push(contentsText);

    const response = await callOutlineModel(generateContentFn, {
        model, geminiApiKey, anthropicApiKey,
        contents,
        config: {
            temperature: 0.7,
            thinkingConfig: { thinkingLevel: "HIGH" },
            systemInstruction,
        },
        schema: outlineSchema
    }, {
        label: 'Stage 2 outline generation',
        retries: 2,
        delayMs: retryDelayMs
    });

    return parseOutlineResponse(response, {
        outlineSchema,
        generateContentFn,
        model,
        geminiApiKey,
        anthropicApiKey,
        retryDelayMs
    });
};

module.exports = { agent2Outline, outlineHasContent };
