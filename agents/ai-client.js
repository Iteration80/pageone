/**
 * ai-client.js — Unified AI generation wrapper
 *
 * Supports Gemini (Google GenAI) and Anthropic (Claude) providers.
 * Provider is detected from the model name prefix:
 *   - "gemini-*"  → Google GenAI SDK
 *   - "claude-*"  → Anthropic SDK
 *
 * All callers receive { text: string, usage: { model, inputTokens, outputTokens } } regardless of provider.
 */

const { GoogleGenAI } = require('@google/genai');
const Anthropic = require('@anthropic-ai/sdk');

function detectProvider(model) {
    if (typeof model === 'string' && model.startsWith('claude-')) return 'anthropic';
    return 'gemini';
}

// ─── Gemini path ─────────────────────────────────────────────────────────────

async function callGemini({ model, geminiApiKey, contents, config = {}, schema }) {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey, httpOptions: { timeout: 300_000 } });
    const callConfig = { ...config };

    if (schema) {
        callConfig.responseMimeType = 'application/json';
        callConfig.responseSchema = schema;
    }

    const response = await ai.models.generateContent({ model, contents, config: callConfig });
    const rawText = response.text;
    const usage = {
        model,
        inputTokens: response.usageMetadata?.promptTokenCount || 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
    };
    // Strip any markdown fences just in case
    return { text: rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim(), usage };
}

// ─── Anthropic path ───────────────────────────────────────────────────────────

function normalizeContentsForClaude(contents) {
    const userContent = [];
    const items = Array.isArray(contents) ? contents : [contents];

    for (const item of items) {
        if (typeof item === 'string') {
            userContent.push({ type: 'text', text: item });
        } else if (item?.inlineData) {
            // Gemini-style inlineData → Anthropic document block
            userContent.push({
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: item.inlineData.mimeType || 'application/pdf',
                    data: item.inlineData.data
                }
            });
        } else if (item?.parts) {
            // Gemini-style { role, parts } object
            for (const part of item.parts) {
                if (part.text) {
                    userContent.push({ type: 'text', text: part.text });
                } else if (part.inlineData) {
                    userContent.push({
                        type: 'document',
                        source: {
                            type: 'base64',
                            media_type: part.inlineData.mimeType || 'application/pdf',
                            data: part.inlineData.data
                        }
                    });
                }
            }
        }
    }

    return [{ role: 'user', content: userContent }];
}

function buildClaudeSystemPrompt(systemInstruction, schema) {
    let system = systemInstruction || '';
    if (schema) {
        system += `\n\nCRITICAL: Respond with valid JSON only. No markdown fences, no prose before or after. Your JSON must conform exactly to this schema:\n${JSON.stringify(schema, null, 2)}`;
    }
    return system;
}

// When Claude adds prose around JSON despite instructions, extract the first
// balanced JSON object/array instead of trusting the entire text.
function extractJsonFromText(text, schema) {
    const t = text.trim();
    const expectedOpen = schema?.type === 'array' ? '[' : schema?.type === 'object' ? '{' : null;
    const idx = expectedOpen ? t.indexOf(expectedOpen) : t.search(/[\{\[]/);
    if (idx < 0) return t;

    const open = expectedOpen || t[idx];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = idx; i < t.length; i++) {
        const ch = t[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === open) {
            depth++;
        } else if (ch === close) {
            depth--;
            if (depth === 0) return t.slice(idx, i + 1);
        }
    }

    return t.slice(idx);
}

// Models that have deprecated the temperature parameter
const CLAUDE_NO_TEMPERATURE = ['claude-opus-4-7'];

async function callClaude({ model, anthropicApiKey, contents, config = {}, schema }) {
    const client = new Anthropic({ apiKey: anthropicApiKey });
    const messages = normalizeContentsForClaude(contents);
    const system = buildClaudeSystemPrompt(config?.systemInstruction, schema);

    const temperatureParam = CLAUDE_NO_TEMPERATURE.includes(model)
        ? {}
        : { temperature: config?.temperature ?? 0.7 };

    const maxTokens = config?.maxOutputTokens ?? 16000;

    // Note: thinkingConfig and tools (e.g. googleSearch) are Gemini-only — silently dropped here
    const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        ...temperatureParam,
        ...(system ? { system } : {}),
        messages
    });

    const rawText = response.content.find(b => b.type === 'text')?.text ?? '';
    const usage = {
        model,
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
    };
    // Strip markdown fences; when JSON is expected, also strip any prose preamble
    let text = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    if (schema) text = extractJsonFromText(text, schema);
    return { text, usage };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * generateContent({ model, geminiApiKey, anthropicApiKey, contents, config, schema })
 *
 * @param {string}  model          - e.g. "gemini-3.1-pro-preview" or "claude-opus-4-6"
 * @param {string}  geminiApiKey   - Google GenAI API key (used when provider=gemini)
 * @param {string}  anthropicApiKey - Anthropic API key (used when provider=anthropic)
 * @param {*}       contents       - Gemini-style: string | string[] | {inlineData}[]
 * @param {object}  config         - { systemInstruction, temperature, thinkingConfig, tools, ... }
 * @param {object}  schema         - JSON schema object (optional); enforced natively on Gemini,
 *                                   injected as system prompt instruction on Claude
 * @returns {{ text: string, usage: { model: string, inputTokens: number, outputTokens: number } }}
 */
async function generateContent({ model, geminiApiKey, anthropicApiKey, contents, config, schema }) {
    const provider = detectProvider(model);
    if (provider === 'anthropic') {
        return callClaude({ model, anthropicApiKey, contents, config, schema });
    }
    return callGemini({ model, geminiApiKey, contents, config, schema });
}

module.exports = { generateContent };
