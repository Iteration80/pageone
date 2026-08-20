const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Stage 10 "Script" — INTERNAL id 11, a pure read-only view of the finished
// screenplay. No jsdom in this project, so these are structural pins in the
// continuous_view.test.js style: they hold the invariants that make the view a
// VIEW — it renders what the exporter prints, from the exporter's own math, and
// it can neither edit nor write anything.

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/** The whole Stage 11 implementation slice. */
function stage11Slice() {
    const start = appJs.indexOf('function stage11Scenes');
    const end = appJs.indexOf('async function initStage10');
    assert.ok(start > -1 && end > start, 'stage11 code must sit before initStage10');
    return appJs.slice(start, end);
}

test('the view exists: nav item, workspace, and the export buttons', () => {
    assert.match(indexHtml, /id="nav-stage-11"[^>]*><span class="badge">10<\/span> Script/);
    assert.match(indexHtml, /id="stage-11-view"/);
    for (const id of ['btnStage11Fountain', 'btnStage11Docx', 'btnStage11PdfClean', 'btnStage11Pdf', 'stage11-script-mount', 'stage11-page-total', 'stage11-source-note']) {
        assert.ok(indexHtml.includes(`id="${id}"`), `index.html must contain #${id}`);
    }
});

test('internal id 11 is wired as visible stage 10 everywhere the pipeline is enumerated', () => {
    assert.match(appJs, /DISPLAY_STAGE_NUMBERS = \{[^}]*11: 10/);
    assert.match(appJs, /11: 'Script'/);
    assert.match(appJs, /PIPELINE_STAGE_IDS = \[1, 2, 3, 5, 6, 7, 8, 9, 10, 11\]/);
    assert.match(appJs, /for \(let i = 1; i <= 11; i\+\+\)/, 'navItems/workspaces loop must reach 11');
    assert.match(appJs, /stageNum === 11\) \{\s*\n\s*initStage11\(\)/, 'switchStage must dispatch to initStage11');
});

test('it unlocks (and completes) on the approved rewrite — the same signal, no new data key', () => {
    assert.match(appJs, /11: !!data\.stage9_rewrites\?\.approved/);
    // STAGE_DATA_KEYS deliberately has no entry for 11: a pure view owns no data.
    const keys = appJs.slice(appJs.indexOf('const STAGE_DATA_KEYS'), appJs.indexOf('};', appJs.indexOf('const STAGE_DATA_KEYS')));
    assert.doesNotMatch(keys, /11:/);
});

test('scene text resolves exactly as the exporters resolve it', () => {
    const slice = stage11Slice();
    // Rewrite pass: working entries by number, deleted scenes dropped.
    assert.match(slice, /stage9_rewrites\?\.working/);
    assert.match(slice, /\.sort\(\(\[a\], \[b\]\) => Number\(a\) - Number\(b\)\)/);
    assert.match(slice, /'\[SCENE DELETED\]'/);
    // Fallback: the approved draft, humanized preferred — the same expression every
    // other consumer of a scene's text uses.
    assert.match(slice, /s\.humanized_draft_text \|\| s\.draft_text/);
});

test('page geometry comes from the shared layout module, never an estimate', () => {
    const slice = stage11Slice();
    assert.ok(slice.includes('window.ScreenplayLayout.layoutScreenplay('), 'must use the shared layout walk');
    assert.ok(slice.includes('window.ScreenplayLayout.parseFountain('), 'must use the shared parser');
    assert.ok(!/\b55\b|LINES_PER_PAGE/.test(slice), 'no independent lines-per-page estimate');
    // And the exporter's document construction: trimmed texts joined by one blank.
    assert.match(slice, /combined\.push\(\{ type: 'blank' \}\)/);
});

test('it is a view: nothing editable, nothing written', () => {
    const slice = stage11Slice();
    assert.doesNotMatch(slice, /contentEditable/i);
    assert.doesNotMatch(slice, /new FountainEditor/);
    assert.doesNotMatch(slice, /method:\s*'(POST|PUT|DELETE)'/, 'the view must never write');
    assert.doesNotMatch(slice, /updateProjectJSON|stage10SetPending/);
});

test('exports reuse the existing endpoints, rewrite vs draft chosen by what the view shows', () => {
    const slice = stage11Slice();
    assert.match(slice, /hasRewrite \? 'rewrite' : 'draft'/);
    assert.match(slice, /\/api\/export\/pdf\/\$\{activeProjectId\}\?stage=\$\{exportStage\(\)\}/);
    assert.match(slice, /&marks=0/, 'the clean PDF must be the marks=0 variant');
    assert.match(slice, /\/api\/export\/docx\/\$\{activeProjectId\}\?stage=\$\{exportStage\(\)\}/);
    // The clean button only exists for a rewrite — a first draft has nothing to star.
    assert.match(slice, /btnStage11PdfClean'\)\?\.classList\.toggle\('hidden', !hasRewrite\)/);
});
