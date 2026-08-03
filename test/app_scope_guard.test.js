const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const APP_JS = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

// public/app.js has ONE giant `document.addEventListener('DOMContentLoaded', ...)`
// handler, and a tail of code after it that runs at module scope. Anything declared
// inside the handler is invisible to that tail — and calling it from there throws a
// ReferenceError at click time, not at load time, so nothing catches it.
//
// This has now killed the Settings gear icon TWICE:
//   • June 2026 — the closure-scope incident that prompted CLAUDE.md's "helpers
//     called from anywhere must not be trapped inside DOMContentLoaded" rule.
//   • 2026-07-12 → 2026-08-03 — `displayStageNumber` moved into the handler by
//     `06d2fd0`, while openSettingsModal (module scope) kept calling it. Settings
//     was dead for three weeks. Silent, because the click handler is an `async`
//     function: the throw became an unhandled promise rejection, which prints
//     nothing an ordinary error listener would see.
//
// `node --check` cannot catch this, and neither can a grep for a known name — the
// next one will have a different name. So check the STRUCTURE.

function handlerBounds(source) {
    const start = source.indexOf("document.addEventListener('DOMContentLoaded'");
    assert.ok(start > 0, "could not find the DOMContentLoaded handler");
    // The handler is closed by the first `});` sitting at column 0 after it.
    const end = source.indexOf('\n});', start);
    assert.ok(end > start, "could not find the end of the DOMContentLoaded handler");
    return { start, end: end + '\n});'.length };
}

/** Names declared as direct children of the handler (4-space indent). */
function handlerScopedNames(body) {
    const names = new Set();
    const patterns = [
        /^ {4}(?:const|let|var) ([A-Za-z_$][\w$]*)\s*=/gm,
        /^ {4}(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/gm
    ];
    for (const re of patterns) {
        for (const m of body.matchAll(re)) names.add(m[1]);
    }
    return names;
}

/**
 * Keep only executable code: drop comments and literal string text, but KEEP the
 * inside of `${...}` interpolations.
 *
 * ⚠️ Written as a character scanner rather than regexes on purpose. The first version
 * blanked template literals whole — and the actual bug this test exists for lives at
 * `` `Stage ${displayStageNumber(num)}` ``, inside one. The test passed against the
 * broken code, which is worse than not having it.
 */
function stripNonCode(source) {
    let out = '';
    let i = 0;
    // Stack of template-literal contexts we are inside, so nesting behaves.
    const templates = [];
    while (i < source.length) {
        const ch = source[i];
        const next = source[i + 1];

        if (ch === '/' && next === '*') { i = source.indexOf('*/', i + 2); i = i < 0 ? source.length : i + 2; out += ' '; continue; }
        if (ch === '/' && next === '/') { const nl = source.indexOf('\n', i); i = nl < 0 ? source.length : nl; out += ' '; continue; }

        if (ch === "'" || ch === '"') {
            const quote = ch;
            i += 1;
            while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
            i += 1; out += ' '; continue;
        }

        if (ch === '`') { templates.push(true); i += 1; out += ' '; continue; }

        if (templates.length) {
            if (ch === '\\') { i += 2; continue; }
            if (ch === '`') { templates.pop(); i += 1; out += ' '; continue; }
            if (ch === '$' && next === '{') {
                // Copy the interpolation body verbatim — it is real code.
                let depth = 1; i += 2; const from = i;
                while (i < source.length && depth > 0) {
                    if (source[i] === '{') depth += 1;
                    else if (source[i] === '}') depth -= 1;
                    if (depth > 0) i += 1;
                }
                out += ` ${source.slice(from, i)} `; i += 1; continue;
            }
            i += 1; continue; // literal text inside a template — drop it
        }

        out += ch; i += 1;
    }
    return out;
}

test('no code after the DOMContentLoaded handler references anything declared inside it', () => {
    const { start, end } = handlerBounds(APP_JS);
    const declared = handlerScopedNames(APP_JS.slice(start, end));
    assert.ok(declared.size > 50, `expected many handler-scoped declarations, found ${declared.size}`);

    const tail = stripNonCode(APP_JS.slice(end));
    const leaked = [...declared].filter(name => {
        // Identifier position only: not a property access, not a key, not a re-declaration.
        const used = new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\s*(?![\\w$:])`);
        return used.test(tail);
    });

    assert.deepEqual(
        leaked,
        [],
        `Code after the DOMContentLoaded handler references ${leaked.join(', ')}, which is/are declared INSIDE it. `
        + `That throws a ReferenceError when the code actually runs — at click time, silently, if the caller is async. `
        + `Move the declaration(s) above the handler (see the displayStageNumber block at the top of public/app.js).`
    );
});

test('the visible-stage helpers are declared above the handler, where every caller can see them', () => {
    const { start } = handlerBounds(APP_JS);
    const head = APP_JS.slice(0, start);
    for (const name of ['DISPLAY_STAGE_NUMBERS', 'DISPLAY_STAGE_LABELS', 'displayStageNumber', 'displayStageLabel', 'displayStageName']) {
        assert.match(head, new RegExp(`(?:const|function)\\s+${name}\\b`), `${name} must be declared before the DOMContentLoaded handler`);
    }
});

// ─── The Settings model dropdown ────────────────────────────────────────────────
// Separate bug found in the same modal on 2026-08-03: `gemini-3.6-flash` — the model
// nine of the ten stages were actually running — had been dropped from MODEL_OPTIONS
// by `d965963`. No <option> matched, so every select displayed its FIRST option
// instead ("Gemini 3.1 Pro"), and Save writes back what is displayed. Opening Settings
// and saving would have silently moved the whole pipeline onto pro.

test('every model the app can be configured with is offered in Settings', () => {
    const options = [...APP_JS.matchAll(/\{ value: '([^']+)',\s*label: '/g)].map(m => m[1]);
    assert.ok(options.length >= 6, `expected the MODEL_OPTIONS list, found ${options.length} entries`);
    // The defaults the server actually falls back to must be selectable.
    for (const model of ['gemini-3.6-flash', 'gemini-3.1-pro-preview']) {
        assert.ok(options.includes(model), `${model} is used by the app but missing from the Settings dropdown`);
    }
});

test('a saved model outside the list is shown rather than silently replaced', () => {
    // The durable half of the fix: the list will drift again the next time a model id
    // changes, and when it does the modal must still report the truth.
    assert.match(
        APP_JS,
        /MODEL_OPTIONS\.some\(opt => opt\.value === currentModel\)/,
        'buildModelSelect must fall back to an option for the saved value when it is not in MODEL_OPTIONS'
    );
});
