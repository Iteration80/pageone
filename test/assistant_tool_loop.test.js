const { test } = require('node:test');
const assert = require('node:assert');

const {
    toAnthropicMessages, toAnthropicTools, parseAnthropicResponse,
    toGeminiContents, toGeminiTools, parseGeminiResponse
} = require('../agents/tool_messages');
const { buildTools, buildNeutralMessages, toolResultsContainFailure } = require('../agents/assistant');

const NEUTRAL_CONVERSATION = [
    { role: 'user', text: 'Tighten sequence 5.' },
    { role: 'assistant', text: 'On it — applying that now.', toolCalls: [{ id: 'call_1', name: 'apply_revision', input: { revision_brief: 'Tighten Sequence 5...' } }] },
    { role: 'tool', results: [{ id: 'call_1', name: 'apply_revision', result: { changed: true, receiptSummary: '2 beats updated' } }] }
];

test('toAnthropicMessages maps tool calls and results to tool_use/tool_result blocks', () => {
    const msgs = toAnthropicMessages(NEUTRAL_CONVERSATION);
    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[0].role, 'user');
    assert.strictEqual(msgs[0].content[0].text, 'Tighten sequence 5.');

    const assistant = msgs[1];
    assert.strictEqual(assistant.role, 'assistant');
    assert.strictEqual(assistant.content[0].type, 'text');
    const toolUse = assistant.content[1];
    assert.strictEqual(toolUse.type, 'tool_use');
    assert.strictEqual(toolUse.id, 'call_1');
    assert.strictEqual(toolUse.name, 'apply_revision');

    const toolTurn = msgs[2];
    assert.strictEqual(toolTurn.role, 'user');
    assert.strictEqual(toolTurn.content[0].type, 'tool_result');
    assert.strictEqual(toolTurn.content[0].tool_use_id, 'call_1');
    assert.match(toolTurn.content[0].content, /"changed":true/);
});

test('toAnthropicMessages marks errored tool results with is_error', () => {
    const msgs = toAnthropicMessages([
        { role: 'tool', results: [{ id: 'c1', name: 'apply_revision', result: { error: 'revision engine returned no changes' }, isError: true }] }
    ]);
    assert.strictEqual(msgs[0].content[0].is_error, true);
});

test('toGeminiContents maps tool calls and results to functionCall/functionResponse parts', () => {
    const contents = toGeminiContents(NEUTRAL_CONVERSATION);
    assert.strictEqual(contents[1].role, 'model');
    const fnCall = contents[1].parts.find(p => p.functionCall);
    assert.strictEqual(fnCall.functionCall.name, 'apply_revision');
    assert.strictEqual(fnCall.functionCall.args.revision_brief, 'Tighten Sequence 5...');

    const fnResp = contents[2].parts[0].functionResponse;
    assert.strictEqual(fnResp.name, 'apply_revision');
    assert.strictEqual(fnResp.response.changed, true);
});

test('parseAnthropicResponse extracts text and tool calls', () => {
    const parsed = parseAnthropicResponse({
        stop_reason: 'tool_use',
        content: [
            { type: 'text', text: 'Applying now.' },
            { type: 'tool_use', id: 'toolu_x', name: 'apply_revision', input: { revision_brief: 'b' } }
        ]
    });
    assert.strictEqual(parsed.text, 'Applying now.');
    assert.strictEqual(parsed.toolCalls.length, 1);
    assert.strictEqual(parsed.toolCalls[0].id, 'toolu_x');
    assert.strictEqual(parsed.stopReason, 'tool_use');
});

test('parseGeminiResponse extracts function calls from candidate parts and synthesizes ids', () => {
    const parsed = parseGeminiResponse({
        candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ functionCall: { name: 'apply_revision', args: { revision_brief: 'b' } } }] }
        }]
    });
    assert.strictEqual(parsed.toolCalls.length, 1);
    assert.strictEqual(parsed.toolCalls[0].name, 'apply_revision');
    assert.ok(parsed.toolCalls[0].id.length > 0);
});

test('toAnthropicTools / toGeminiTools carry the JSON schema through', () => {
    const tools = buildTools(5);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, 'apply_revision');
    assert.deepStrictEqual(toAnthropicTools(tools)[0].input_schema.required, ['revision_brief']);
    assert.strictEqual(toGeminiTools(tools)[0].functionDeclarations[0].parameters.type, 'object');
});

test('buildTools returns no tools for read-only stages', () => {
    assert.strictEqual(buildTools(9).length, 0);
    assert.strictEqual(buildTools(7).length, 0);
});

test('buildNeutralMessages prepends context to the first user message', () => {
    const msgs = buildNeutralMessages({
        contextBlock: '## PROJECT: Test',
        history: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'tighten act 2' }
        ],
        isInit: false,
        stageId: 5
    });
    assert.strictEqual(msgs.length, 3);
    assert.match(msgs[0].text, /^## PROJECT: Test/);
    assert.match(msgs[0].text, /hello/);
    assert.strictEqual(msgs[2].text, 'tighten act 2');
});

test('buildNeutralMessages appends cadence note from the 4th user exchange', () => {
    const history = [];
    for (let i = 1; i <= 5; i++) {
        history.push({ role: 'user', content: `msg ${i}` });
        if (i < 5) history.push({ role: 'assistant', content: `reply ${i}` });
    }
    const msgs = buildNeutralMessages({ contextBlock: 'ctx', history, isInit: false, stageId: 5 });
    assert.match(msgs[msgs.length - 1].text, /Decision Cadence/);
});

test('buildNeutralMessages isInit produces a single entry-analysis user message', () => {
    const msgs = buildNeutralMessages({ contextBlock: 'ctx', history: [], isInit: true, stageId: 5 });
    assert.strictEqual(msgs.length, 1);
    assert.match(msgs[0].text, /STAGE ENTRY ANALYSIS/);
    assert.match(msgs[0].text, /Do not call any tool/);
});

test('toolResultsContainFailure treats no-change receipts as failed tool turns', () => {
    assert.strictEqual(toolResultsContainFailure([
        { id: 'c1', name: 'apply_revision', result: { changed: true } }
    ]), false);
    assert.strictEqual(toolResultsContainFailure([
        { id: 'c1', name: 'apply_revision', result: { changed: false } }
    ]), true);
    assert.strictEqual(toolResultsContainFailure([
        { id: 'c1', name: 'apply_revision', result: { error: 'revision engine returned no changes' } }
    ]), true);
});
