const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PITCH_SCHEMA, PITCH_ITEM_SCHEMA, PITCH_FIELDS } = require('../agents/agent_1_pitch');
const { REFINE_PITCH_SCHEMA } = require('../agents/agent_1_refine');
const { STAGE_SCHEMAS } = require('../agents/stage_schemas');

// 2026-09-07 — Stage 1 gained a real SOP (skills/skill_stage1_pitch.md) and four
// premise fields. This suite exists because of two standing lessons in this repo:
//
//  1. A numeric or field contract that lives only in a prompt is not a contract
//     (Stage 1's own "three pitches" was the first of four such bugs) — so the
//     fields are REQUIRED in the schema and this test pins that.
//  2. "When you change what a field contains, grep its readers." A field the
//     model returns but no reader displays is paid-for work the writer never sees;
//     the 07-30 Stage 2 annotation fields were un-revisable for exactly that
//     reason. Every reader is listed here so adding a field fails loudly until
//     each one has been taught the new name.

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const NEW_FIELDS = ['premise', 'controlling_idea', 'stakes', 'dramatic_kernel'];

test('the four premise fields are REQUIRED in the schema, not merely allowed', () => {
    for (const field of NEW_FIELDS) {
        assert.ok(PITCH_ITEM_SCHEMA.properties[field], `${field} missing from properties`);
        assert.ok(PITCH_ITEM_SCHEMA.required.includes(field), `${field} must be required`);
    }
    // The original five survive untouched — saved pitches and every legacy reader depend on them.
    for (const field of ['title', 'logline', 'genre', 'core_theme', 'synopsis']) {
        assert.ok(PITCH_ITEM_SCHEMA.required.includes(field), `${field} must stay required`);
    }
    assert.deepEqual(PITCH_FIELDS, Object.keys(PITCH_ITEM_SCHEMA.properties));
});

test('generate, refine and the admin Verify probe all hold the SAME schema object', () => {
    // Identity, not deep-equality: a copy that happens to match today drifts tomorrow.
    assert.strictEqual(REFINE_PITCH_SCHEMA, PITCH_ITEM_SCHEMA, 'agent_1_refine must import the generator schema');
    assert.strictEqual(PITCH_SCHEMA.properties.pitch_options.items, PITCH_ITEM_SCHEMA);
    assert.strictEqual(STAGE_SCHEMAS[1].schema, PITCH_SCHEMA, 'Verify must probe the object that runs');
    assert.doesNotMatch(read('agents/agent_1_refine.js'), /const pitchSchema = \{/, 'no private schema copy in the refine agent');
});

test('the Stage 1 SOP defines every schema field by name and is what both agents send', () => {
    const sop = read('skills/skill_stage1_pitch.md');
    for (const field of PITCH_FIELDS) {
        assert.match(sop, new RegExp('`' + field + '`'), `SOP must define \`${field}\``);
    }
    // The checkable machinery the SOP was written to carry.
    assert.match(sop, /leads to/);                 // Egri triad
    assert.match(sop, /VALUE .*because CAUSE/);    // McKee controlling idea
    assert.match(sop, /Life or death/);            // Bork stakes ladder
    assert.match(sop, /returns to normal/);        // McKee risk test
    assert.match(sop, /removed, collapses the story/); // dramatic kernel
    assert.match(sop, /not a tagline/);            // Hoxter logline discipline
    assert.match(sop, /Know the ending first/);    // Field

    assert.match(read('agents/agent_1_pitch.js'), /systemInstruction: loadSkill\('skill_stage1_pitch'\)/);
    const refine = read('agents/agent_1_refine.js');
    assert.equal((refine.match(/loadSkill\('skill_stage1_pitch'\)/g) || []).length, 2, 'both refine paths carry the SOP');
});

test('every reader of the pitch object knows the new fields', () => {
    const appJs = read('public/app.js');
    const treatment = read('agents/agent_5_treatment.js');
    const exportJs = read('agents/export.js');
    const outlineSop = read('skills/skill_stage2_outline.md');

    for (const field of NEW_FIELDS) {
        // The pitch card — the one surface the writer actually edits. Without this the
        // model's answer is returned, billed, and never seen.
        assert.match(appJs, new RegExp(`data-field="${field}"`), `pitch card must render ${field}`);
        // Treatment prompt metadata (server) and its browser-side fallback twin.
        assert.match(treatment, new RegExp(`pitch\\.${field}`), `agent_5 must pass ${field}`);
        assert.match(appJs, new RegExp(`if \\(pitch\\.${field}\\) lines\\.push`), `treatment fallback must pass ${field}`);
        // DOCX export of the pitch page.
        assert.match(exportJs, new RegExp(`pitch\\.${field}`), `export must print ${field}`);
        // Version-history snapshot text.
        assert.match(appJs, new RegExp(`if \\(p\\.${field}\\) out \\+=`), `snapshot text must print ${field}`);
    }
    // Stage 2 receives the whole pitch JSON; its SOP must say what to DO with the fields.
    for (const field of NEW_FIELDS) {
        assert.match(outlineSop, new RegExp('`' + field + '`'), `Stage 2 SOP must reference \`${field}\``);
    }
    assert.match(outlineSop, /the outline proves it/i);
    // Live on 2026-09-07 (fresh project, gemini-3.6-flash): the first outline generated after
    // Stage 2 learned the field names titled its Midpoint beat "The Dramatic Kernel". Telling a
    // model a field exists teaches it a word; the SOP must also say the word is not story.
    assert.match(outlineSop, /never titled or described as "The Dramatic Kernel"/);
    // Second fresh generation, same day: the label was clean but genre_variation_notes read
    // "Features the dramatic kernel: ...". Titles and descriptions were named; annotations were not.
    assert.match(outlineSop, /never write "features the dramatic kernel"/);
});

test('the pitch card tolerates a pitch saved before the fields existed', () => {
    // Legacy pitches lack the four fields. escapeHtml(undefined) is '' here, but the
    // card must not render the string "undefined" if that helper ever changes.
    const appJs = read('public/app.js');
    for (const field of NEW_FIELDS) {
        assert.match(appJs, new RegExp(`escapeHtml\\(pitch\\.${field} \\|\\| ''\\)`), `${field} needs a legacy fallback`);
    }
});
