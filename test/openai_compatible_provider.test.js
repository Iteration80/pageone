const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

/**
 * Phase 5 item 2 — one OpenAI-compatible branch for OpenAI, Moonshot (Kimi),
 * DeepSeek, Groq, Together, OpenRouter and a local llama.cpp/vLLM server.
 *
 * THE INSTRUMENT IS A REAL VENDOR, FAKED. These tests stand up an HTTP server that
 * speaks `POST /chat/completions` and point a registry row at it, so the branch is
 * exercised end to end — the request body that actually goes on the wire, the two
 * degradation paths, the tool-call translation both ways, and the usage mapping.
 * A source-string test would have proved none of it, and this project has paid for
 * that lesson three times (`794c332`, `f923414`, the Stage 1 pitch loss).
 *
 * ⚠️ What these tests CANNOT tell you is whether a given real vendor accepts a given
 * stage's schema. Every provider has its own schema traps — the Gemini `minItems`
 * class is not unique to Gemini — and no local test can catch that class. That is
 * what the admin Verify action is for (item 4): one real request per stage schema
 * before a model is marked usable.
 */

// ─── A fake vendor ────────────────────────────────────────────────────────────

/**
 * `handler(body, requests)` returns `{ status, json }`. Every request's parsed body
 * and headers are recorded so a test can assert on what actually went out.
 */
async function withVendor(handler, run) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw); } catch {}
            requests.push({ url: req.url, headers: req.headers, body });
            const { status = 200, json = {} } = handler(body, requests) || {};
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(json));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    try {
        return await run({ baseUrl, requests });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function completion(content, { toolCalls = null, promptTokens = 11, completionTokens = 22 } = {}) {
    return {
        choices: [{
            message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
            finish_reason: toolCalls ? 'tool_calls' : 'stop'
        }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens }
    };
}

/**
 * A throwaway DATA_ROOT holding a registry with one row pointing at the fake vendor,
 * then a freshly-required ai-client so it reads that registry.
 */
function withRegistry(baseUrl, run, { id = 'kimi-k3' } = {}) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pageone-openai-'));
    fs.writeFileSync(path.join(dataRoot, 'models.json'), JSON.stringify({
        version: 1,
        models: [{
            id, label: 'Kimi K3', provider: 'openai-compatible', baseUrl,
            pricing: { inputPerMTok: 0.6, outputPerMTok: 2.5, source: 'https://example.test', checkedAt: '2026-08-22' },
            enabled: true, deprecated: false, verified: {}
        }],
        recommended: {}
    }));
    const previous = { DATA_ROOT: process.env.DATA_ROOT, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_KEYS: process.env.OPENAI_KEYS };
    process.env.DATA_ROOT = dataRoot;
    process.env.OPENAI_API_KEY = 'sk-test-house-key';
    delete process.env.OPENAI_KEYS;
    for (const key of Object.keys(require.cache)) {
        if (key.includes('/utils/model_registry.js') || key.includes('/utils/api_keys.js') || key.includes('/agents/ai-client.js')) {
            delete require.cache[key];
        }
    }
    const client = require('../agents/ai-client');
    const restore = () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(dataRoot, { recursive: true, force: true });
    };
    return Promise.resolve(run({ client, id })).finally(restore);
}

// ─── generateContent ──────────────────────────────────────────────────────────

test('a registered OpenAI-compatible model is called at its own baseUrl with its own key', async () => {
    await withVendor(() => ({ json: completion('{"logline":"A man loses his hat."}') }), async ({ baseUrl, requests }) => {
        await withRegistry(baseUrl, async ({ client, id }) => {
            const res = await client.generateContent({
                model: id,
                contents: 'Write a logline.',
                config: { systemInstruction: 'You are a screenwriter.', temperature: 0.3, maxOutputTokens: 900 },
                schema: { type: 'object', properties: { logline: { type: 'string' } } }
            });

            assert.equal(res.text, '{"logline":"A man loses his hat."}');
            assert.deepEqual(res.usage, { model: id, inputTokens: 11, outputTokens: 22 });

            assert.equal(requests.length, 1);
            const [sent] = requests;
            assert.equal(sent.url, '/v1/chat/completions', 'the endpoint is baseUrl + /chat/completions');
            assert.equal(sent.headers.authorization, 'Bearer sk-test-house-key',
                'the key must come from the resolver, not from a caller — no agent call site passes one');
            assert.equal(sent.body.model, id);
            assert.equal(sent.body.temperature, 0.3);
            assert.equal(sent.body.max_completion_tokens, 900);
            assert.equal(sent.body.response_format.type, 'json_schema');
            assert.equal(sent.body.messages[0].role, 'system');
            assert.match(sent.body.messages[0].content, /screenwriter/);
            assert.equal(sent.body.messages[1].content, 'Write a logline.');
        });
    });
});

test('a vendor that does not support response_format is retried once with the schema in the prompt', async () => {
    let seen = 0;
    await withVendor(body => {
        seen += 1;
        if (body.response_format) {
            return { status: 400, json: { error: { message: "Unrecognized request argument supplied: response_format" } } };
        }
        return { json: completion('{"logline":"ok"}') };
    }, async ({ baseUrl, requests }) => {
        await withRegistry(baseUrl, async ({ client, id }) => {
            const res = await client.generateContent({
                model: id,
                contents: 'Write a logline.',
                schema: { type: 'object', properties: { logline: { type: 'string' } } }
            });
            assert.equal(res.text, '{"logline":"ok"}');
            assert.equal(seen, 2, 'exactly one retry — not a loop');
            assert.ok(!requests[1].body.response_format, 'the retry drops the field the vendor rejected');
            assert.match(requests[1].body.messages[0].content, /valid JSON only/i,
                '…and the schema still reaches the model, in the system prompt — the Claude path\'s answer');
        });
    });
});

test('a vendor that only knows max_tokens is retried once with max_tokens', async () => {
    await withVendor(body => {
        if (body.max_completion_tokens) {
            return { status: 400, json: { error: { message: 'Unsupported parameter: max_completion_tokens' } } };
        }
        return { json: completion('fine') };
    }, async ({ baseUrl, requests }) => {
        await withRegistry(baseUrl, async ({ client, id }) => {
            const res = await client.generateContent({ model: id, contents: 'hi', config: { maxOutputTokens: 512 } });
            assert.equal(res.text, 'fine');
            assert.equal(requests.length, 2);
            assert.equal(requests[1].body.max_tokens, 512);
            assert.ok(!('max_completion_tokens' in requests[1].body));
        });
    });
});

test('a 400 about the prompt is thrown with the vendor\'s own words, not retried away', async () => {
    let calls = 0;
    await withVendor(() => {
        calls += 1;
        return { status: 400, json: { error: { message: 'context_length_exceeded: too many tokens' } } };
    }, async ({ baseUrl }) => {
        await withRegistry(baseUrl, async ({ client, id }) => {
            await assert.rejects(
                client.generateContent({ model: id, contents: 'hi' }),
                err => {
                    assert.match(err.message, /context_length_exceeded/,
                        'the vendor\'s message must survive — "request failed" costs an hour of log reading');
                    return true;
                }
            );
            assert.equal(calls, 1, 'a real error must not be retried');
        });
    });
});

test('a prompt-error 400 on a SCHEMA request is not mistaken for "response_format unsupported"', async () => {
    // The dangerous shape, and the one a naive `if (body.response_format)` retry
    // gets wrong: the request DID carry a response_format, so a blanket retry would
    // drop it, succeed, and hand back unstructured text that the caller then tries
    // to parse as the schema. A degradation must be triggered by the vendor naming
    // the field, never by the field merely being present.
    let calls = 0;
    await withVendor(() => {
        calls += 1;
        return { status: 400, json: { error: { message: 'context_length_exceeded: too many tokens' } } };
    }, async ({ baseUrl }) => {
        await withRegistry(baseUrl, async ({ client, id }) => {
            await assert.rejects(
                client.generateContent({
                    model: id,
                    contents: 'hi',
                    schema: { type: 'object', properties: { logline: { type: 'string' } } }
                }),
                /context_length_exceeded/
            );
            assert.equal(calls, 1,
                'retrying here would silently turn a structured request into an unstructured one');
        });
    });
});

test('a 401 is relayed verbatim rather than becoming an opaque failure', async () => {
    await withVendor(() => ({ status: 401, json: { error: { message: 'invalid_api_key' } } }), async ({ baseUrl }) => {
        await withRegistry(baseUrl, async ({ client, id }) => {
            await assert.rejects(client.generateContent({ model: id, contents: 'hi' }), /invalid_api_key/);
        });
    });
});

test('an attachment is refused loudly instead of being silently dropped', async () => {
    await withVendor(() => ({ json: completion('should never be reached') }), async ({ baseUrl, requests }) => {
        await withRegistry(baseUrl, async ({ client, id }) => {
            await assert.rejects(
                client.generateContent({
                    model: id,
                    contents: [{ inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } }]
                }),
                /attachment/i
            );
            assert.equal(requests.length, 0,
                'sending the prompt WITHOUT the upload would look like a working call giving a worse answer');
        });
    });
});

// ─── chatWithTools ────────────────────────────────────────────────────────────

test('tool calls translate both ways: out as tool_calls, back as role:tool with the call id', async () => {
    const toolCall = { id: 'call_abc', type: 'function', function: { name: 'apply_revision', arguments: '{"target":"logline"}' } };
    await withVendor(body => (
        body.messages.some(m => m.role === 'tool')
            ? { json: completion('Done — the logline is updated.') }
            : { json: completion(null, { toolCalls: [toolCall] }) }
    ), async ({ baseUrl, requests }) => {
        await withRegistry(baseUrl, async ({ client, id }) => {
            const tools = [{ name: 'apply_revision', description: 'Apply it', input_schema: { type: 'object', properties: { target: { type: 'string' } } } }];

            const first = await client.chatWithTools({
                model: id, system: 'You are an editor.', tools,
                messages: [{ role: 'user', text: 'Sharpen the logline.' }]
            });
            assert.deepEqual(first.toolCalls, [{ id: 'call_abc', name: 'apply_revision', input: { target: 'logline' } }],
                'arguments arrive as a JSON string and must be parsed into the neutral shape');
            assert.equal(first.stopReason, 'tool_calls');
            assert.deepEqual(first.usage, { model: id, inputTokens: 11, outputTokens: 22 });
            assert.equal(requests[0].body.tools[0].type, 'function');
            assert.equal(requests[0].body.tools[0].function.name, 'apply_revision');

            const second = await client.chatWithTools({
                model: id, system: 'You are an editor.', tools,
                messages: [
                    { role: 'user', text: 'Sharpen the logline.' },
                    { role: 'assistant', text: '', toolCalls: first.toolCalls },
                    { role: 'tool', results: [{ id: 'call_abc', name: 'apply_revision', result: { changed: true } }] }
                ]
            });
            assert.equal(second.text, 'Done — the logline is updated.');

            const sent = requests[1].body.messages;
            const assistantTurn = sent.find(m => m.role === 'assistant');
            assert.equal(assistantTurn.content, null, 'a pure tool turn sends content:null — some vendors reject ""');
            assert.equal(assistantTurn.tool_calls[0].id, 'call_abc');
            const toolTurn = sent.find(m => m.role === 'tool');
            assert.equal(toolTurn.tool_call_id, 'call_abc',
                'a result whose id does not match a call in the preceding assistant turn is a 400 or silently ignored');
            assert.equal(toolTurn.content, '{"changed":true}');
        });
    });
});

test('a failed tool result is legible as a failure — there is no is_error flag in this protocol', async () => {
    await withVendor(() => ({ json: completion('I could not apply that.') }), async ({ baseUrl, requests }) => {
        await withRegistry(baseUrl, async ({ client, id }) => {
            await client.chatWithTools({
                model: id,
                messages: [
                    { role: 'user', text: 'go' },
                    { role: 'assistant', toolCalls: [{ id: 'c1', name: 'apply_revision', input: {} }] },
                    { role: 'tool', results: [{ id: 'c1', name: 'apply_revision', result: 'target not found', isError: true }] }
                ]
            });
            const toolTurn = requests[0].body.messages.find(m => m.role === 'tool');
            assert.match(toolTurn.content, /^TOOL FAILED:/,
                'without a marker the model reads a failure as a result and quietly retries — '
                + 'exactly what the honest-failure rule in the assistant loop exists to prevent');
        });
    });
});

test('unparseable tool arguments lose the call, not the whole turn', async () => {
    const broken = { id: 'call_x', type: 'function', function: { name: 'apply_revision', arguments: '{"target":"logline",}' } };
    await withVendor(() => ({ json: completion('here you go', { toolCalls: [broken] }) }), async ({ baseUrl }) => {
        await withRegistry(baseUrl, async ({ client, id }) => {
            const res = await client.chatWithTools({ model: id, messages: [{ role: 'user', text: 'go' }] });
            assert.equal(res.text, 'here you go', 'the model\'s text must survive a bad argument list');
            // A trailing comma is repairable — model output goes through
            // parseJsonWithRepair like every other piece of model JSON.
            assert.deepEqual(res.toolCalls[0].input, { target: 'logline' });
        });
    });
});

// ─── Key resolution ───────────────────────────────────────────────────────────

test('OpenAI-compatible keys are per endpoint: OPENAI_KEYS wins over the catch-all', async () => {
    const previous = { OPENAI_KEYS: process.env.OPENAI_KEYS, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
    try {
        for (const key of Object.keys(require.cache)) {
            if (key.includes('/utils/api_keys.js')) delete require.cache[key];
        }
        const apiKeys = require('../utils/api_keys');
        process.env.OPENAI_API_KEY = 'sk-catch-all';
        process.env.OPENAI_KEYS = 'https://api.moonshot.ai/v1=sk-moonshot, https://api.deepseek.com/v1=sk-deepseek';

        assert.equal(apiKeys.keyFor('openai-compatible', { baseUrl: 'https://api.moonshot.ai/v1' }), 'sk-moonshot');
        assert.equal(apiKeys.keyFor('openai-compatible', { baseUrl: 'https://api.deepseek.com/v1/' }), 'sk-deepseek',
            'a trailing slash is the same endpoint');
        assert.equal(apiKeys.keyFor('openai-compatible', { baseUrl: 'https://api.groq.com/openai/v1' }), 'sk-catch-all',
            'an endpoint with no entry of its own falls back to the catch-all');

        delete process.env.OPENAI_API_KEY;
        assert.equal(apiKeys.keyFor('openai-compatible', { baseUrl: 'https://api.groq.com/openai/v1' }), null,
            'and with no catch-all it is null — the caller decides whether that is a 4xx or a missing feature');
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test('a model registered as openai-compatible with no baseUrl fails with a readable message', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pageone-openai-nourl-'));
    // Written straight to disk rather than through the registry, because addModel
    // refuses this shape — this is the "somebody hand-edited models.json" case.
    fs.writeFileSync(path.join(dataRoot, 'models.json'), JSON.stringify({
        version: 1,
        models: [{ id: 'orphan', provider: 'openai-compatible', baseUrl: null, enabled: true, pricing: {} }],
        recommended: {}
    }));
    const previous = process.env.DATA_ROOT;
    process.env.DATA_ROOT = dataRoot;
    try {
        for (const key of Object.keys(require.cache)) {
            if (key.includes('/utils/model_registry.js') || key.includes('/agents/ai-client.js')) delete require.cache[key];
        }
        const client = require('../agents/ai-client');
        await assert.rejects(client.generateContent({ model: 'orphan', contents: 'hi' }), /baseUrl/i);
    } finally {
        if (previous === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = previous;
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});
