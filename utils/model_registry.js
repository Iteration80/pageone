/**
 * utils/model_registry.js — the model table, as data (Phase 5 item 1).
 *
 * WHY. Adding a model used to mean editing three places in source and redeploying:
 * `MODEL_OPTIONS` in public/app.js (what the dropdowns offer), `MODEL_PRICING` in
 * public/model-pricing.js (what a call costs), and a prefix rule in
 * agents/ai-client.js (which SDK to use). Carsten's brief of 2026-08-21: someone may
 * want Kimi K3 next month, models change constantly, and adding one must be an
 * in-app action rather than a Claude Code session. So the table becomes a file an
 * admin edits, and code holds only the *kinds* of provider it knows how to talk to.
 *
 * ONE ROW PER MODEL:
 *   { id, label, provider: 'gemini'|'anthropic'|'openai-compatible', baseUrl,
 *     pricing: { inputPerMTok, outputPerMTok, source, checkedAt, note },
 *     enabled, deprecated, verified: { "<stage>": {ok, at, by, error} } }
 *
 * ⚠️ PRICES ARE PER MILLION TOKENS, AS PUBLISHED. The 2026-08-16 incident — two
 * Gemini rows stale for months and `gemini-3.6-flash` pricing at $0.00 — happened
 * because nobody could compare a per-token float against Google's page by eye.
 * Storing the published number makes that comparison trivial, and `source` +
 * `checkedAt` make it auditable. Conversion to per-token happens in exactly one
 * place, `pricingTable()`, which feeds public/model-pricing.js. **The one price
 * table survives — it just stopped being source code.**
 *
 * ⚠️ AN EMPTY REGISTRY IS NOT A SAFE DEFAULT, unlike the access-control store. No
 * rows means every call prices at $0.00 and every quota silently becomes infinite.
 * So a missing or unreadable deployment copy falls back to the BUNDLED file that
 * ships in the repo, and only a genuinely unreadable bundle yields an empty table
 * (logged loudly). Never "fix" this to `emptyStore()` for symmetry.
 *
 * ⚠️ `verified` IS WRITTEN ONLY BY THE VERIFY ACTION. It is a record that a real
 * request against a real stage schema succeeded. A value set from the edit form
 * would be a claim nobody tested — `updateModel` strips it for that reason.
 *
 * Mechanics match utils/access_control.js: synchronous mtime-cached reads (provider
 * detection and pricing are called from sync code paths), serialised atomic writes,
 * and an updater returning `false` writes nothing. DATA_ROOT is resolved per call so
 * the route harness can point one process at a throwaway store per test.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_FILENAME = 'models.json';
const BUNDLED_PATH = path.resolve(__dirname, '..', 'data', STORE_FILENAME);

const PROVIDERS = ['gemini', 'anthropic', 'openai-compatible'];

/** How long a hand-entered price may go unchecked before the UI flags it. */
const PRICE_STALE_DAYS = 90;

function storePath() {
    const dataRoot = path.resolve(process.env.DATA_ROOT || path.resolve(__dirname, '..', 'data'));
    return path.join(dataRoot, STORE_FILENAME);
}

function emptyStore() {
    return { version: 1, models: [], recommended: {} };
}

function cleanId(id) {
    return String(id || '').trim();
}

function cleanNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? num : null;
}

function normalisePricing(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    return {
        inputPerMTok: cleanNumber(p.inputPerMTok),
        outputPerMTok: cleanNumber(p.outputPerMTok),
        source: p.source ? String(p.source).trim() : null,
        checkedAt: p.checkedAt ? String(p.checkedAt).trim() : null,
        note: p.note ? String(p.note).trim() : null
    };
}

function normaliseVerified(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [stage, result] of Object.entries(raw)) {
        const num = Number(stage);
        if (!Number.isInteger(num) || num <= 0) continue;
        if (!result || typeof result !== 'object') continue;
        out[String(num)] = {
            ok: Boolean(result.ok),
            at: result.at ? String(result.at) : null,
            by: result.by ? String(result.by).trim().toLowerCase() : null,
            error: result.error ? String(result.error) : null
        };
    }
    return out;
}

function normaliseModel(raw) {
    const id = cleanId(raw?.id);
    if (!id) return null;
    const provider = PROVIDERS.includes(raw?.provider) ? raw.provider : null;
    return {
        id,
        label: raw?.label ? String(raw.label).trim() : id,
        // An unrecognised provider string is NOT silently coerced to gemini — that
        // is how a Kimi row would quietly get sent to Google. It falls through to
        // the prefix rule in providerFor(), which is at least an honest guess, and
        // the admin UI shows the row as needing a provider.
        provider,
        baseUrl: raw?.baseUrl ? String(raw.baseUrl).trim().replace(/\/+$/, '') : null,
        pricing: normalisePricing(raw?.pricing),
        enabled: raw?.enabled !== false,
        deprecated: Boolean(raw?.deprecated),
        verified: normaliseVerified(raw?.verified)
    };
}

function normaliseRecommended(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [stage, id] of Object.entries(raw)) {
        const num = Number(stage);
        const model = cleanId(id);
        if (!Number.isInteger(num) || num <= 0 || !model) continue;
        out[String(num)] = model;
    }
    return out;
}

function normaliseStore(parsed) {
    const store = emptyStore();
    if (!parsed || typeof parsed !== 'object') return store;
    const seen = new Set();
    if (Array.isArray(parsed.models)) {
        for (const raw of parsed.models) {
            const model = normaliseModel(raw);
            if (!model || seen.has(model.id)) continue; // first row wins; ids are the key
            seen.add(model.id);
            store.models.push(model);
        }
    }
    store.recommended = normaliseRecommended(parsed.recommended);
    return store;
}

let cache = { key: null, store: null };
let warnedEmpty = false;

function readBundled() {
    try {
        return normaliseStore(JSON.parse(fs.readFileSync(BUNDLED_PATH, 'utf-8')));
    } catch (err) {
        if (!warnedEmpty) {
            warnedEmpty = true;
            console.error(`[models] the bundled registry at ${BUNDLED_PATH} is unreadable (${err.message}) — `
                + 'no models and no prices. Every call will price at $0.00 and every quota is effectively infinite.');
        }
        return emptyStore();
    }
}

/**
 * The registry, read synchronously and memoised on the file's identity. Falls back
 * to the bundled file — see the header: an empty table is dangerous here, not safe.
 */
function readStoreSync() {
    const target = storePath();
    let stat;
    try {
        stat = fs.statSync(target);
    } catch {
        cache = { key: null, store: null };
        return readBundled();
    }
    const key = `${target}|${stat.mtimeMs}|${stat.size}`;
    if (cache.key === key && cache.store) return cache.store;
    let store;
    try {
        store = normaliseStore(JSON.parse(fs.readFileSync(target, 'utf-8')));
    } catch (err) {
        console.error(`[models] ${target} is unreadable (${err.message}) — falling back to the bundled registry.`);
        return readBundled();
    }
    if (!store.models.length) {
        console.warn(`[models] ${target} has no models — falling back to the bundled registry.`);
        return readBundled();
    }
    cache = { key, store };
    return store;
}

let writeChain = Promise.resolve();
const listeners = new Set();

/** Called after every successful write, so the price table can be rebuilt. */
function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function notify() {
    for (const fn of listeners) {
        try { fn(); } catch (err) { console.error('[models] change listener failed:', err.message); }
    }
}

async function writeStore(store, target) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmpPath = path.join(path.dirname(target), `.tmp-${crypto.randomBytes(6).toString('hex')}`);
    await fs.promises.writeFile(tmpPath, JSON.stringify(store, null, 2));
    await fs.promises.rename(tmpPath, target);
    cache = { key: null, store: null };
    notify();
}

/**
 * Serialised read-modify-write against the DEPLOYMENT copy. ⚠️ The read half seeds
 * from the bundle when the deployment copy is missing, so the first edit on a fresh
 * volume writes a complete registry rather than a file containing only that edit.
 */
async function updateStore(updater) {
    const run = writeChain.catch(() => {}).then(async () => {
        const target = storePath();
        let store;
        try {
            store = normaliseStore(JSON.parse(await fs.promises.readFile(target, 'utf-8')));
            if (!store.models.length) store = readBundled();
        } catch {
            store = readBundled();
        }
        const result = await updater(store);
        if (result !== false) await writeStore(store, target);
        return result;
    });
    writeChain = run.catch(() => {});
    return run;
}

/**
 * Copy the bundled registry into DATA_ROOT if the deployment has none yet — same
 * arrangement as seedBundledStyles(). A no-op when DATA_ROOT is the repo's own data
 * directory (local dev), where the bundle IS the deployment copy.
 */
async function ensureSeeded() {
    const target = storePath();
    if (path.resolve(target) === path.resolve(BUNDLED_PATH)) return false;
    try {
        await fs.promises.access(target);
        return false;
    } catch {}
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(BUNDLED_PATH, target);
    cache = { key: null, store: null };
    notify();
    console.log(`[models] seeded the model registry into ${target}`);
    return true;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Every row, in file order. `{ enabled: true }` narrows to what may be selected. */
function listModels({ enabled = null } = {}) {
    const rows = readStoreSync().models;
    const filtered = enabled === null ? rows : rows.filter(m => m.enabled === enabled);
    return filtered.map(m => ({ ...m, pricing: { ...m.pricing }, verified: { ...m.verified } }));
}

function getModel(id) {
    const clean = cleanId(id);
    const found = readStoreSync().models.find(m => m.id === clean);
    return found ? { ...found, pricing: { ...found.pricing }, verified: { ...found.verified } } : null;
}

/**
 * Which SDK branch talks to this model.
 *
 * ⚠️ THE REGISTRY IS THE ONLY PROVIDER MAP for a registered id. The `claude-` prefix
 * rule survives only as the guess for an id nobody has registered — without it a
 * model configured before this registry existed would silently route to Gemini.
 */
function providerFor(id) {
    const row = getModel(id);
    if (row?.provider) return row.provider;
    return typeof id === 'string' && id.startsWith('claude-') ? 'anthropic' : 'gemini';
}

/** The base URL an openai-compatible row talks to, or null. */
function baseUrlFor(id) {
    return getModel(id)?.baseUrl || null;
}

/**
 * The price table in the shape public/model-pricing.js wants: per-TOKEN rates keyed
 * by model id. This is the only place the published per-million figure is divided.
 * Rows with no price are omitted, so `priceUsage` reports them as unpriced rather
 * than as a silent zero.
 */
function pricingTable() {
    const table = {};
    for (const model of readStoreSync().models) {
        const { inputPerMTok, outputPerMTok } = model.pricing;
        if (inputPerMTok === null || outputPerMTok === null) continue;
        table[model.id] = {
            input: inputPerMTok / 1e6,
            output: outputPerMTok / 1e6,
            label: model.label
        };
    }
    return table;
}

/** `{ "<stage>": "<model id>" }` — the Auto (recommended) map. */
function getRecommended() {
    return { ...readStoreSync().recommended };
}

function recommendedFor(stageNum) {
    return readStoreSync().recommended[String(stageNum)] || null;
}

/** Rows whose price has not been checked in `days` — the admin UI's ⚠. */
function stalePricing({ days = PRICE_STALE_DAYS, now = Date.now() } = {}) {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    return readStoreSync().models
        .filter(m => m.enabled && m.pricing.inputPerMTok !== null)
        .filter(m => {
            const checked = m.pricing.checkedAt ? Date.parse(m.pricing.checkedAt) : NaN;
            return Number.isNaN(checked) || checked < cutoff;
        })
        .map(m => m.id);
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * ⚠️ RESERVED. `auto` is the sentinel a stage choice carries to mean "pick for me"
 * (server.js `resolveAutoModel`). A registry row with that id would be selected by
 * name and then resolved as the sentinel — two different meanings for one string.
 */
const RESERVED_MODEL_IDS = ['auto'];

function assertValidNewModel(row) {
    const id = cleanId(row?.id);
    if (!id) throw new Error('A model id is required.');
    if (RESERVED_MODEL_IDS.includes(id.toLowerCase())) {
        throw new Error(`"${id}" is reserved — it is the id the Auto (recommended) option uses.`);
    }
    if (!PROVIDERS.includes(row?.provider)) {
        throw new Error(`Provider must be one of: ${PROVIDERS.join(', ')}.`);
    }
    if (row.provider === 'openai-compatible') {
        const baseUrl = String(row.baseUrl || '').trim();
        if (!/^https?:\/\//i.test(baseUrl)) {
            throw new Error('An OpenAI-compatible model needs a baseUrl (for example https://api.moonshot.ai/v1).');
        }
    }
    return id;
}

async function addModel(row, { by = null } = {}) {
    const id = assertValidNewModel(row);
    return updateStore(store => {
        if (store.models.some(m => m.id === id)) throw new Error(`${id} is already in the registry.`);
        const model = normaliseModel(row);
        model.verified = {}; // only the Verify action may write this
        model.addedBy = by ? String(by).trim().toLowerCase() : null;
        store.models.push(model);
        return true;
    });
}

/**
 * Patch one row. Only the fields present in `patch` change. `id` and `verified` are
 * NOT patchable: renaming a row would orphan every historical usage record keyed by
 * the old id, and a hand-set verified flag is an untested claim.
 */
async function updateModel(id, patch = {}) {
    const clean = cleanId(id);
    return updateStore(store => {
        const index = store.models.findIndex(m => m.id === clean);
        if (index < 0) throw new Error(`${clean} is not in the registry.`);
        const current = store.models[index];
        const next = normaliseModel({
            ...current,
            ...patch,
            id: current.id,
            verified: current.verified,
            pricing: 'pricing' in patch ? { ...current.pricing, ...patch.pricing } : current.pricing
        });
        if (next.provider === 'openai-compatible' && !next.baseUrl) {
            throw new Error('An OpenAI-compatible model needs a baseUrl.');
        }
        if (!next.provider) throw new Error(`Provider must be one of: ${PROVIDERS.join(', ')}.`);
        if (JSON.stringify(next) === JSON.stringify(current)) return false;
        store.models[index] = next;
        return true;
    });
}

/**
 * Remove a row outright.
 *
 * ⚠️ Prefer disabling. A removed row takes its PRICE with it, so every past call on
 * that model silently re-prices to $0.00 and the admin spend view quietly shrinks.
 * The route refuses removal for any model that carries a price and is not
 * `deprecated`; this function is the mechanism, not the policy.
 */
async function removeModel(id) {
    const clean = cleanId(id);
    return updateStore(store => {
        const before = store.models.length;
        store.models = store.models.filter(m => m.id !== clean);
        if (store.models.length === before) return false;
        for (const [stage, model] of Object.entries(store.recommended)) {
            if (model === clean) delete store.recommended[stage];
        }
        return true;
    });
}

/** Replace the Auto (recommended) map. Every value must name a registered model. */
async function setRecommended(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
        throw new Error('recommended must be an object of stage → model id.');
    }
    const next = normaliseRecommended(map);
    return updateStore(store => {
        for (const id of Object.values(next)) {
            if (!store.models.some(m => m.id === id)) throw new Error(`${id} is not in the registry.`);
        }
        if (JSON.stringify(next) === JSON.stringify(store.recommended)) return false;
        store.recommended = next;
        return true;
    });
}

/**
 * Record the outcome of ONE real request against ONE stage schema. The only writer
 * of `verified` — see the header.
 */
async function setVerified(id, stageNum, { ok, by = null, error = null, at = null } = {}) {
    const clean = cleanId(id);
    const stage = Number(stageNum);
    if (!Number.isInteger(stage) || stage <= 0) throw new Error('A stage number is required.');
    return updateStore(store => {
        const model = store.models.find(m => m.id === clean);
        if (!model) throw new Error(`${clean} is not in the registry.`);
        model.verified[String(stage)] = {
            ok: Boolean(ok),
            at: at || new Date().toISOString(),
            by: by ? String(by).trim().toLowerCase() : null,
            error: ok ? null : (error ? String(error).slice(0, 500) : 'failed')
        };
        return true;
    });
}

module.exports = {
    PROVIDERS,
    RESERVED_MODEL_IDS,
    PRICE_STALE_DAYS,
    ensureSeeded,
    listModels,
    getModel,
    providerFor,
    baseUrlFor,
    pricingTable,
    getRecommended,
    recommendedFor,
    stalePricing,
    addModel,
    updateModel,
    removeModel,
    setRecommended,
    setVerified,
    onChange,
    _storePath: storePath,
    _bundledPath: BUNDLED_PATH,
    _readStoreSync: readStoreSync
};
