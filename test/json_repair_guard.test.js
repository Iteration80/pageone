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
test('public/app.js uses noticeDialog, not native alert()', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const offenders = appJs
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => /(?<![\w.])alert\s*\(/.test(line))
        .filter(({ line }) => !line.includes('noticeDialog'))
        // noticeDialog's own fallback for missing markup is the one allowed use.
        .filter(({ line }) => !line.includes('window.alert(message || title)'));
    assert.deepStrictEqual(offenders, [], `native alert() found — use noticeDialog() instead:\n${offenders.map(o => `  line ${o.number}: ${o.line}`).join('\n')}`);
});

test('the Stage 6 stream is hardened against proxy buffering like Stage 5', () => {
    // 2026-07-15: Stage 6 (the app's longest stream — 8 sequential model calls)
    // shipped without the SSE hardening Stage 5 already had, and broke mid-stream
    // with a client-side "network error". Server aborts in-flight work on client
    // disconnect, so a broken stream silently discards the whole generation.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'generation.js'), 'utf8');
    const stage6 = routes.slice(routes.indexOf("app.post('/api/generate-stage6-scenes'"), routes.indexOf("app.post('/api/generate-stage6-audit'"));
    assert.ok(/X-Accel-Buffering/.test(stage6), 'Stage 6 stream must disable proxy buffering');
    assert.ok(/res\.flush\?\.\(\)/.test(stage6), 'Stage 6 must flush each SSE event');
    assert.ok(/type: 'heartbeat'/.test(stage6), 'Stage 6 heartbeat must be a data event, not a : comment');

    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.ok(/recoverStage6FromInterruptedStream/.test(appJs), 'Stage 6 must recover from an interrupted stream, as Stage 2 does');
    // The server keeps generating and saves the blueprint minutes after the
    // browser's connection drops (Railway cuts the client leg, not the server
    // leg). A single immediate refetch checks before the save lands and reports a
    // false failure — recovery must POLL until the blueprint changes or a deadline.
    const recoverFn = appJs.slice(
        appJs.indexOf('async function recoverStage6FromInterruptedStream'),
        appJs.indexOf('async function generateStage6')
    );
    assert.ok(/setTimeout/.test(recoverFn) && /deadline|MAX_WAIT_MS/.test(recoverFn),
        'Stage 6 recovery must poll for the delayed server-side save, not check once');
});

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

// ─── Guard: treatment plumbing never reaches the reader ──────────────────────
// [SEQUENCE N START]/[SEQUENCE N END] are the Stage 5 agent's parse contract and
// must stay in saved data (the revision path requires them verbatim), but they
// are not prose. The UI strips them on render; the DOCX export must too — it
// didn't, and 16 shipped in a real treatment export (2026-07-14).
test('treatment export strips the [SEQUENCE N] parse tags, keeping prose', () => {
    const { stripTreatmentSequenceTags } = require('../agents/export');
    const act = [
        '[SEQUENCE 1 START]',
        'SEQUENCE 1: The Invisible World',
        'Rebecca burns the toast while Elliot talks to an empty chair.',
        '[SEQUENCE 1 END]',
        '',
        '[SEQUENCE 2 START]',
        'SEQUENCE 2: The Mother Who Could Not See',
        'The scanner shrieks.',
        '[SEQUENCE 2 END]'
    ].join('\n');
    const cleaned = stripTreatmentSequenceTags(act);
    assert.ok(!/\[SEQUENCE \d+ (?:START|END)\]/.test(cleaned), 'no parse tags may survive');
    assert.ok(cleaned.includes('Rebecca burns the toast while Elliot talks to an empty chair.'), 'prose survives');
    assert.ok(cleaned.includes('SEQUENCE 1: The Invisible World'), 'sequence heading survives');
    assert.ok(cleaned.includes('SEQUENCE 2: The Mother Who Could Not See'), 'all headings survive');
    // Prose that merely mentions a bracket must not be eaten.
    assert.equal(stripTreatmentSequenceTags('He read [SEQUENCE 1 START] aloud from the script.'),
        'He read [SEQUENCE 1 START] aloud from the script.', 'only whole-line tags are stripped');
});

test('the treatment DOCX export routes act text through the strip', () => {
    const exportJs = fs.readFileSync(path.join(__dirname, '..', 'agents', 'export.js'), 'utf8');
    const fn = exportJs.slice(exportJs.indexOf('async function generateTreatmentDocx'), exportJs.indexOf('async function generateTreatmentDocx') + 900);
    assert.ok(/stripTreatmentSequenceTags/.test(fn), 'generateTreatmentDocx must strip parse tags before rendering');
});
