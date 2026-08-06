const test = require('node:test');
const assert = require('node:assert');

const { buildStage10PlannerSceneList, stage10SceneHasDraft } = require('../server');

// Scene 1 is written. Scene 22 exists only as a blueprint plan — the shape that made
// the planner return 4 undrafted scenes out of 5 on 2026-08-05, because an empty
// "Draft excerpt:" reads as a truncation rather than an absence while the Blueprint
// line beside it reads as substance.
const SCENES = [
    {
        scene_number: 1,
        scene_heading: 'EXT. HIGHWAY 111 - DAY',
        narrative_action: 'Nora drives into town past the mirage.',
        dramaturgical_function: 'Establish isolation.',
        draft_text: 'EXT. HIGHWAY 111 - DAY\n\nHeat ripples off the asphalt.',
        humanized_draft_text: 'EXT. HIGHWAY 111 - DAY\n\nHeat ripples off the asphalt.'
    },
    {
        scene_number: 22,
        scene_heading: 'EXT. ROCKY BUFFER ZONE - NIGHT',
        narrative_action: 'Ray pursues Nora across the washes at night.',
        dramaturgical_function: 'Raise physical threat.'
        // no draft_text at all
    }
];

test('stage10SceneHasDraft distinguishes written prose from a blueprint plan', () => {
    assert.strictEqual(stage10SceneHasDraft(SCENES[0], {}), true);
    assert.strictEqual(stage10SceneHasDraft(SCENES[1], {}), false);
});

test('whitespace-only draft text does not count as drafted', () => {
    assert.strictEqual(stage10SceneHasDraft({ scene_number: 5, draft_text: '   \n\n  ' }, {}), false);
});

test('a rewrite already staged in the working copy counts as drafted', () => {
    // The working copy is the Stage 10 revision surface: once a scene has been
    // rewritten there it is rewritable again, even though stage6 never held prose.
    assert.strictEqual(stage10SceneHasDraft(SCENES[1], { 22: 'EXT. ROCKY BUFFER ZONE - NIGHT\n\nRay closes in.' }), true);
    assert.strictEqual(stage10SceneHasDraft(SCENES[1], { 22: '' }), false);
});

test('the planner scene list NAMES the absence instead of showing an empty field', () => {
    const list = buildStage10PlannerSceneList(SCENES, {});

    // The written scene is offered for rewriting.
    assert.match(list, /SCENE 1 - EXT\. HIGHWAY 111 - DAY\nStatus: DRAFTED/);
    assert.match(list, /Heat ripples off the asphalt/);

    // The unwritten one is explicitly disqualified, not silently blank. This is the
    // assertion that fails against the old builder, which emitted "Draft excerpt: "
    // with nothing after it and no Status line at all.
    assert.match(list, /SCENE 22 - EXT\. ROCKY BUFFER ZONE - NIGHT\nStatus: NOT DRAFTED — no prose exists yet, CANNOT be rewritten/);
    assert.match(list, /Draft excerpt: \(none — this scene has not been written\)/);
    assert.doesNotMatch(list, /Draft excerpt: *\n/, 'an empty excerpt field must never be emitted');
});

test('the blueprint still reaches the planner for undrafted scenes — it needs the shape of the film', () => {
    const list = buildStage10PlannerSceneList(SCENES, {});
    assert.match(list, /Ray pursues Nora across the washes at night/);
    assert.match(list, /Raise physical threat/);
});

test('a scene rewritten in the working copy is listed as drafted, with that text', () => {
    const list = buildStage10PlannerSceneList(SCENES, { 22: 'EXT. ROCKY BUFFER ZONE - NIGHT\n\nRay closes in on the wash.' });
    assert.match(list, /SCENE 22 - EXT\. ROCKY BUFFER ZONE - NIGHT\nStatus: DRAFTED/);
    assert.match(list, /Ray closes in on the wash/);
});
