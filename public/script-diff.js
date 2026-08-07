/**
 * script-diff.js — line and word level diffing for the Stage 9 compare view.
 *
 * Shared by the browser (loaded via <script>) and the test suite (require'd), so
 * the diff logic is unit-testable without a DOM.
 *
 * Why word level: the original Stage 9 view diffed by LINE, and in a screenplay a
 * whole action paragraph is one Fountain line. Changing two words therefore painted
 * four lines red and four green and left the writer to spot the difference by eye —
 * measured on a real rewrite where the only edits were "Asphalt cuts through…" ->
 * "A narrow strip of asphalt cuts through…" and "creosote" -> "bleached creosote".
 * Line granularity tells you THAT something changed; word granularity tells you WHAT.
 */

/* eslint-disable no-bitwise */

/** Longest-common-subsequence table for two token arrays. */
function lcsTable(a, b, eq) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = eq(a[i - 1], b[j - 1])
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp;
}

const sameLine = (x, y) => x.trim() === y.trim();

/** Fraction of the shorter line's words that both lines share. 0 = nothing in common. */
function lineSimilarity(a, b) {
    const wordsOf = (s) => String(s || '').toLowerCase().match(/[^\s]+/g) || [];
    const aw = wordsOf(a), bw = wordsOf(b);
    if (!aw.length || !bw.length) return 0;
    const pool = new Map();
    for (const w of bw) pool.set(w, (pool.get(w) || 0) + 1);
    let shared = 0;
    for (const w of aw) {
        const n = pool.get(w);
        if (n) { shared++; pool.set(w, n - 1); }
    }
    return shared / Math.min(aw.length, bw.length);
}

/**
 * Line-level diff. Returns per-line annotations plus the changed regions paired up,
 * so a caller can run a word diff inside each pair.
 *
 * @returns {{leftAnnotations:(string|null)[], rightAnnotations:(string|null)[], pairs:{left:number,right:number}[]}}
 */
function computeLineDiff(origText, proposedText) {
    const allOrig = String(origText || '').split('\n');
    const allNew = String(proposedText || '').split('\n');

    // Diff only the NON-BLANK lines.
    //
    // Blank lines are formatting, not content, and letting them into the LCS is
    // actively harmful: they are all identical, so when two drafts have different
    // paragraph counts the algorithm is free to match any blank to any blank, and
    // it picks an alignment that drags the real paragraphs out of correspondence.
    // Measured on a real rewrite (13 lines vs 9): two blanks were marked "removed"
    // and paragraph 6 was paired against paragraph 2 — two completely unrelated
    // pieces of prose — so a light polish rendered as a wholesale replacement.
    // Indices below are into the FILTERED sequence and mapped back at the end.
    const origIdx = [], newIdx = [];
    allOrig.forEach((l, i) => { if (l.trim()) origIdx.push(i); });
    allNew.forEach((l, i) => { if (l.trim()) newIdx.push(i); });
    const origLines = origIdx.map(i => allOrig[i]);
    const newLines = newIdx.map(i => allNew[i]);

    const dp = lcsTable(origLines, newLines, sameLine);

    const leftAnnotations = new Array(allOrig.length).fill(null);
    const rightAnnotations = new Array(allNew.length).fill(null);

    // Backtrack from the end — the table holds PREFIX lengths, so a forward walk
    // cannot decide moves from it. (Doing exactly that marked every line in the
    // script as changed, which the "separated changes" test caught.) Collect
    // backwards, then reverse into document order so runs can be paired.
    const ops = [];
    let i = origLines.length, j = newLines.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && sameLine(origLines[i - 1], newLines[j - 1])) {
            ops.push({ kind: 'same', i: i - 1, j: j - 1 }); i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            rightAnnotations[newIdx[j - 1]] = 'added'; ops.push({ kind: 'added', j: j - 1 }); j--;
        } else {
            leftAnnotations[origIdx[i - 1]] = 'removed'; ops.push({ kind: 'removed', i: i - 1 }); i--;
        }
    }
    ops.reverse();

    // Within each contiguous changed run, work out which removed line corresponds to
    // which added line — that correspondence is what a "reworded paragraph" is.
    const pairs = [];
    let k = 0;
    while (k < ops.length) {
        if (ops[k].kind === 'same') { k++; continue; }
        const removed = [], added = [];
        while (k < ops.length && ops[k].kind !== 'same') {
            if (ops[k].kind === 'removed') removed.push(ops[k].i); else added.push(ops[k].j);
            k++;
        }
        // Pair by SIMILARITY, not by position in the run.
        //
        // Position pairing looked fine and broke on the first real rewrite: when the
        // two versions have different line counts (13 vs 9 here), the nth removed
        // line is no longer the nth added line, so a lightly-reworded paragraph got
        // matched against an unrelated one and rendered as a wholesale replacement.
        // Greedy best-match is what the feature actually needs — find, for each
        // removed line, the added line it most resembles.
        const scored = [];
        for (const li of removed) {
            for (const ri of added) {
                scored.push({ li, ri, score: lineSimilarity(origLines[li], newLines[ri]) });
            }
        }
        scored.sort((x, y) => y.score - x.score);
        const usedLeft = new Set(), usedRight = new Set();
        for (const { li, ri, score } of scored) {
            if (score <= 0 || usedLeft.has(li) || usedRight.has(ri)) continue;
            usedLeft.add(li); usedRight.add(ri);
            pairs.push({ left: origIdx[li], right: newIdx[ri] });
        }
    }

    return { leftAnnotations, rightAnnotations, pairs };
}

/** Split into words while keeping the whitespace, so rejoining reproduces the line. */
function tokenizeWords(line) {
    return String(line || '').match(/\s+|[^\s]+/g) || [];
}

/**
 * Word-level diff of two lines.
 * @returns {{left:{text:string,kind:string}[], right:{text:string,kind:string}[]}}
 */
function computeWordDiff(leftLine, rightLine) {
    const a = tokenizeWords(leftLine);
    const b = tokenizeWords(rightLine);
    const eq = (x, y) => x === y;
    const dp = lcsTable(a, b, eq);

    // Same backward backtrack as computeLineDiff, for the same reason.
    const left = [], right = [];
    let i = a.length, j = b.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && eq(a[i - 1], b[j - 1])) {
            left.push({ text: a[i - 1], kind: 'same' });
            right.push({ text: b[j - 1], kind: 'same' });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            right.push({ text: b[j - 1], kind: 'added' }); j--;
        } else {
            left.push({ text: a[i - 1], kind: 'removed' }); i--;
        }
    }
    left.reverse(); right.reverse();
    return { left: mergeRuns(left), right: mergeRuns(right) };
}

/**
 * Collapse consecutive tokens of the same kind into one span.
 *
 * Without this every word gets its own box and the whitespace between two changed
 * words is itself rendered as a struck-through span — "NORA VANCE (32) steers" came
 * out looking like "NORA – VANCE – (32) – steers". Merging is purely presentational:
 * concatenating the runs reproduces the same text.
 */
function mergeRuns(tokens) {
    const out = [];
    for (const tok of tokens) {
        const last = out[out.length - 1];
        if (last && last.kind === tok.kind) last.text += tok.text;
        else out.push({ text: tok.text, kind: tok.kind });
    }
    return out;
}

/**
 * Full compare model for one scene: line annotations, word spans inside reworded
 * lines, a change count and the line indices to jump between.
 */
function computeScriptDiff(origText, proposedText) {
    const { leftAnnotations, rightAnnotations, pairs } = computeLineDiff(origText, proposedText);
    const origLines = String(origText || '').split('\n');
    const newLines = String(proposedText || '').split('\n');

    const leftWords = {}, rightWords = {};
    for (const { left, right } of pairs) {
        // Only worth a word diff if the two lines are recognisably the same line
        // reworded; otherwise a wholesale replacement reads better as one block.
        const wd = computeWordDiff(origLines[left], newLines[right]);
        const sameCount = wd.left.filter(t => t.kind === 'same' && t.text.trim()).length;
        const leftWordCount = wd.left.filter(t => t.text.trim()).length;
        if (sameCount > 0 && sameCount >= Math.max(1, leftWordCount * 0.3)) {
            leftWords[left] = wd.left;
            rightWords[right] = wd.right;
        }
    }

    // A "change" is a contiguous run of annotated lines on either side — that is
    // what the writer steps through, not individual lines.
    const anchors = [];
    let run = null;
    const maxLen = Math.max(origLines.length, newLines.length);
    for (let idx = 0; idx < maxLen; idx++) {
        const touched = leftAnnotations[idx] || rightAnnotations[idx];
        if (touched && !run) run = { left: idx, right: idx };
        else if (!touched && run) { anchors.push(run); run = null; }
    }
    if (run) anchors.push(run);

    return {
        leftAnnotations,
        rightAnnotations,
        leftWords,
        rightWords,
        anchors,
        changeCount: anchors.length
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeLineDiff, computeWordDiff, computeScriptDiff, tokenizeWords };
}
if (typeof window !== 'undefined') {
    window.ScriptDiff = { computeLineDiff, computeWordDiff, computeScriptDiff, tokenizeWords };
}
