/**
 * ai-client.js — Unified AI generation wrapper
 *
 * Supports Gemini (Google GenAI) and Anthropic (Claude) providers.
 *
 * ⚠️ PROVIDER COMES FROM THE MODEL REGISTRY (utils/model_registry.js), not from the
 * model id. Until Phase 5 it was a prefix rule — `claude-*` → Anthropic, everything
 * else → Gemini — which is fine for two vendors and wrong the moment a third exists:
 * `kimi-k3` would have been posted to Google. The registry row names the provider,
 * and the prefix rule survives ONLY as the guess for an id nobody registered, so a
 * model configured before the registry existed does not suddenly change SDK.
 *
 * All callers receive { text: string, usage: { model, inputTokens, outputTokens } } regardless of provider.
 */

const { GoogleGenAI } = require('@google/genai');
const Anthropic = require('@anthropic-ai/sdk');
const modelRegistry = require('../utils/model_registry');
const apiKeys = require('../utils/api_keys');

function detectProvider(model) {
    return modelRegistry.providerFor(model);
}

/**
 * Where an OpenAI-compatible call gets its endpoint and its key.
 *
 * ⚠️ RESOLVED HERE, NOT PASSED IN. Every one of the ~30 `generateContent` call
 * sites in `agents/*` destructures its keys by name; threading two more parameters
 * through all of them is the kind of change where missing one produces a stage that
 * works on Gemini and fails only when someone points it at Kimi. The endpoint comes
 * from the model's registry row and the key from utils/api_keys.js, which is also
 * where per-person keys will resolve. An explicit argument still wins, so a caller
 * that knows better (the admin Verify action) can say so.
 */
function resolveOpenAiTarget(model, { baseUrl = null, apiKey = null } = {}) {
    const endpoint = baseUrl || modelRegistry.baseUrlFor(model);
    return { baseUrl: endpoint, apiKey: apiKey || apiKeys.keyFor('openai-compatible', { baseUrl: endpoint }) };
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

// Models that have removed the temperature parameter (sending it → 400).
// Applies to Opus 4.7+ and the entire Claude 5 family (Fable 5/5.1, Opus 5/5.5,
// Sonnet 5, Mythos). Haiku 4.5 and Opus/Sonnet 4.6 still accept temperature and are
// intentionally absent.
//
// ⚠️ A RULE, not a list. The registry lets an admin add a Claude model from the
// Settings form with no deploy, so an exact-id list is a 400 waiting to happen: the
// first request on a freshly added `claude-opus-5-5` would have been rejected for
// carrying `temperature`, and nothing in the add form could have warned about it.
// The explicit ids stay for readability; the pattern is what actually guards.
const CLAUDE_NO_TEMPERATURE = ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-sonnet-5'];
const CLAUDE_NO_TEMPERATURE_PATTERN = /^claude-(?:opus-4-[7-9]|opus-5|sonnet-5|fable-5|mythos-5)(?:-|$)/;
function claudeRejectsTemperature(model = '') {
    const id = String(model || '').trim();
    return CLAUDE_NO_TEMPERATURE.includes(id) || CLAUDE_NO_TEMPERATURE_PATTERN.test(id);
}

async function callClaude({ model, anthropicApiKey, contents, config = {}, schema }) {
    const signal = config?.abortSignal;
    throwIfAborted(signal);
    const client = new Anthropic({ apiKey: anthropicApiKey });
    const messages = normalizeContentsForClaude(contents);
    const system = buildClaudeSystemPrompt(config?.systemInstruction, schema);

    const temperatureParam = claudeRejectsTemperature(model)
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
    // Opus 5 and Fable 5 think by default and can run minutes on a hard turn,
    // so they stream regardless of max_tokens to stay under HTTP timeouts.
    const shouldStream = maxTokens >= 32000
        || model === 'claude-opus-4-7'
        || model === 'claude-opus-5'
        || model === 'claude-fable-5';
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

// ─── OpenAI-compatible path ───────────────────────────────────────────────────
//
// ONE BRANCH, MANY VENDORS. OpenAI, Moonshot (Kimi), DeepSeek, Groq, Together,
// OpenRouter and a local llama.cpp/vLLM server all speak `POST {baseUrl}/chat/
// completions` with the same body. What varies is which optional features they
// support, and that variation is handled by asking for the cheapest thing that
// works and degrading rather than failing:
//
//  - Structured output: `response_format: {type:'json_schema'}` when the vendor
//    supports it. Many do not, and they signal it with a 400 mentioning
//    `response_format`. On that specific failure we retry ONCE with the schema in
//    the system prompt instead, which is what the Claude path has always done.
//  - `max_completion_tokens` is the current field; older/simpler servers only know
//    `max_tokens`. Same treatment: retry once on a 400 that names the field.
//
// ⚠️ EVERY VENDOR HAS ITS OWN SCHEMA TRAPS — the Gemini `minItems` class is not
// unique to Gemini. That is why a model is not usable for a stage until the admin
// Verify action has made one real request against that stage's schema; an
// unverified model is offered with a warning, a failed one is refused.

const OPENAI_TIMEOUT_MS = 300_000;

function openAiEndpoint(baseUrl) {
    if (!baseUrl) throw new Error('This model is registered as OpenAI-compatible but has no baseUrl.');
    return `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
}

/** True when the vendor's 400 is "I don't know that field", not "your input is bad". */
function mentionsUnsupported(text, field) {
    return new RegExp(field, 'i').test(String(text || ''));
}

async function postOpenAI({ baseUrl, apiKey, body, signal }) {
    const response = await fetch(openAiEndpoint(baseUrl), {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: signal || AbortSignal.timeout(OPENAI_TIMEOUT_MS)
    });
    const text = await response.text();
    if (!response.ok) {
        // Relay the vendor's own words. "invalid_api_key" or "model not found" is a
        // usable answer; "request failed" sends someone reading logs for an hour.
        const error = new Error(`${response.status} from ${baseUrl}: ${text.slice(0, 500)}`);
        error.status = response.status;
        error.body = text;
        throw error;
    }
    try {
        // The provider's HTTP envelope, not model prose — repairing it would only
        // paper over a truncated or proxied response we want to hear about.
        return JSON.parse(text); // not-model-json: chat/completions envelope
    } catch {
        throw new Error(`${baseUrl} returned a non-JSON body: ${text.slice(0, 300)}`);
    }
}

function openAiUsage(model, payload) {
    return {
        model,
        inputTokens: payload?.usage?.prompt_tokens || 0,
        outputTokens: payload?.usage?.completion_tokens || 0
    };
}

/**
 * Send one request, degrading through the two optional fields described above.
 * Each fallback happens at most once, and only for a 400 that names the field —
 * a 400 about the prompt is a real error and is thrown.
 */
async function postOpenAIWithFallbacks({ baseUrl, apiKey, body, signal }) {
    try {
        return { payload: await postOpenAI({ baseUrl, apiKey, body, signal }), usedSchema: Boolean(body.response_format) };
    } catch (error) {
        if (error.status !== 400) throw error;

        if (body.response_format && mentionsUnsupported(error.body, 'response_format')) {
            const { response_format: _dropped, ...rest } = body;
            console.warn(`[ai] ${baseUrl} rejected response_format — retrying with the schema in the prompt.`);
            const payload = await postOpenAI({ baseUrl, apiKey, body: rest, signal });
            return { payload, usedSchema: false };
        }
        if (body.max_completion_tokens && mentionsUnsupported(error.body, 'max_completion_tokens')) {
            const { max_completion_tokens, ...rest } = body;
            console.warn(`[ai] ${baseUrl} rejected max_completion_tokens — retrying with max_tokens.`);
            const payload = await postOpenAI({ baseUrl, apiKey, body: { ...rest, max_tokens: max_completion_tokens }, signal });
            return { payload, usedSchema: Boolean(body.response_format) };
        }
        throw error;
    }
}

async function callOpenAICompatible({ model, baseUrl, apiKey, contents, config = {}, schema }) {
    const signal = config?.abortSignal;
    throwIfAborted(signal);

    // Reuse the Claude normalisation: it already flattens Gemini-style contents to
    // one user turn, and it is the same job here.
    const claudeShaped = normalizeContentsForClaude(contents);
    const userText = claudeShaped[0].content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n\n');
    // ⚠️ Documents (inlineData) are dropped: the OpenAI chat shape carries files
    // through a different mechanism that varies per vendor, and silently sending
    // the prompt without the attachment would look like a working call producing a
    // worse answer. Say so instead.
    const droppedDocuments = claudeShaped[0].content.filter(block => block.type === 'document').length;
    if (droppedDocuments) {
        throw new Error(
            `${model} is an OpenAI-compatible model and this request carries ${droppedDocuments} attachment(s), `
            + 'which this provider path does not send. Use a Gemini or Claude model for stages that read uploads.'
        );
    }

    const messages = [];
    // With no native schema support the instruction has to be in the prompt; with
    // it, saying it twice costs nothing and helps small models.
    const system = buildClaudeSystemPrompt(config?.systemInstruction, schema);
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: userText });

    const body = {
        model,
        messages,
        temperature: config?.temperature ?? 0.7,
        max_completion_tokens: config?.maxOutputTokens ?? 16000,
        ...(schema ? {
            response_format: {
                type: 'json_schema',
                json_schema: { name: 'pageone_response', strict: false, schema }
            }
        } : {})
    };

    let payload;
    try {
        ({ payload } = await postOpenAIWithFallbacks({ baseUrl, apiKey, body, signal }));
    } catch (error) {
        normalizeAbortError(error, signal);
        throw error;
    }

    const raw = String(payload?.choices?.[0]?.message?.content || '');
    let text = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    // Same belt-and-braces as the Claude path: a model that wraps its JSON in prose
    // has still produced the JSON, and the caller's parseJsonWithRepair takes it
    // from here.
    if (schema) text = extractJsonFromText(text, schema);
    return { text, usage: openAiUsage(model, payload) };
}

// ─── Chat with tools ──────────────────────────────────────────────────────────

const {
    toAnthropicMessages, toAnthropicTools, parseAnthropicResponse,
    toGeminiContents, toGeminiTools, parseGeminiResponse,
    toOpenAIMessages, toOpenAITools, parseOpenAIResponse
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
async function chatWithTools({ model, geminiApiKey, anthropicApiKey, openaiApiKey, baseUrl, system, messages, tools = [], temperature = 0.7, maxTokens = 4000, abortSignal = null }) {
    const provider = detectProvider(model);
    throwIfAborted(abortSignal);

    if (provider === 'openai-compatible') {
        const target = resolveOpenAiTarget(model, { baseUrl, apiKey: openaiApiKey });
        const body = {
            model,
            messages: toOpenAIMessages(messages, system),
            temperature,
            max_completion_tokens: maxTokens,
            ...(tools.length ? { tools: toOpenAITools(tools), tool_choice: 'auto' } : {})
        };
        let payload;
        try {
            ({ payload } = await postOpenAIWithFallbacks({ ...target, body, signal: abortSignal }));
        } catch (error) {
            normalizeAbortError(error, abortSignal);
            throw error;
        }
        return { ...parseOpenAIResponse(payload), usage: openAiUsage(model, payload) };
    }

    if (provider === 'anthropic') {
        const client = new Anthropic({ apiKey: anthropicApiKey });
        const request = {
            model,
            max_tokens: maxTokens,
            ...(claudeRejectsTemperature(model) ? {} : { temperature }),
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
 * @param {string}  model          - e.g. "gemini-3.1-pro-preview", "claude-opus-5" or "kimi-k3"
 * @param {string}  geminiApiKey   - Google GenAI API key (used when provider=gemini)
 * @param {string}  anthropicApiKey - Anthropic API key (used when provider=anthropic)
 * @param {string}  openaiApiKey   - key for the OpenAI-compatible endpoint (provider=openai-compatible)
 * @param {string}  baseUrl        - override the registry's baseUrl for that provider
 * @param {*}       contents       - Gemini-style: string | string[] | {inlineData}[]
 * @param {object}  config         - { systemInstruction, temperature, thinkingConfig, tools, ... }
 * @param {object}  schema         - JSON schema object (optional); enforced natively on Gemini,
 *                                   requested via response_format where an OpenAI-compatible
 *                                   vendor supports it, and injected as a system-prompt
 *                                   instruction on Claude and wherever it is not supported
 * @returns {{ text: string, usage: { model: string, inputTokens: number, outputTokens: number } }}
 */
async function generateContent({ model, geminiApiKey, anthropicApiKey, openaiApiKey, baseUrl, contents, config, schema }) {
    const provider = detectProvider(model);
    if (provider === 'anthropic') {
        return callClaude({ model, anthropicApiKey, contents, config, schema });
    }
    if (provider === 'openai-compatible') {
        const target = resolveOpenAiTarget(model, { baseUrl, apiKey: openaiApiKey });
        return callOpenAICompatible({ model, ...target, contents, config, schema });
    }
    return callGemini({ model, geminiApiKey, contents, config, schema });
}

module.exports = {
    claudeRejectsTemperature, generateContent, chatWithTools };
