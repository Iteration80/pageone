const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { parseJsonWithRepair } = require('../agents/json_parse');

// ─── Guard: no raw JSON.parse on model output in agents/ ─────────────────────
// Model output must go through parseJsonWithRepair (R2, roadmap 2026-07-03).
// Allowed raw parses: deep clones (JSON.parse(JSON.stringify(...))), the repair
// helper itself, lenient style-file frontmatter, and assistant turnState (which
// is server-serialized JSON round-tripped through the browser, not model text).

const ALLOWED_RAW_PARSE = {
    'json_parse.js': true,       // the repair helper's own parse attempts
    'agent_7_style.js': true,    // lenient frontmatter array parse (try/catch, non-model)
    'assistant.js': true         // turnState deserialization (server-serialized JSON)
};

test('agents never raw-JSON.parse model output', () => {
    const agentsDir = path.join(__dirname, '../agents');
    const offenders = [];
    for (const file of fs.readdirSync(agentsDir).filter(f => f.endsWith('.js'))) {
        if (ALLOWED_RAW_PARSE[file]) continue;
        const source = fs.readFileSync(path.join(agentsDir, file), 'utf8');
        source.split('\n').forEach((line, i) => {
            if (!line.includes('JSON.parse')) return;
            if (line.includes('JSON.parse(JSON.stringify')) return; // deep clone
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.deepStrictEqual(offenders, [],
        `Raw JSON.parse on model output found — use parseJsonWithRepair:\n${offenders.join('\n')}`);
});

// ─── Behavior: the repair paths the agents now rely on ───────────────────────

test('parseJsonWithRepair strips markdown fences and surrounding prose', () => {
    const parsed = parseJsonWithRepair(
        'Here is the treatment:\n```json\n{"act_1": "text"}\n```\nLet me know!',
        { label: 'test' });
    assert.deepStrictEqual(parsed, { act_1: 'text' });
});

test('parseJsonWithRepair repairs trailing commas', () => {
    const parsed = parseJsonWithRepair('{"title": "x", "logline": "y",}', { label: 'test' });
    assert.deepStrictEqual(parsed, { title: 'x', logline: 'y' });
});

test('parseJsonWithRepair extracts arrays when schema type is array', () => {
    const parsed = parseJsonWithRepair(
        'Modified sequences below:\n[{"sequence_number": 3}]',
        { schema: { type: 'array' }, label: 'test' });
    assert.deepStrictEqual(parsed, [{ sequence_number: 3 }]);
});

test('parseJsonWithRepair throws a labeled error on unrepairable input', () => {
    assert.throws(
        () => parseJsonWithRepair('not json at all', { label: 'Stage X response' }),
        /Stage X response was not valid JSON after repair/);
});

// ─── Guard: no native confirm() dialogs in the UI ────────────────────────────
// window.confirm renders browser chrome ("<host> says…") that breaks the app's
// look. Use confirmDialog() (public/app.js) instead. The single allowed use is
// confirmDialog's own fallback, for when the modal markup is unavailable.
test('public/app.js uses confirmDialog, not native confirm()', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const offenders = appJs
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => /(?<![\w.])confirm\s*\(/.test(line))
        .filter(({ line }) => !line.includes('confirmDialog'))
        .filter(({ line }) => !line.includes('return Promise.resolve(window.confirm('));
    assert.deepStrictEqual(offenders, [], `native confirm() found — use confirmDialog() instead:\n${offenders.map(o => `  line ${o.number}: ${o.line}`).join('\n')}`);
});

test('the confirm dialog markup and helper exist and are wired', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    for (const id of ['confirmModal', 'confirmModalTitle', 'confirmModalMessage', 'confirmModalConfirm', 'confirmModalCancel']) {
        assert.ok(indexHtml.includes(`id="${id}"`), `index.html must contain #${id}`);
    }
    // Top-level, not trapped inside DOMContentLoaded (the June gear-icon bug class).
    const helperIndex = appJs.indexOf('function confirmDialog(');
    const domReadyIndex = appJs.indexOf("document.addEventListener('DOMContentLoaded'");
    assert.ok(helperIndex > -1, 'confirmDialog must exist');
    assert.ok(helperIndex < domReadyIndex, 'confirmDialog must be top-level, not inside DOMContentLoaded');
});
