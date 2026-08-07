const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

/**
 * Structural guards for the continuous script view ("continuous read, scoped edit").
 *
 * The decision recorded in specs/pageone-editor-ux-plan-2026-08-06.md is that the
 * whole script renders continuously while exactly ONE scene is editable, so the
 * editable region always has a single owner and there is no re-split on save — the
 * mechanism whose failure mode is text silently migrating between scenes.
 *
 * There is no DOM test harness in this project (no jsdom, no devDependencies), so
 * the byte-identical guarantee itself was verified live: editing one scene in the
 * continuous view left all 69 other scenes byte-identical on disk, and the test
 * project was restored to its pre-test snapshot afterwards. What follows pins the
 * invariants that would let that guarantee break silently.
 */

test('the editor is built on its own host, never on the scrolling container', () => {
    // If the editor were constructed on #draft-editor-mount, re-rendering the
    // continuous list would wipe the live editor — taking its undo history,
    // listeners and any unsaved keystrokes with it.
    assert.match(appJs, /new FountainEditor\(stage8EditorHost,/);
    assert.doesNotMatch(appJs, /new FountainEditor\(draftEditorMount,/);
});

test('the editor host is detached BEFORE the container is cleared', () => {
    // Order matters on the MAIN render path: clearing first would destroy the host
    // that is about to be re-seated. Scoped past the empty-script early return,
    // which legitimately clears and then re-appends the host on its own.
    const render = appJs.slice(appJs.indexOf('function stage8RenderContinuous'));
    const mainPath = render.slice(render.indexOf('const frag = document.createDocumentFragment()') - 400);
    const detach = mainPath.indexOf('stage8EditorHost.remove()');
    const clear = mainPath.indexOf("draftEditorMount.innerHTML = ''");
    assert.ok(detach > -1, 'the main render path must detach the host');
    assert.ok(clear > -1, 'the main render path must clear the container');
    assert.ok(detach < clear, 'the host must be detached before the container is cleared');
});

test('exactly one scene is editable — the rest render read-only', () => {
    const render = appJs.slice(
        appJs.indexOf('function stage8RenderContinuous'),
        appJs.indexOf('function stage8LoadEditor')
    );
    // The active branch hosts the editor; the other branch renders HTML only.
    assert.match(render, /scene\.scene_number === currentDraftSceneNumber/);
    assert.match(render, /block\.appendChild\(stage8EditorHost\)/);
    assert.match(render, /block\.innerHTML = formatFountainToHTML\(text\)/);
    // Read-only blocks must never be made editable — that would create a second
    // owner for the same text and reintroduce the re-split problem.
    assert.doesNotMatch(render, /contentEditable/);
});

test('a read-only scene becomes editable only by going through selectDraftScene', () => {
    // selectDraftScene flushes pending edits with requireSaved before switching.
    // Swapping the active scene without it would drop unsaved keystrokes.
    const render = appJs.slice(
        appJs.indexOf('function stage8RenderContinuous'),
        appJs.indexOf('function stage8LoadEditor')
    );
    assert.match(render, /window\.selectDraftScene\(scene\.scene_number\)/);
    assert.match(appJs, /window\.selectDraftScene = async function[\s\S]{0,200}stage8FlushEditor\(\{ requireSaved: true \}\)/);
});

test('the save path still targets one scene, found by number', () => {
    // The flush writes to the scene matching currentDraftSceneNumber and nothing
    // else — this is what keeps an edit from reaching another scene's record.
    assert.match(appJs, /const scene = scenes\.find\(s => s\.scene_number === currentDraftSceneNumber\)/);
    assert.match(appJs, /scene\.draft_text = newText;\s*\n\s*scene\.humanized_draft_text = newText;/);
});

test('the continuous list is re-rendered whenever a scene is loaded', () => {
    // Otherwise the active-scene highlight and the editor's position drift out of
    // sync with currentDraftSceneNumber after a switch.
    const start = appJs.indexOf('function stage8LoadEditor');
    const load = appJs.slice(start, appJs.indexOf('clearStage8AutosaveError();', start));
    assert.match(load, /stage8RenderContinuous\(\)/);
});
