/**
 * screenplay-layout.js — Fountain parsing and the screenplay PAGE layout walk.
 *
 * Shared by the PDF exporter (agents/export.js, via require) and the browser
 * (Stage 7 continuous view, via <script>), exactly like script-diff.js.
 *
 * Why shared: the plan's pagination rule (spec 2026-08-06, item 6) — on-screen
 * page numbers must be computed with the EXPORTER'S OWN MATH, never an
 * independent estimate. Two page counts that disagree are worse than one that
 * is missing, because the writer cannot tell which one the reader will see.
 * Making the exporter draw from this module is what enforces that: there is no
 * second implementation to drift.
 *
 * parseFountain and every constant here were MOVED verbatim from
 * agents/export.js; layoutScreenplay replays generateScreenplayPdf's drawing
 * walk op for op, minus the drawing.
 */

/* Layout constants — US Letter, 12pt Courier, standard screenplay margins. */
const LAYOUT = {
    PW: 612,          // 8.5"
    PH: 792,          // 11"
    LEFT: 108,        // 1.5"
    RIGHT: 540,       // 7.5" (1" right margin)
    TOP: 72,          // 1"
    BOTTOM: 720,      // 10"
    CONTENT_W: 432,   // RIGHT - LEFT, 6"
    CHAR_X: 266,      // 3.7" from left edge
    DIAL_X: 180,      // 2.5"
    DIAL_W: 252,      // 3.5"
    PAREN_X: 223,     // 3.1"
    PAREN_W: 180,     // 2.5"
    LINE_H: 14,       // ~1 line at 12pt Courier
    FONT_SIZE: 12
};

function parseFountain(text) {
    const lines = text.split('\n');
    const elements = [];

    let i = 0;
    while (i < lines.length) {
        const raw = lines[i];
        const line = raw.trimEnd();
        const trimmed = line.trim();

        // Blank line
        if (!trimmed) {
            elements.push({ type: 'blank' });
            i++;
            continue;
        }

        // Forced scene heading: .INT...
        if (trimmed.startsWith('.') && !trimmed.startsWith('..')) {
            elements.push({ type: 'scene', text: trimmed.slice(1).trim() });
            i++;
            continue;
        }

        // Scene heading: INT./EXT.
        if (/^(INT\.|EXT\.|INT\.\/EXT\.|I\/E\.)/i.test(trimmed)) {
            elements.push({ type: 'scene', text: trimmed });
            i++;
            continue;
        }

        // Transition: ends with TO: or specific keywords
        if (/^(FADE\s+IN:|FADE\s+OUT\.|FADE\s+TO:|SMASH\s+CUT\s+TO:|CUT\s+TO:)$/i.test(trimmed) ||
            trimmed.endsWith(' TO:') || trimmed === 'FADE OUT.') {
            elements.push({ type: 'transition', text: trimmed });
            i++;
            continue;
        }

        // Forced transition: > at start
        if (trimmed.startsWith('>') && !trimmed.endsWith('<')) {
            elements.push({ type: 'transition', text: trimmed.slice(1).trim() });
            i++;
            continue;
        }

        // Centered text: > text <
        if (trimmed.startsWith('>') && trimmed.endsWith('<')) {
            elements.push({ type: 'centered', text: trimmed.slice(1, -1).trim() });
            i++;
            continue;
        }

        // Character cue: all caps (possibly with extensions like (V.O.), (O.S.))
        // Must be preceded by blank line (or start of document), not followed by blank
        const prevIsBlank = i === 0 || !lines[i - 1].trim();
        const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
        // Strip extension for the caps check
        const cueBase = trimmed.replace(/\s*\([^)]*\)\s*$/, '').trim();
        const cueIsAllCaps = cueBase === cueBase.toUpperCase() && /[A-Z]/.test(cueBase);

        if (cueIsAllCaps && prevIsBlank && nextLine) {
            elements.push({ type: 'character', text: trimmed });
            i++;
            // Collect dialogue / parentheticals
            while (i < lines.length) {
                const dline = lines[i].trim();
                if (!dline) break;
                if (dline.startsWith('(') && dline.endsWith(')')) {
                    elements.push({ type: 'parenthetical', text: dline });
                } else {
                    elements.push({ type: 'dialogue', text: dline });
                }
                i++;
            }
            continue;
        }

        // Action (default)
        elements.push({ type: 'action', text: trimmed });
        i++;
    }

    return elements;
}

/** The exporter's wrap estimate: Courier 12pt ≈ 7.2pt per character. */
function wrapText(text, maxW) {
    const charsPerLine = Math.floor(maxW / 7.2);
    const words = String(text || '').split(' ');
    let line = '';
    const wrappedLines = [];
    words.forEach(w => {
        if ((line + ' ' + w).trim().length > charsPerLine) {
            wrappedLines.push(line.trim());
            line = w;
        } else {
            line = (line + ' ' + w).trim();
        }
    });
    if (line) wrappedLines.push(line);
    return wrappedLines;
}

/**
 * Replay of generateScreenplayPdf's drawing walk without a PDF: same spacing,
 * same page-break lookaheads, same wrap estimate. Content pages are numbered
 * from 1 — the title page is front matter and is not counted (screenplay
 * convention; Final Draft does the same).
 *
 * @param {Array} elements - parseFountain output
 * @returns {{
 *   ops: {elIndex:number, text:string, x:number, width:number, page:number,
 *          y:number, font:string, align:string}[],
 *   pageCount: number,
 *   pageOfElement: (number|null)[],   // page the element's FIRST printed line lands on
 *   pageStarts: {page:number, elIndex:number}[]  // first printed line of each page ≥ 2
 * }}
 */
function layoutScreenplay(elements) {
    const { LEFT, TOP, BOTTOM, CONTENT_W, CHAR_X, DIAL_X, DIAL_W, PAREN_X, PAREN_W, LINE_H } = LAYOUT;

    const ops = [];
    const pageOfElement = new Array(elements.length).fill(null);
    const pageStarts = [];

    let page = 1;
    let y = TOP;
    let atPageStart = true; // next printed line is the first on its page

    function breakPage() {
        page++;
        y = TOP;
        atPageStart = true;
    }

    function checkPageBreak(needed) {
        if (y + needed > BOTTOM) breakPage();
    }

    function writeLine(elIndex, text, x, width, font, align) {
        checkPageBreak(LINE_H);
        if (atPageStart && page > 1) pageStarts.push({ page, elIndex });
        atPageStart = false;
        if (elIndex >= 0 && pageOfElement[elIndex] === null) pageOfElement[elIndex] = page;
        ops.push({ elIndex, text, x, width, page, y, font: font || 'Courier', align: align || 'left' });
        y += LINE_H;
    }

    function writeWrapped(elIndex, text, x, maxW, font, align) {
        wrapText(text, maxW).forEach(l => writeLine(elIndex, l, x, maxW, font, align));
    }

    let prevType = null;

    elements.forEach((el, elIndex) => {
        switch (el.type) {
            case 'blank':
                y += LINE_H * 0.5;
                break;

            case 'scene':
                // Extra space before scene heading
                if (prevType && prevType !== 'blank') y += LINE_H;
                checkPageBreak(LINE_H * 3);
                writeLine(elIndex, el.text.toUpperCase(), LEFT, CONTENT_W, 'Courier-Bold');
                y += LINE_H * 0.5;
                break;

            case 'action':
                writeWrapped(elIndex, el.text, LEFT, CONTENT_W);
                break;

            case 'character':
                y += LINE_H * 0.5;
                checkPageBreak(LINE_H * 3);
                writeLine(elIndex, el.text.toUpperCase(), CHAR_X, CONTENT_W - (CHAR_X - LEFT));
                break;

            case 'parenthetical':
                writeLine(elIndex, el.text, PAREN_X, PAREN_W);
                break;

            case 'dialogue':
                writeWrapped(elIndex, el.text, DIAL_X, DIAL_W);
                break;

            case 'transition':
                y += LINE_H * 0.5;
                writeLine(elIndex, el.text.toUpperCase(), LEFT, CONTENT_W, 'Courier', 'right');
                y += LINE_H * 0.5;
                break;

            case 'centered':
                writeLine(elIndex, el.text, LEFT, CONTENT_W, 'Courier', 'center');
                break;
        }
        prevType = el.type;
    });

    // Final FADE OUT — exporter furniture, elIndex -1 so it can never be starred,
    // but it occupies lines and can start a page, so the layout must include it.
    y += LINE_H;
    checkPageBreak(LINE_H);
    writeLine(-1, 'FADE OUT.', LEFT, CONTENT_W, 'Courier', 'right');

    return { ops, pageCount: page, pageOfElement, pageStarts };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LAYOUT, parseFountain, wrapText, layoutScreenplay };
}
if (typeof window !== 'undefined') {
    window.ScreenplayLayout = { LAYOUT, parseFountain, wrapText, layoutScreenplay };
}
