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

module.exports = {
    toAnthropicMessages,
    toAnthropicTools,
    parseAnthropicResponse,
    toGeminiContents,
    toGeminiTools,
    parseGeminiResponse
};
