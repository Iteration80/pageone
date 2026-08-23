/**
 * tool_messages.js — Neutral chat-with-tools message format and provider translators.
 *
 * The assistant tool loop (agents/assistant.js) works with a provider-agnostic
 * message list so a tool turn can be serialized into an opaque `turnState` blob,
 * round-tripped through the browser while it executes the tool, and resumed on
 * the next request regardless of which provider the stage is configured to use.
 *
 * Neutral message shapes:
 *   { role: 'user',      text: string }
 *   { role: 'assistant', text?: string, toolCalls?: [{ id, name, input }] }
 *   { role: 'tool',      results: [{ id, name, result, isError? }] }
 *
 * Tool definition shape (JSON Schema input):
 *   { name, description, input_schema: { type: 'object', properties, required } }
 */

const { parseJsonWithRepair } = require('./json_parse');

function resultToText(result) {
    if (result == null) return '';
    return typeof result === 'string' ? result : JSON.stringify(result);
}

// ─── Anthropic ────────────────────────────────────────────────────────────────

function toAnthropicMessages(messages) {
    return messages.map((msg) => {
        if (msg.role === 'user') {
            return { role: 'user', content: [{ type: 'text', text: msg.text || '' }] };
        }
        if (msg.role === 'assistant') {
            const content = [];
            if (msg.text) content.push({ type: 'text', text: msg.text });
            for (const call of msg.toolCalls || []) {
                content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input || {} });
            }
            if (!content.length) content.push({ type: 'text', text: '' });
            return { role: 'assistant', content };
        }
        if (msg.role === 'tool') {
            return {
                role: 'user',
                content: (msg.results || []).map(r => ({
                    type: 'tool_result',
                    tool_use_id: r.id,
                    content: resultToText(r.result),
                    ...(r.isError ? { is_error: true } : {})
                }))
            };
        }
        throw new Error(`Unknown neutral message role: ${msg.role}`);
    });
}

function toAnthropicTools(tools) {
    return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

function parseAnthropicResponse(message) {
    const textParts = [];
    const toolCalls = [];
    for (const block of message.content || []) {
        if (block.type === 'text' && block.text) textParts.push(block.text);
        else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
    }
    return { text: textParts.join('\n').trim(), toolCalls, stopReason: message.stop_reason || null };
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

function toGeminiContents(messages) {
    return messages.map((msg) => {
        if (msg.role === 'user') {
            return { role: 'user', parts: [{ text: msg.text || '' }] };
        }
        if (msg.role === 'assistant') {
            const parts = [];
            if (msg.text) parts.push({ text: msg.text });
            for (const call of msg.toolCalls || []) {
                parts.push({
                    functionCall: { name: call.name, args: call.input || {} },
                    // Gemini 3 rejects resumed turns whose functionCall parts lack the
                    // thought signature it originally emitted — echo it back verbatim.
                    ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
                });
            }
            if (!parts.length) parts.push({ text: '' });
            return { role: 'model', parts };
        }
        if (msg.role === 'tool') {
            return {
                role: 'user',
                parts: (msg.results || []).map(r => ({
                    functionResponse: {
                        name: r.name,
                        response: (r.result && typeof r.result === 'object' && !Array.isArray(r.result))
                            ? r.result
                            : { result: resultToText(r.result) }
                    }
                }))
            };
        }
        throw new Error(`Unknown neutral message role: ${msg.role}`);
    });
}

function toGeminiTools(tools) {
    return [{
        functionDeclarations: tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.input_schema
        }))
    }];
}

function parseGeminiResponse(response) {
    // Scan candidate parts directly (NOT the response.functionCalls convenience
    // getter) so we keep each part's thoughtSignature — Gemini 3 requires it to
    // be echoed back when the turn is resumed with a functionResponse.
    let calls = response.candidates?.[0]?.content?.parts
        ?.filter(p => p.functionCall)
        .map(p => ({ name: p.functionCall.name, args: p.functionCall.args || {}, thoughtSignature: p.thoughtSignature })) || [];
    if (!calls.length) {
        try {
            if (Array.isArray(response.functionCalls) && response.functionCalls.length) {
                calls = response.functionCalls.map(c => ({ name: c.name, args: c.args || {} }));
            }
        } catch { /* getter may throw on empty candidates */ }
    }
    const toolCalls = calls.map((c, i) => ({
        id: `gemini_call_${i}_${c.name}`,
        name: c.name,
        input: c.args,
        ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {})
    }));
    let text = '';
    try { text = (response.text || '').trim(); } catch { text = ''; }
    if (!text) {
        const parts = response.candidates?.[0]?.content?.parts || [];
        text = parts.filter(p => typeof p.text === 'string').map(p => p.text).join('\n').trim();
    }
    return { text, toolCalls, stopReason: response.candidates?.[0]?.finishReason || null };
}

// ─── OpenAI-compatible ────────────────────────────────────────────────────────
//
// One translation for the whole OpenAI-compatible world: OpenAI itself, Moonshot
// (Kimi), DeepSeek, Groq, Together, OpenRouter, a local llama.cpp or vLLM server.
// They differ in which optional features they support, never in this shape.
//
// Two things are unlike the other two providers and both have bitten people before:
//
//  1. A tool RESULT is its own message with `role: 'tool'` and a `tool_call_id`,
//     one per call — Anthropic packs them into a user turn and Gemini into parts.
//     A missing `tool_call_id`, or a result whose id does not match a call in the
//     immediately preceding assistant message, is a 400 from most vendors and
//     silently-ignored context on the rest.
//  2. There is no `is_error` flag. A failed tool result is ordinary text, so the
//     failure has to be legible IN the text or the model will read it as success —
//     which is exactly the silent-retry the assistant loop is built to prevent.
//     `toOpenAIMessages` prefixes it. Do not remove that prefix without giving the
//     model some other way to tell a failure from a result.

function toOpenAIMessages(messages, system = null) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    for (const msg of messages) {
        if (msg.role === 'user') {
            out.push({ role: 'user', content: msg.text || '' });
        } else if (msg.role === 'assistant') {
            const toolCalls = (msg.toolCalls || []).map(call => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input || {}) }
            }));
            out.push({
                role: 'assistant',
                // `content: null` is the documented shape for a pure tool turn; a few
                // vendors reject an empty string there.
                content: msg.text || (toolCalls.length ? null : ''),
                ...(toolCalls.length ? { tool_calls: toolCalls } : {})
            });
        } else if (msg.role === 'tool') {
            for (const r of msg.results || []) {
                out.push({
                    role: 'tool',
                    tool_call_id: r.id,
                    content: r.isError ? `TOOL FAILED: ${resultToText(r.result)}` : resultToText(r.result)
                });
            }
        } else {
            throw new Error(`Unknown neutral message role: ${msg.role}`);
        }
    }
    return out;
}

function toOpenAITools(tools) {
    return tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));
}

function parseOpenAIResponse(response) {
    const choice = response?.choices?.[0] || {};
    const message = choice.message || {};
    const toolCalls = (message.tool_calls || [])
        .filter(call => call?.function?.name)
        .map((call, index) => {
            let input = {};
            // ⚠️ Arguments arrive as a JSON STRING — model output, so it goes through
            // parseJsonWithRepair like every other piece of model JSON (a trailing
            // comma from a small model would otherwise lose the whole tool call).
            // And a throw here would lose the whole turn including the model's text,
            // so an unrepairable argument list degrades to an empty input: the tool
            // then reports its own honest failure through the loop's machinery,
            // which is the behaviour `toolResultsContainFailure` exists to handle.
            try { input = call.function.arguments ? parseJsonWithRepair(call.function.arguments, { label: `${call.function.name} arguments` }) : {}; }
            catch { input = {}; }
            return { id: call.id || `openai_call_${index}_${call.function.name}`, name: call.function.name, input };
        });
    return {
        text: String(message.content || '').trim(),
        toolCalls,
        stopReason: choice.finish_reason || null
    };
}

module.exports = {
    toAnthropicMessages,
    toAnthropicTools,
    parseAnthropicResponse,
    toGeminiContents,
    toGeminiTools,
    parseGeminiResponse,
    toOpenAIMessages,
    toOpenAITools,
    parseOpenAIResponse
};
