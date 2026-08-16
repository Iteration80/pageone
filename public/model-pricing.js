/**
 * model-pricing.js — the ONE per-token price table, shared by browser and server.
 *
 * Browser: <script src="model-pricing.js"> → window.ModelPricing (the project spend
 * modal, the account rollup, the admin usage view). Server: require('./public/
 * model-pricing') → the per-user quota guard (multi-user Phase 4). Same pattern as
 * screenplay-layout.js and script-diff.js, and for the same reason: two price
 * tables that can disagree are worse than one, because a writer who is told
 * "$4.10 spent" by the modal and then 429'd for "budget reached" by the server would
 * have no way to tell which figure to believe. Moving the table here rather than
 * duplicating it is what keeps that from ever happening — there is no second table
 * to drift.
 *
 * Rates are USD per token (published per-1M rates / 1e6). `label` is the display
 * name. Unknown models price at zero and are reported as such by `priceUsage`, so
 * an unpriced model shows up as "$0.00 (unpriced)" rather than silently as a
 * discount — a zero that looks like a real figure is how gemini-3.6-flash under-
 * counted every spend number for weeks (2026-08-16).
 *
 * Sources when last checked (2026-08-16): ai.google.dev/gemini-api/docs/pricing;
 * platform.claude.com/docs/en/about-claude/models/overview. Gemini 3.6 Flash is
 * priced $0.75/$3.75 through 2026-12-31 and $1.50/$7.50 from 2027-01-01 — bump it
 * then. Gemini 3.1 Pro's rate above 200k-token prompts ($4/$18) is not modelled;
 * PageOne prompts stay under that.
 */

(function () {
'use strict';

// Wrapped in an IIFE on purpose: as a classic <script> a top-level `const` would be
// a page-global lexical binding, and app.js declares its own `MODEL_PRICING` alias
// — the clash is a SyntaxError that kills app.js at load (found 2026-08-16).
const MODEL_PRICING = {
    // Gemini
    'gemini-3.6-flash':            { input: 0.75 / 1e6, output: 3.75 / 1e6, label: 'Gemini 3.6 Flash' },
    'gemini-3.1-pro-preview':      { input: 2.00 / 1e6, output: 12.0 / 1e6, label: 'Gemini 3.1 Pro' },
    'gemini-3-flash-preview':      { input: 0.50 / 1e6, output: 3.00 / 1e6, label: 'Gemini 3 Flash' },
    'gemini-2.5-pro-preview-05-06':{ input: 1.25 / 1e6, output: 10.0 / 1e6, label: 'Gemini 2.5 Pro' },
    'gemini-2.0-flash':            { input: 0.10 / 1e6, output: 0.40 / 1e6, label: 'Gemini 2.0 Flash' },
    'gemini-2.0-flash-001':        { input: 0.10 / 1e6, output: 0.40 / 1e6, label: 'Gemini 2.0 Flash' },
    // Anthropic
    'claude-fable-5':              { input: 10.0 / 1e6, output: 50.0 / 1e6, label: 'Claude Fable 5' },
    'claude-opus-5':               { input: 5.0 / 1e6,  output: 25.0 / 1e6, label: 'Claude Opus 5' },
    'claude-sonnet-5':             { input: 3.0 / 1e6,  output: 15.0 / 1e6, label: 'Claude Sonnet 5' },
    'claude-haiku-4-5-20251001':   { input: 1.0 / 1e6,  output: 5.0 / 1e6,  label: 'Claude Haiku 4.5' },
    // Retained for historical spend on projects that used superseded models:
    'claude-opus-4-8':             { input: 5.0 / 1e6,  output: 25.0 / 1e6, label: 'Claude Opus 4.8' },
    'claude-opus-4-7':             { input: 5.0 / 1e6,  output: 25.0 / 1e6, label: 'Claude Opus 4.7' },
    'claude-opus-4-6':             { input: 5.0 / 1e6,  output: 25.0 / 1e6, label: 'Claude Opus 4.6' },
    'claude-sonnet-4-6':           { input: 3.0 / 1e6,  output: 15.0 / 1e6, label: 'Claude Sonnet 4.6' },
};

/** Price one call. Unknown model → 0. */
function costOf(model, inputTokens, outputTokens) {
    const p = MODEL_PRICING[model];
    if (!p) return 0;
    return (Number(inputTokens) || 0) * p.input + (Number(outputTokens) || 0) * p.output;
}

/**
 * Price a `byModel` map ({ model: { inputTokens, outputTokens, calls } }) — the
 * shape usageRollup returns. Returns { totalUsd, rows, unpriced } where `rows`
 * is per model (sorted by cost, desc) and `unpriced` lists models with no rate
 * so a caller can say so instead of showing a silent zero.
 */
function priceUsage(byModel) {
    const rows = [];
    const unpriced = [];
    let totalUsd = 0;
    for (const [model, u] of Object.entries(byModel || {})) {
        const priced = Boolean(MODEL_PRICING[model]);
        const cost = costOf(model, u?.inputTokens, u?.outputTokens);
        if (!priced) unpriced.push(model);
        totalUsd += cost;
        rows.push({
            model,
            label: MODEL_PRICING[model]?.label || model,
            priced,
            calls: Number(u?.calls) || 0,
            inputTokens: Number(u?.inputTokens) || 0,
            outputTokens: Number(u?.outputTokens) || 0,
            cost
        });
    }
    rows.sort((a, b) => b.cost - a.cost);
    return { totalUsd, rows, unpriced };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MODEL_PRICING, costOf, priceUsage };
}
if (typeof window !== 'undefined') {
    window.ModelPricing = { MODEL_PRICING, costOf, priceUsage };
}
})();
