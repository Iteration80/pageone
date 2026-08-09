const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Structural guards for Stage 9 per-change accept/reject (no jsdom in this
// project, so these pin the wiring the way test/continuous_view.test.js does).
// The failure family they guard against is the silent-200 one: a rejection that
// re-renders the panes but never persists, or persists without keeping the
// hidden editor in step — both look perfect on screen.
//
// Every assertion is SCOPED to the extracted function body. Unscoped indexOf
// over the whole of app.js has already produced two test bugs in this project.

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

/** Extract a function body by name, from its declaration to the next top-level `function` keyword at the same indentation. */
function extractFunction(name) {
    const start = appJs.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `function ${name} must exist in app.js`);
    const rest = appJs.slice(start);
    const next = rest.slice(1).search(/\n    (?:async )?function /);
    return next === -1 ? rest : rest.slice(0, next + 1);
}

test('rejecting a hunk goes through mergeHunks and persists via the pending-save path', () => {
    const body = extractFunction('stage10RejectHunk');
    assert.ok(body.includes('ScriptDiff.mergeHunks'),
        'rejection must rebuild the text with mergeHunks — a raw line splice corrupts Fountain blank-line structure');
    assert.ok(body.includes('stage10SetPending('),
        'the merged text must be written to pending state, not only rendered');
    assert.ok(body.includes('stage10QueuePendingSave('),
        'the merged text must be queued for server persistence — an unrejected save would resurrect the rejected change on reload');
});

test('rejecting a hunk reloads the hidden editor so Edit mode cannot resurrect the rejected text', () => {
    const body = extractFunction('stage10RejectHunk');
    assert.ok(body.includes('stage10Editor.loadFountain('),
        'the editor buffer must be reloaded from the merged text');
});

test('the compare render decorates hunks from the same render pass', () => {
    const body = extractFunction('stage10RenderCompare');
    assert.ok(body.includes('stage10DecorateHunks('),
        'per-change controls must be attached by the same function that renders the panes, or a re-render silently drops them');
    // Decoration must come AFTER both panes are painted, since it inserts into them.
    assert.ok(body.indexOf('stage10DecorateHunks(') > body.indexOf('rightView.innerHTML'),
        'decoration must follow the innerHTML render it decorates');
});
