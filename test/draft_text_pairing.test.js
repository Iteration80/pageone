const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

/**
 * A scene's text lives in two fields, and every reader in the codebase resolves them
 * the same way: `humanized_draft_text || draft_text`. The PDF export, the DOCX export,
 * the coverage script assembly, the Stage 10 planner and the Stage 8 editor itself all
 * do it.
 *
 * So a writer's manual edit that lands in `draft_text` alone is invisible. That is not
 * hypothetical: until 2026-08-05 `stage8FlushEditor` assigned only `draft_text`, the
 * save returned 200, the editor marked itself clean — and the edit appeared in nothing.
 * Verified by appending a marker and exporting: absent from the PDF with one field
 * written, present with both.
 *
 * This is deliberately STRUCTURAL rather than a match on the current line: it fails on
 * the next unpaired assignment too, whatever it is called and wherever it is added.
 */

function findUnpairedDraftTextWrites(source) {
    const lines = source.split('\n');
    const unpaired = [];

    lines.forEach((line, i) => {
        // An assignment to <something>.draft_text — not a comparison, not a read.
        const assign = line.match(/(\w+)\.draft_text\s*=(?!=)/);
        if (!assign) return;

        const receiver = assign[1];
        // Look for the matching humanized write on the same receiver, within a small
        // window either side (comment blocks sit between them).
        const window = lines.slice(Math.max(0, i - 12), i + 13).join('\n');
        const paired = new RegExp(`${receiver}\\.humanized_draft_text\\s*=(?!=)`).test(window);
        if (!paired) unpaired.push({ line: i + 1, text: line.trim() });
    });

    return unpaired;
}

test('no client-side write to draft_text leaves humanized_draft_text stale', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    const unpaired = findUnpairedDraftTextWrites(appJs);
    assert.deepStrictEqual(
        unpaired,
        [],
        `Unpaired draft_text write(s) — every reader prefers humanized_draft_text, so these edits would be invisible:\n${unpaired.map(u => `  public/app.js:${u.line}  ${u.text}`).join('\n')}`
    );
});

test('the editor flush writes both fields', () => {
    const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
    assert.match(appJs, /scene\.draft_text = newText;\s*\n\s*scene\.humanized_draft_text = newText;/);
});

// The detector has to actually fail on the shape it exists to catch, or it is a
// decoration that reports health forever (cf. the beforeGuard assertion that pinned a
// line while the guard it named never ran).
test('the detector fails against the broken code it was written for', () => {
    const broken = `
        const newText = stage8Editor.toFountain();
        scene.draft_text = newText;

        if (!activeProjectId) return true;
    `;
    const found = findUnpairedDraftTextWrites(broken);
    assert.strictEqual(found.length, 1, 'the pre-fix flush must be reported as unpaired');
    assert.match(found[0].text, /scene\.draft_text = newText;/);
});

test('the detector does not fire when both fields are written', () => {
    const fixed = `
        scene.draft_text = newText;
        scene.humanized_draft_text = newText;
    `;
    assert.deepStrictEqual(findUnpairedDraftTextWrites(fixed), []);
});

test('the detector is receiver-aware — a different object nearby does not count as pairing', () => {
    const sneaky = `
        scene.draft_text = newText;
        other.humanized_draft_text = newText;
    `;
    assert.strictEqual(findUnpairedDraftTextWrites(sneaky).length, 1);
});

test('reads and comparisons are not mistaken for writes', () => {
    const reads = `
        if (scene.draft_text === other.draft_text) return;
        const t = scene.humanized_draft_text || scene.draft_text;
        const drafted = scenes.filter(s => s.draft_text || s.humanized_draft_text);
    `;
    assert.deepStrictEqual(findUnpairedDraftTextWrites(reads), []);
});
