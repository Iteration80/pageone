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
        const revisionPrompt = `${sourceBlock}USER NOTE: ${notes}

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

        return parseOutlineResponse(response, {
            outlineSchema,
            generateContentFn,
            model,
            geminiApiKey,
            anthropicApiKey,
            retryDelayMs
        });
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
