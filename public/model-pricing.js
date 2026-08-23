/**
 * model-pricing.js — the ONE pricing function, shared by browser and server.
 *
 * Browser: <script src="model-pricing.js"> → window.ModelPricing (the project spend
 * modal, the account rollup, the admin usage view). Server: require('./public/
 * model-pricing') → the per-user quota guard (multi-user Phase 4). Same pattern as
 * screenplay-layout.js and script-diff.js, and for the same reason: two price
 * tables that can disagree are worse than one, because a writer who is told
 * "$4.10 spent" by the modal and then 429'd for "budget reached" by the server would
 * have no way to tell which figure to believe.
 *
 * ⚠️ SINCE PHASE 5 THE TABLE ITSELF LIVES IN THE MODEL REGISTRY, not here. The rates
 * were hardcoded above until 2026-08-22; now `utils/model_registry.js` holds one row
 * per model with the published per-million price, its source URL and the date it was
 * checked, and both sides load the same rows through `setPricingTable`:
 *
 *   server  — server.js calls setPricingTable(modelRegistry.pricingTable()) at boot
 *             and again on every registry write (registry.onChange).
 *   browser — app.js fetches GET /api/models during boot and calls setPricingTable
 *             with the rows it returns.
 *
 * There is still exactly ONE table; it just stopped being source code. Never add a
 * rate anywhere else — add a registry row.
 *
 * ⚠️ THE TABLE OBJECT IS MUTATED IN PLACE, NEVER REPLACED. `app.js` captures
 * `window.ModelPricing.MODEL_PRICING` in a const at load, exactly as `appSettings`
 * is captured by the route modules in server.js — rebinding it would leave that
 * alias pointing at an empty object forever, and the symptom would be every spend
 * figure reading $0.00 (2026-07-30's bug, in a new place).
 *
 * Rates are USD per token. Unknown models price at zero and are reported as such by
 * `priceUsage`, so an unpriced model shows up as "$0.00 (unpriced)" rather than
 * silently as a discount — a zero that looks like a real figure is how
 * gemini-3.6-flash under-counted every spend number for weeks (2026-08-16).
 */

(function () {
'use strict';

// Wrapped in an IIFE on purpose: as a classic <script> a top-level `const` would be
// a page-global lexical binding, and app.js declares its own `MODEL_PRICING` alias
// — the clash is a SyntaxError that kills app.js at load (found 2026-08-16).
const MODEL_PRICING = {};

/**
 * Load the table. `table` is `{ id: { input, output, label } }` with PER-TOKEN
 * rates — the shape `modelRegistry.pricingTable()` returns and `GET /api/models`
 * serves. Mutates in place (see the header) and returns the number of rows.
 *
 * An empty table is refused: it would turn every spend figure into $0.00 and every
 * monthly quota into "unlimited" with nothing to see. Better to keep serving the
 * rows we already have and log than to price the deployment at nothing.
 */
function setPricingTable(table) {
    const rows = table && typeof table === 'object' ? table : {};
    const ids = Object.keys(rows);
    if (!ids.length) {
        const message = '[model-pricing] refusing an empty price table — keeping the current rows. '
            + 'Every call would otherwise price at $0.00 and every monthly quota would become infinite.';
        if (typeof console !== 'undefined') console.error(message);
        return Object.keys(MODEL_PRICING).length;
    }
    for (const key of Object.keys(MODEL_PRICING)) delete MODEL_PRICING[key];
    for (const id of ids) {
        const row = rows[id] || {};
        MODEL_PRICING[id] = {
            input: Number(row.input) || 0,
            output: Number(row.output) || 0,
            label: row.label || id
        };
    }
    return ids.length;
}

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
    module.exports = { MODEL_PRICING, costOf, priceUsage, setPricingTable };
}
if (typeof window !== 'undefined') {
    window.ModelPricing = { MODEL_PRICING, costOf, priceUsage, setPricingTable };
}
})();
