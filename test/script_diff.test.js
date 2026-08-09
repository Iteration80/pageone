const test = require('node:test');
const assert = require('node:assert');

const { computeLineDiff, computeWordDiff, computeScriptDiff } = require('../public/script-diff');

// The real case that motivated word-level diffing. In a screenplay an action
// paragraph is ONE Fountain line, so these two edits used to paint the whole block
// red and green and leave the writer to find them by eye.
const ORIG = `EXT. HIGHWAY 111 - DAY

Asphalt cuts through miles of cracked clay and creosote scrub.

Nora keeps her hands steady on the wheel.`;

const REWRITE = `EXT. HIGHWAY 111 - DAY

A narrow strip of asphalt cuts through miles of cracked clay and bleached creosote scrub.

Nora keeps her hands steady on the wheel.`;

test('an identical script reports no changes', () => {
    const d = computeScriptDiff(ORIG, ORIG);
    assert.strictEqual(d.changeCount, 0);
    assert.ok(d.leftAnnotations.every(a => a === null));
    assert.ok(d.rightAnnotations.every(a => a === null));
});

test('unchanged lines are never annotated', () => {
    const d = computeScriptDiff(ORIG, REWRITE);
    const origLines = ORIG.split('\n');
    origLines.forEach((line, i) => {
        if (line.includes('Asphalt cuts')) return;
        assert.strictEqual(d.leftAnnotations[i], null, `line ${i} should be untouched: ${line}`);
    });
});

test('word diff isolates exactly the words that changed', () => {
    const d = computeScriptDiff(ORIG, REWRITE);
    const changedLeft = ORIG.split('\n').findIndex(l => l.includes('Asphalt cuts'));
    const changedRight = REWRITE.split('\n').findIndex(l => l.includes('asphalt cuts'));

    assert.ok(d.leftWords[changedLeft], 'the reworded line should carry word spans');
    assert.ok(d.rightWords[changedRight]);

    // Spans are merged, so assert on the added TEXT rather than on token boundaries.
    const addedText = d.rightWords[changedRight].filter(t => t.kind === 'added').map(t => t.text).join(' ');
    // "A narrow strip of" prepended, "bleached" inserted — and nothing else.
    assert.match(addedText, /bleached/, `expected "bleached" in ${JSON.stringify(addedText)}`);
    assert.match(addedText, /narrow/, `expected "narrow" in ${JSON.stringify(addedText)}`);

    // The bulk of the line must be marked unchanged — that is the entire point.
    // Measured by TEXT, not token count, so the assertion survives span merging.
    const spans = d.rightWords[changedRight];
    const sameText = spans.filter(t => t.kind === 'same').map(t => t.text).join('');
    const wholeLine = spans.map(t => t.text).join('');
    assert.ok(sameText.length > wholeLine.length * 0.6,
        `most of the line should be unchanged: ${sameText.length} of ${wholeLine.length} chars`);
    assert.match(sameText, /cracked/);
    assert.match(sameText, /scrub\./);
});

test('rejoining word spans reproduces the original lines exactly', () => {
    // Whitespace is preserved as its own token, so nothing is lost in rendering.
    const wd = computeWordDiff('the quick  brown fox', 'the slow brown fox');
    const left = wd.left.map(t => t.text).join('');
    const right = wd.right.map(t => t.text).join('');
    assert.strictEqual(left, 'the quick  brown fox');
    assert.strictEqual(right, 'the slow brown fox');
});

test('a wholesale replacement is NOT dressed up as a word edit', () => {
    // Two unrelated lines share almost nothing; showing scattered word matches would
    // be noise. Below the similarity floor, the line stays a plain block change.
    const d = computeScriptDiff('Nora slams the door.', 'Rain hammers the tin roof of the pump house.');
    const hasWordSpans = Object.keys(d.leftWords).length > 0;
    assert.strictEqual(hasWordSpans, false, 'dissimilar lines should not get word spans');
    assert.ok(d.changeCount >= 1);
});

test('contiguous changed lines collapse into ONE navigable change', () => {
    const a = 'keep\nalpha\nbravo\ncharlie\nkeep2';
    const b = 'keep\nALPHA\nBRAVO\nCHARLIE\nkeep2';
    const d = computeScriptDiff(a, b);
    // Three adjacent rewritten lines are one thing the writer steps to, not three.
    assert.strictEqual(d.changeCount, 1);
    assert.strictEqual(d.anchors.length, 1);
});

test('separated changes are counted separately', () => {
    const a = 'one\nkeep\nkeep\nkeep\ntwo';
    const b = 'ONE\nkeep\nkeep\nkeep\nTWO';
    const d = computeScriptDiff(a, b);
    assert.strictEqual(d.changeCount, 2);
});

test('pure insertion and pure deletion are both reported', () => {
    const ins = computeScriptDiff('a\nb', 'a\nNEW\nb');
    assert.ok(ins.rightAnnotations.includes('added'));
    assert.ok(ins.changeCount >= 1);

    const del = computeScriptDiff('a\nGONE\nb', 'a\nb');
    assert.ok(del.leftAnnotations.includes('removed'));
    assert.ok(del.changeCount >= 1);
});

test('whitespace-only differences are not changes', () => {
    const d = computeScriptDiff('Nora waits.', '  Nora waits.  ');
    assert.strictEqual(d.changeCount, 0);
});

test('adjacent spans of the same kind are merged into one', () => {
    // Otherwise every word gets its own box and the SPACE between two changed words
    // renders as its own struck-through span: "NORA VANCE (32) steers" came out
    // looking like "NORA – VANCE – (32) – steers".
    const wd = computeWordDiff('NORA VANCE (32) steers a truck', 'Inside a truck');
    const removedRuns = wd.left.filter(t => t.kind === 'removed');
    assert.strictEqual(removedRuns.length, 1, `expected one merged run, got ${JSON.stringify(wd.left)}`);
    assert.match(removedRuns[0].text, /NORA VANCE \(32\) steers/);
    // And merging must not alter the text.
    assert.strictEqual(wd.left.map(t => t.text).join(''), 'NORA VANCE (32) steers a truck');
    assert.strictEqual(wd.right.map(t => t.text).join(''), 'Inside a truck');
});

test('a blank line does not steal a pairing slot from a reworded paragraph', () => {
    // Found live: an added blank line shifted the pairing so the reworded paragraph
    // was matched against the blank, and a light polish rendered as a wholesale
    // replacement. Blank lines are structure, never a reworded paragraph.
    const before = 'EXT. ROAD - DAY\n\nAsphalt cuts through cracked clay.\n\nNora drives.';
    const after  = 'EXT. ROAD - DAY\n\n\nA narrow strip of asphalt cuts through cracked clay.\n\nNora drives.';
    const d = computeScriptDiff(before, after);

    const rewordedRight = Object.keys(d.rightWords);
    assert.ok(rewordedRight.length > 0, 'the reworded paragraph must still be word-diffed');

    const spans = d.rightWords[rewordedRight[0]];
    const sameText = spans.filter(t => t.kind === 'same').map(t => t.text).join('');
    assert.match(sameText, /cracked/, `expected shared words, got ${JSON.stringify(sameText)}`);
    const addedText = spans.filter(t => t.kind === 'added').map(t => t.text).join(' ');
    assert.match(addedText, /narrow/, `expected "narrow" added, got ${JSON.stringify(addedText)}`);
});

test('computeLineDiff keeps its original annotation contract', () => {
    // app.js still calls this directly for the left-pane render; the shape must hold.
    const { leftAnnotations, rightAnnotations } = computeLineDiff('a\nb', 'a\nc');
    assert.strictEqual(leftAnnotations.length, 2);
    assert.strictEqual(rightAnnotations.length, 2);
    assert.strictEqual(leftAnnotations[0], null);
    assert.strictEqual(leftAnnotations[1], 'removed');
    assert.strictEqual(rightAnnotations[1], 'added');
});

// ─── Hunks + per-change rejection (Stage 9 accept/reject, restore-from-left) ──

const { computeHunks, mergeHunks } = require('../public/script-diff');

test('computeHunks reports one hunk per contiguous change, with full line indices', () => {
    const hunks = computeHunks(ORIG, REWRITE);
    assert.strictEqual(hunks.length, 1);
    assert.deepStrictEqual(hunks[0].removed, [2]);
    assert.deepStrictEqual(hunks[0].added, [2]);
    assert.match(hunks[0].removedText, /^Asphalt cuts/);
    assert.match(hunks[0].addedText, /^A narrow strip/);
});

test('rejecting a reworded paragraph restores the original text byte-identically', () => {
    assert.strictEqual(mergeHunks(ORIG, REWRITE, [0]), ORIG);
});

test('rejecting no hunks reproduces the proposed text byte-identically', () => {
    assert.strictEqual(mergeHunks(ORIG, REWRITE, []), REWRITE);
});

test('rejecting one of two separated changes keeps the other', () => {
    const a = 'one\n\nkeep\n\ntwo';
    const b = 'ONE\n\nkeep\n\nTWO';
    const hunks = computeHunks(a, b);
    assert.strictEqual(hunks.length, 2);
    assert.strictEqual(mergeHunks(a, b, [0]), 'one\n\nkeep\n\nTWO');
    assert.strictEqual(mergeHunks(a, b, [1]), 'ONE\n\nkeep\n\ntwo');
    assert.strictEqual(mergeHunks(a, b, [0, 1]), a);
});

test('restoring a deleted paragraph brings its blank-line separation back with it', () => {
    // The blank line is what makes the next line a character cue in Fountain —
    // splicing the paragraph back without it would glue it onto its neighbour.
    const orig = 'EXT. ROAD - DAY\n\nThe engine ticks.\n\nNORA\nWe walk from here.';
    const cut  = 'EXT. ROAD - DAY\n\nNORA\nWe walk from here.';
    const hunks = computeHunks(orig, cut);
    assert.strictEqual(hunks.length, 1);
    assert.deepStrictEqual(hunks[0].added, []);
    assert.strictEqual(mergeHunks(orig, cut, [0]), orig);
});

test('rejecting a pure insertion removes it without leaving doubled blank lines', () => {
    const orig = 'EXT. ROAD - DAY\n\nNora drives.';
    const ins  = 'EXT. ROAD - DAY\n\nRain streaks the glass.\n\nNora drives.';
    assert.strictEqual(mergeHunks(orig, ins, [0]), orig);
});

test('restoring a deleted FIRST paragraph re-separates it from what follows', () => {
    // The follower is the first non-blank line of the proposed text, so its own
    // source has no predecessor to measure a gap against — the gap must come from
    // the original, or the restored paragraph glues onto the line after it.
    const orig = 'Thunder rolls in the distance.\n\nEXT. ROAD - DAY\n\nNora drives.';
    const cut  = 'EXT. ROAD - DAY\n\nNora drives.';
    assert.strictEqual(mergeHunks(orig, cut, [0]), orig);
});

test('rejection keeps dialogue blocks intact (no blank line invented inside them)', () => {
    const orig = 'NORA\n(quietly)\nWe walk from here.';
    const rew  = 'NORA\n(flat)\nWe walk. Now.';
    const hunks = computeHunks(orig, rew);
    assert.strictEqual(mergeHunks(orig, rew, hunks.map((_, k) => k)), orig);
});

test('mergeHunks and computeHunks agree on hunk numbering', () => {
    // Reject via indices from computeHunks; every hunk rejected must equal the
    // original for any mix of edits, insertions and deletions.
    const orig = 'SLUG\n\nalpha\n\nbravo\n\nNORA\nline one\n\ncharlie';
    const rew  = 'SLUG\n\nALPHA reworded\n\nNORA\nline one changed\n\ncharlie\n\nnew tail';
    const hunks = computeHunks(orig, rew);
    assert.ok(hunks.length >= 2, `expected multiple hunks, got ${hunks.length}`);
    assert.strictEqual(mergeHunks(orig, rew, hunks.map((_, k) => k)), orig);
});
