const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { LAYOUT, parseFountain, wrapText, layoutScreenplay } = require('../public/screenplay-layout');

// Layout constants the assertions below are derived from. If these change, the
// derived numbers change with them — recompute, don't fudge.
const { TOP, BOTTOM, LINE_H, CONTENT_W, DIAL_W } = LAYOUT;

test('parseFountain emits exactly one element per source line', () => {
    // The Stage 7 pagination overlay relies on this 1:1 mapping — element k of a
    // scene is line k of its text, which is child div k of its rendered block.
    const text = 'INT. KITCHEN - DAY\n\nThe kettle screams.\n\nNORA\n(dry)\nLet it.';
    const els = parseFountain(text);
    assert.strictEqual(els.length, text.split('\n').length);
    assert.deepStrictEqual(els.map(e => e.type),
        ['scene', 'blank', 'action', 'blank', 'character', 'parenthetical', 'dialogue']);
});

test('per-scene parse joined by one blank equals the whole-text parse', () => {
    // The exporter parses scenes.join('\n\n'); the browser parses per scene and
    // inserts one blank element between scenes. Both constructions must agree,
    // or the on-screen pages would come from a different document.
    const a = 'INT. A - DAY\n\nAction here.\n\nNORA\nLine.';
    const b = 'EXT. B - NIGHT\n\nMore action.';
    const whole = parseFountain(a + '\n\n' + b);
    const joined = [...parseFountain(a), { type: 'blank' }, ...parseFountain(b)];
    assert.deepStrictEqual(whole, joined);
});

test('a full page holds the derived number of single-height lines', () => {
    // One-line actions with no blanks: lines land at TOP, TOP+LINE_H, … and the
    // last one that fits starts at or before BOTTOM-LINE_H. With the closing
    // FADE OUT (one leading line-height plus one line), 44 fit on one page and
    // the 45th pushes FADE OUT to page 2.
    const el = (n) => Array.from({ length: n }, () => ({ type: 'action', text: 'x' }));
    assert.strictEqual(layoutScreenplay(el(44)).pageCount, 1);
    assert.strictEqual(layoutScreenplay(el(45)).pageCount, 2);
});

test('a scene heading near the bottom moves to the next page whole', () => {
    // The 3-line lookahead: a heading must never be orphaned at a page bottom.
    const els = Array.from({ length: 43 }, () => ({ type: 'action', text: 'x' }));
    els.push({ type: 'scene', text: 'INT. LATER - DAY' });
    const layout = layoutScreenplay(els);
    assert.strictEqual(layout.pageOfElement[42], 1, 'last action stays on page 1');
    assert.strictEqual(layout.pageOfElement[43], 2, 'the heading starts page 2');
    assert.strictEqual(layout.pageStarts[0].elIndex, 43);
});

test('wrap widths follow the exporter estimate (Courier ~7.2pt per char)', () => {
    const actionChars = Math.floor(CONTENT_W / 7.2);   // 60
    const dialogueChars = Math.floor(DIAL_W / 7.2);    // 35
    const word = 'abcde';
    const sentence = Array.from({ length: 30 }, () => word).join(' '); // 179 chars
    assert.strictEqual(wrapText(sentence, CONTENT_W).length, Math.ceil(180 / (actionChars + 1)));
    assert.ok(wrapText(sentence, DIAL_W).length > wrapText(sentence, CONTENT_W).length,
        'dialogue wraps narrower than action');
    // Rejoining reproduces the words.
    assert.strictEqual(wrapText(sentence, DIAL_W).join(' '), sentence);
});

test('pageOfElement records the page of an element\'s FIRST printed line', () => {
    // A long action straddling a page boundary: its first line's page is what a
    // scene chip shows; the page turn inside it appears in pageStarts.
    const filler = Array.from({ length: 43 }, () => ({ type: 'action', text: 'x' }));
    const long = { type: 'action', text: Array.from({ length: 60 }, () => 'word').join(' ') }; // wraps to 5 lines
    const layout = layoutScreenplay([...filler, long]);
    assert.strictEqual(layout.pageOfElement[43], 1, 'starts on page 1');
    assert.ok(layout.pageStarts.some(ps => ps.page === 2 && ps.elIndex === 43),
        'page 2 starts inside the long paragraph');
});

test('the closing FADE OUT is layout furniture with elIndex -1', () => {
    const layout = layoutScreenplay([{ type: 'action', text: 'x' }]);
    const last = layout.ops[layout.ops.length - 1];
    assert.strictEqual(last.text, 'FADE OUT.');
    assert.strictEqual(last.elIndex, -1);
});

test('the PDF exporter draws the page count the layout computed', async () => {
    // Real invocation, not a source-string claim: the exporter's physical page
    // count must equal layout.pageCount plus the title page. This is the guard
    // against the drawing loop and the layout walk drifting apart.
    const { generateScreenplayPdf } = require('../agents/export');
    const sceneText = (n) => `INT. ROOM ${n} - DAY\n\n` +
        Array.from({ length: 20 }, (_, i) => `Paragraph ${i} of scene ${n} walks across the page with enough words to wrap at least once at action width.`).join('\n\n');
    const scenes = Array.from({ length: 4 }, (_, n) => ({ humanized_draft_text: sceneText(n + 1) }));

    const flatText = scenes.map(s => s.humanized_draft_text.trim()).join('\n\n');
    const layout = layoutScreenplay(parseFountain(flatText));
    assert.ok(layout.pageCount >= 3, `fixture should span several pages, got ${layout.pageCount}`);

    const buf = await generateScreenplayPdf(scenes, 'Fixture', '');
    const m = buf.toString('latin1').match(/\/Type \/Pages[\s\S]{0,80}?\/Count (\d+)/);
    assert.ok(m, 'PDF must contain a page tree count');
    assert.strictEqual(Number(m[1]), layout.pageCount + 1,
        'physical pages = content pages + title page');
});

test('the Stage 7 overlay renders from the shared module, not an estimate', () => {
    // Structural pin (no jsdom in this project): the pagination renderer must
    // read window.ScreenplayLayout and be invoked by the continuous-view render.
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const start = appJs.indexOf('function stage8RenderPagination(');
    assert.notStrictEqual(start, -1);
    const body = appJs.slice(start, appJs.indexOf('\n    }', appJs.indexOf('inserts.forEach', start)));
    assert.ok(body.includes('window.ScreenplayLayout.layoutScreenplay('), 'must use the shared layout walk');
    assert.ok(body.includes('window.ScreenplayLayout.parseFountain('), 'must use the shared parser');
    assert.ok(!/\b55\b|LINES_PER_PAGE/.test(body), 'no independent lines-per-page estimate');

    const cont = appJs.slice(appJs.indexOf('function stage8RenderContinuous('), start);
    assert.ok(cont.includes('stage8RenderPagination()'),
        'the continuous-view render must refresh pagination');
});
