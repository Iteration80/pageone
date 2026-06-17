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

function normalizeAbortError(error, signal) {
    if (!signal?.aborted && error?.name !== 'AbortError' && error?.code !== 'ABORT_ERR') return;
    const abortError = new Error('Client disconnected');
    abortError.code = 'CLIENT_DISCONNECTED';
    abortError.cause = error;
    throw abortError;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    normalizeAbortError(signal.reason || new Error('Client disconnected'), signal);
}

// ─── Gemini path ─────────────────────────────────────────────────────────────

async function callGemini({ model, geminiApiKey, contents, config = {}, schema }) {
    const signal = config?.abortSignal;
    throwIfAborted(signal);
    const ai = new GoogleGenAI({ apiKey: geminiApiKey, httpOptions: { timeout: 300_000 } });
    const callConfig = { ...config };

    if (schema) {
        callConfig.responseMimeType = 'application/json';
        callConfig.responseSchema = schema;
    }

    let response;
    try {
        response = await ai.models.generateContent({ model, contents, config: callConfig });
    } catch (error) {
        normalizeAbortError(error, signal);
        throw error;
    }
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
    const signal = config?.abortSignal;
    throwIfAborted(signal);
    const client = new Anthropic({ apiKey: anthropicApiKey });
    const messages = normalizeContentsForClaude(contents);
    const system = buildClaudeSystemPrompt(config?.systemInstruction, schema);

    const temperatureParam = CLAUDE_NO_TEMPERATURE.includes(model)
        ? {}
        : { temperature: config?.temperature ?? 0.7 };

    const maxTokens = config?.maxOutputTokens ?? 16000;
    const request = {
        model,
        max_tokens: maxTokens,
        ...temperatureParam,
        ...(system ? { system } : {}),
        messages
    };

    const normalizeClaudeMessage = (message) => {
        const rawText = message.content.find(b => b.type === 'text')?.text ?? '';
        const usage = {
            model,
            inputTokens: message.usage?.input_tokens || 0,
            outputTokens: message.usage?.output_tokens || 0,
        };
        let text = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
        if (schema) text = extractJsonFromText(text, schema);
        return { text, usage };
    };

    // Some long Claude calls, especially Opus with large max_tokens, must use
    // streaming even when the caller only needs a final accumulated response.
    const shouldStream = maxTokens >= 32000 || model === 'claude-opus-4-7';
    const requestOptions = signal ? { signal } : undefined;
    try {
        if (shouldStream) {
            const stream = client.messages.stream(request, requestOptions);
            const message = await stream.finalMessage();
            return normalizeClaudeMessage(message);
        }

        // Note: thinkingConfig and tools (e.g. googleSearch) are Gemini-only — silently dropped here
        const response = await client.messages.create(request, requestOptions);
        return normalizeClaudeMessage(response);
    } catch (error) {
        normalizeAbortError(error, signal);
        throw error;
    }
}

// ─── Chat with tools ──────────────────────────────────────────────────────────

const {
    toAnthropicMessages, toAnthropicTools, parseAnthropicResponse,
    toGeminiContents, toGeminiTools, parseGeminiResponse
} = require('./tool_messages');

/**
 * chatWithTools({ model, geminiApiKey, anthropicApiKey, system, messages, tools, temperature, maxTokens })
 *
 * Single model turn with native function/tool calling on either provider.
 * `messages` uses the neutral format defined in tool_messages.js. The caller
 * owns the loop: when the response contains toolCalls, append the assistant
 * turn and a {role:'tool'} results turn, then call again.
 *
 * @returns {{ text: string, toolCalls: [{id,name,input}], usage: {model,inputTokens,outputTokens}, stopReason: string|null }}
 */
async function chatWithTools({ model, geminiApiKey, anthropicApiKey, system, messages, tools = [], temperature = 0.7, maxTokens = 4000, abortSignal = null }) {
    const provider = detectProvider(model);
    throwIfAborted(abortSignal);

    if (provider === 'anthropic') {
        const client = new Anthropic({ apiKey: anthropicApiKey });
        const request = {
            model,
            max_tokens: maxTokens,
            ...(CLAUDE_NO_TEMPERATURE.includes(model) ? {} : { temperature }),
            ...(system ? { system } : {}),
            messages: toAnthropicMessages(messages),
            ...(tools.length ? { tools: toAnthropicTools(tools) } : {})
        };
        let response;
        try {
            response = await client.messages.create(request, abortSignal ? { signal: abortSignal } : undefined);
        } catch (error) {
            normalizeAbortError(error, abortSignal);
            throw error;
        }
        const parsed = parseAnthropicResponse(response);
        return {
            ...parsed,
            usage: {
                model,
                inputTokens: response.usage?.input_tokens || 0,
                outputTokens: response.usage?.output_tokens || 0
            }
        };
    }

    const ai = new GoogleGenAI({ apiKey: geminiApiKey, httpOptions: { timeout: 300_000 } });
    let response;
    try {
        response = await ai.models.generateContent({
            model,
            contents: toGeminiContents(messages),
            config: {
                ...(system ? { systemInstruction: system } : {}),
                temperature,
                maxOutputTokens: maxTokens,
                ...(abortSignal ? { abortSignal } : {}),
                ...(tools.length ? { tools: toGeminiTools(tools) } : {})
            }
        });
    } catch (error) {
        normalizeAbortError(error, abortSignal);
        throw error;
    }
    const parsed = parseGeminiResponse(response);
    return {
        ...parsed,
        usage: {
            model,
            inputTokens: response.usageMetadata?.promptTokenCount || 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount || 0
        }
    };
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

module.exports = { generateContent, chatWithTools };
