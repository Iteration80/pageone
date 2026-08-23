/**
 * utils/user_settings.js — per-person preferences that override the server-global
 * settings (multi-user Phase 5, item 0).
 *
 * WHY THIS EXISTS. Until now `data/settings.json` was the whole story: ONE
 * `stageModels` map for the deployment, written by `POST /api/settings` behind
 * plain `requireAuth`. That was correct while PageOne had one user and quietly
 * wrong the moment it had two — any signed-in tester opening Settings and pressing
 * Save rewrote which model every OTHER writer's stages run on, and the only
 * evidence would have been someone else's Pitch suddenly costing five times more.
 * A preference is not a deployment setting.
 *
 * So the global map becomes admin-only (routes/projects.js) and this file is the
 * layer on top of it:
 *
 *     effective model for stage N = user override ?? global default ?? GEMINI_MODEL
 *
 * ⚠️ THE OVERRIDE MAP IS SPARSE ON PURPOSE. A stage the user has not chosen is
 * ABSENT, not stored as a copy of today's global. Storing the resolved value would
 * pin every user to whatever the default happened to be the first time they opened
 * Settings — the same "Save rewrote all ten stages" failure as 2026-08-03, arriving
 * one layer up. Absent means inherit, and inherit means an admin changing the
 * default is felt by everyone who never expressed an opinion.
 *
 * Shape, `<DATA_ROOT>/user-settings.json`:
 *   { version: 1, users: { "someone@example.com": { stageModels: { "stage3": "…" } } } }
 *
 * Mechanics are deliberately identical to utils/access_control.js: synchronous
 * mtime-cached reads (getModelConfig is sync and sits under ~30 call sites; making
 * it async would ripple through every agent), serialised atomic writes, and an
 * updater that returns `false` for "no change" so a no-op never rewrites the file
 * (the lost-update lesson from utils/tokens.js). DATA_ROOT is resolved per call so
 * the route harness can point one process at a throwaway store per test.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_FILENAME = 'user-settings.json';

function storePath() {
    const dataRoot = path.resolve(process.env.DATA_ROOT || path.resolve(__dirname, '..', 'data'));
    return path.join(dataRoot, STORE_FILENAME);
}

function normEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function emptyStore() {
    return { version: 1, users: {} };
}

/** `stage7` → 7. Anything else → null, so junk keys never reach a model name. */
function stageKeyNumber(key) {
    const match = /^stage(\d+)$/.exec(String(key || '').trim());
    if (!match) return null;
    const num = Number(match[1]);
    return Number.isInteger(num) && num > 0 ? num : null;
}

function normaliseStageModels(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw)) {
        const num = stageKeyNumber(key);
        if (num === null) continue;
        const model = String(value || '').trim();
        // An empty value is how the client says "inherit the default". It must drop
        // the key rather than store '' — a stored empty string would resolve to the
        // global anyway, but it would also survive as a phantom "choice" in the UI.
        if (!model) continue;
        out[`stage${num}`] = model;
    }
    return out;
}

function normaliseStore(parsed) {
    const store = emptyStore();
    if (!parsed || typeof parsed !== 'object') return store;
    const users = parsed.users && typeof parsed.users === 'object' ? parsed.users : {};
    for (const [email, prefs] of Object.entries(users)) {
        const clean = normEmail(email);
        if (!clean) continue;
        const stageModels = normaliseStageModels(prefs?.stageModels);
        if (!Object.keys(stageModels).length) continue; // empty prefs are not a user
        store.users[clean] = { stageModels };
    }
    return store;
}

let cache = { key: null, store: null };

/**
 * The store, read synchronously and memoised on the file's identity. A missing or
 * unreadable file is an empty store — nobody overrides anything, which is exactly
 * the pre-Phase-5 behaviour and the safe direction here (everyone falls back to the
 * admin-set global rather than to nothing).
 */
function readStoreSync() {
    const target = storePath();
    let stat;
    try {
        stat = fs.statSync(target);
    } catch {
        cache = { key: null, store: null };
        return emptyStore();
    }
    const key = `${target}|${stat.mtimeMs}|${stat.size}`;
    if (cache.key === key && cache.store) return cache.store;
    let store;
    try {
        store = normaliseStore(JSON.parse(fs.readFileSync(target, 'utf-8')));
    } catch {
        store = emptyStore();
    }
    cache = { key, store };
    return store;
}

let writeChain = Promise.resolve();

async function writeStore(store, target) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmpPath = path.join(path.dirname(target), `.tmp-${crypto.randomBytes(6).toString('hex')}`);
    await fs.promises.writeFile(tmpPath, JSON.stringify(store, null, 2));
    await fs.promises.rename(tmpPath, target);
    cache = { key: null, store: null }; // never serve a stale copy after our own write
}

/** Serialised read-modify-write. An updater returning `false` writes nothing. */
async function updateStore(updater) {
    const run = writeChain.catch(() => {}).then(async () => {
        const target = storePath();
        let store;
        try {
            store = normaliseStore(JSON.parse(await fs.promises.readFile(target, 'utf-8')));
        } catch {
            store = emptyStore();
        }
        const result = await updater(store);
        if (result !== false) await writeStore(store, target);
        return result;
    });
    writeChain = run.catch(() => {});
    return run;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * This person's explicit per-stage choices — SPARSE. A stage they have never chosen
 * is absent, and absent means "inherit the global default".
 */
function getUserStageModels(email) {
    const clean = normEmail(email);
    if (!clean) return {};
    return { ...(readStoreSync().users[clean]?.stageModels || {}) };
}

/** This person's explicit choice for one stage, or null when they inherit. */
function getUserStageModel(email, stageNum) {
    const clean = normEmail(email);
    if (!clean) return null;
    const num = Number(stageNum);
    if (!Number.isInteger(num)) return null;
    return readStoreSync().users[clean]?.stageModels?.[`stage${num}`] || null;
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Replace this person's per-stage overrides with `stageModels`. Keys with an empty
 * value are dropped (= "use the default"); an empty map clears the person's entry
 * entirely. Returns true when something actually changed.
 */
async function setUserStageModels(email, stageModels) {
    const clean = normEmail(email);
    if (!clean.includes('@')) throw new Error('A valid email address is required.');
    if (stageModels !== null && stageModels !== undefined
        && (typeof stageModels !== 'object' || Array.isArray(stageModels))) {
        throw new Error('stageModels must be an object of stageN → model id.');
    }
    const next = normaliseStageModels(stageModels);
    return updateStore(store => {
        const current = store.users[clean]?.stageModels || {};
        if (JSON.stringify(current) === JSON.stringify(next)) return false;
        if (!Object.keys(next).length) delete store.users[clean];
        else store.users[clean] = { stageModels: next };
        return true;
    });
}

/** Drop everything stored for one person. Used when their access is removed. */
async function forgetUser(email) {
    const clean = normEmail(email);
    return updateStore(store => {
        if (!store.users[clean]) return false;
        delete store.users[clean];
        return true;
    });
}

module.exports = {
    getUserStageModels,
    getUserStageModel,
    setUserStageModels,
    forgetUser,
    _storePath: storePath,
    _readStoreSync: readStoreSync
};
