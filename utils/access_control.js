/**
 * utils/access_control.js — data-backed allowlist, admin list and per-user quotas
 * (multi-user Phase 4).
 *
 * Until Phase 4 the allowlist was `ALLOWED_EMAILS` alone and "admin" was the
 * provisional rule "first address in ALLOWED_EMAILS" (utils/auth.js). Both worked
 * for one operator and needed a Railway redeploy to change. This module puts a JSON
 * store beside the other data files so an admin can add a tester from Settings —
 * and it is designed around ONE rule that must never soften:
 *
 *   THE ENVIRONMENT IS THE FLOOR, THE STORE IS ADDITIVE.
 *
 *  - Effective allowlist = ALLOWED_EMAILS ∪ store.allowed. An address in the env is
 *    shown as such and cannot be removed here (change the env). An address in the
 *    store can be removed here and loses access on its NEXT request through every
 *    door — cookie, token — because `isAllowedEmail` (utils/auth.js) is re-checked
 *    per request and it consults this store. Nothing to revoke, nothing to remember.
 *  - Effective admins = ADMIN_EMAILS ∪ store.admins. If NEITHER names anyone, the
 *    first ALLOWED_EMAILS address is the bootstrap admin, so a deployment that has
 *    never configured admins keeps working exactly as before and the operator can
 *    promote themself in the UI to make it explicit. The bootstrap switches off the
 *    moment anyone is named; `addAdmin` therefore also persists the ACTING admin, so
 *    promoting your first colleague cannot lock you out.
 *  - Quotas: a monthly USD budget per user (calendar month, UTC). `defaultMonthlyUsd`
 *    applies to everyone who is not an admin; `perUser[email]` overrides it for
 *    anyone, admin or not (`null` = explicitly unlimited). Admins hold the wallet,
 *    so the default deliberately does not apply to them.
 *
 * READS ARE SYNCHRONOUS AND CACHED BY MTIME. `isAllowedEmail` and `getSessionEmail`
 * are synchronous today and called on every request; making them async would ripple
 * through requireAuth, routes/tokens.js and /api/me for no gain. So the store is read
 * with `readFileSync`, memoised on (path, mtimeMs, size), and re-read the moment the
 * file changes — including a change made by another process on the same volume.
 * One `statSync` per call is the whole cost.
 *
 * WRITES ARE SERIALISED AND ATOMIC (tmp + rename), same shape as utils/tokens.js.
 * Every updater returns `false` for "no change" and no write happens then — the
 * lost-update lesson from the token store applies here unchanged.
 *
 * DATA_ROOT is resolved per call, not at module load, so the route harness can point
 * one process at a throwaway store per test.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_FILENAME = 'access-control.json';

function storePath() {
    const dataRoot = path.resolve(process.env.DATA_ROOT || path.resolve(__dirname, '..', 'data'));
    return path.join(dataRoot, STORE_FILENAME);
}

function normEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function parseEnvList(name) {
    return (process.env[name] || '').split(',').map(normEmail).filter(Boolean);
}

/** ALLOWED_EMAILS as a lowercased array — the environment half of the allowlist. */
function envAllowedEmails() {
    return parseEnvList('ALLOWED_EMAILS');
}

/** ADMIN_EMAILS (optional) as a lowercased array — the environment half of the admins. */
function envAdminEmails() {
    return parseEnvList('ADMIN_EMAILS');
}

// ─── Store I/O ────────────────────────────────────────────────────────────────

function emptyStore() {
    return { version: 1, allowed: [], admins: [], quotas: { defaultMonthlyUsd: null, perUser: {} } };
}

function normaliseStore(parsed) {
    const store = emptyStore();
    if (!parsed || typeof parsed !== 'object') return store;
    for (const key of ['allowed', 'admins']) {
        if (Array.isArray(parsed[key])) {
            store[key] = parsed[key]
                .map(entry => (typeof entry === 'string' ? { email: entry } : entry))
                .filter(entry => entry && normEmail(entry.email))
                .map(entry => ({ email: normEmail(entry.email), addedBy: entry.addedBy || null, added: entry.added || null }));
        }
    }
    const q = parsed.quotas && typeof parsed.quotas === 'object' ? parsed.quotas : {};
    store.quotas.defaultMonthlyUsd = validQuota(q.defaultMonthlyUsd) ? q.defaultMonthlyUsd : null;
    if (q.perUser && typeof q.perUser === 'object') {
        for (const [email, value] of Object.entries(q.perUser)) {
            const clean = normEmail(email);
            if (clean && validQuota(value)) store.quotas.perUser[clean] = value;
        }
    }
    return store;
}

function validQuota(value) {
    return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

let cache = { key: null, store: null };

/**
 * The store, read synchronously and memoised on the file's identity. A missing or
 * unreadable file is an empty store: nothing extra allowed, nobody extra admin, no
 * quotas — the safe direction, and exactly the pre-Phase-4 behaviour.
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

/**
 * Serialised read-modify-write. ⚠️ Same contract as utils/tokens.js: an updater
 * that changed nothing returns `false` and no write happens. The path is resolved
 * once and used for both halves.
 */
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

// ─── Allowlist ────────────────────────────────────────────────────────────────

/** True when the STORE (not the env) allows this email. auth.js ORs it with the env. */
function isStoreAllowed(email) {
    const clean = normEmail(email);
    if (!clean) return false;
    return readStoreSync().allowed.some(e => e.email === clean);
}

/**
 * The effective allowlist for display: env entries first (source 'env'), then
 * store entries not already in the env (source 'store'). An address in both is
 * reported as 'env' — that is the one that governs whether it can be removed here.
 */
function listAllowed() {
    const env = envAllowedEmails();
    const out = env.map(email => ({ email, source: 'env', addedBy: null, added: null }));
    for (const entry of readStoreSync().allowed) {
        if (env.includes(entry.email)) continue;
        out.push({ email: entry.email, source: 'store', addedBy: entry.addedBy, added: entry.added });
    }
    return out;
}

async function addAllowedEmail(email, { by = null } = {}) {
    const clean = normEmail(email);
    if (!clean.includes('@')) throw new Error('A valid email address is required.');
    return updateStore(store => {
        if (store.allowed.some(e => e.email === clean)) return false;
        store.allowed.push({ email: clean, addedBy: normEmail(by) || null, added: new Date().toISOString() });
        return true;
    });
}

/**
 * Remove an address from the store's allowlist. Also drops it from the store's
 * admins: removing someone's access must not leave them a phantom admin who
 * reappears the moment they are re-added. Env-listed addresses are not touched here
 * — the route refuses them before calling this, and even if it didn't, the env
 * would still admit them (the env is the floor).
 */
async function removeAllowedEmail(email) {
    const clean = normEmail(email);
    return updateStore(store => {
        const before = store.allowed.length + store.admins.length;
        store.allowed = store.allowed.filter(e => e.email !== clean);
        store.admins = store.admins.filter(e => e.email !== clean);
        return store.allowed.length + store.admins.length !== before;
    });
}

// ─── Admins ───────────────────────────────────────────────────────────────────

/**
 * Whether the bootstrap rule is live: nobody named in ADMIN_EMAILS and nobody in
 * the store's admins. Then, and only then, the first ALLOWED_EMAILS address is admin.
 */
function bootstrapAdminEmail() {
    if (envAdminEmails().length) return null;
    if (readStoreSync().admins.length) return null;
    const [first] = envAllowedEmails();
    return first || null;
}

/** True when this email is an admin by ANY source: env, store, or bootstrap. */
function isAdmin(email) {
    const clean = normEmail(email);
    if (!clean) return false;
    if (envAdminEmails().includes(clean)) return true;
    if (readStoreSync().admins.some(e => e.email === clean)) return true;
    return bootstrapAdminEmail() === clean;
}

/** Effective admins for display, each with its source. */
function listAdmins() {
    const env = envAdminEmails();
    const out = env.map(email => ({ email, source: 'env', addedBy: null, added: null }));
    for (const entry of readStoreSync().admins) {
        if (env.includes(entry.email)) continue;
        out.push({ email: entry.email, source: 'store', addedBy: entry.addedBy, added: entry.added });
    }
    const bootstrap = bootstrapAdminEmail();
    if (bootstrap) out.push({ email: bootstrap, source: 'bootstrap', addedBy: null, added: null });
    return out;
}

/**
 * Promote. Persists the ACTING admin too if their standing came only from the
 * bootstrap rule — the first promotion switches the bootstrap off, and without this
 * the person doing the promoting would demote themself with the same click.
 */
async function addAdmin(email, { by = null } = {}) {
    const clean = normEmail(email);
    if (!clean.includes('@')) throw new Error('A valid email address is required.');
    const actor = normEmail(by);
    const actorIsBootstrapOnly = actor && bootstrapAdminEmail() === actor;
    return updateStore(store => {
        let changed = false;
        const now = new Date().toISOString();
        if (actorIsBootstrapOnly && !store.admins.some(e => e.email === actor)) {
            store.admins.push({ email: actor, addedBy: actor, added: now });
            changed = true;
        }
        if (!store.admins.some(e => e.email === clean)) {
            store.admins.push({ email: clean, addedBy: actor || null, added: now });
            changed = true;
        }
        return changed;
    });
}

/** Demote a store admin. Env admins are refused by the route; the store can't reach them. */
async function removeAdmin(email) {
    const clean = normEmail(email);
    return updateStore(store => {
        const before = store.admins.length;
        store.admins = store.admins.filter(e => e.email !== clean);
        return store.admins.length !== before;
    });
}

// ─── Quotas ───────────────────────────────────────────────────────────────────

/** { defaultMonthlyUsd: number|null, perUser: { email: number|null } } */
function getQuotas() {
    const q = readStoreSync().quotas;
    return { defaultMonthlyUsd: q.defaultMonthlyUsd, perUser: { ...q.perUser } };
}

/**
 * Replace the quota configuration. `defaultMonthlyUsd`: number ≥ 0 or null (no
 * default cap). `perUser`: map of email → number ≥ 0 (cap) or null (explicitly
 * unlimited, even if a default is set); an email absent from the map inherits the
 * default. Rejects anything else — a quota that fails to parse must not silently
 * become "unlimited".
 */
async function setQuotas({ defaultMonthlyUsd, perUser } = {}) {
    if (defaultMonthlyUsd !== undefined && !validQuota(defaultMonthlyUsd)) {
        throw new Error('defaultMonthlyUsd must be a number ≥ 0, or null.');
    }
    const cleanPerUser = {};
    if (perUser !== undefined) {
        if (!perUser || typeof perUser !== 'object' || Array.isArray(perUser)) {
            throw new Error('perUser must be an object of email → number|null.');
        }
        for (const [email, value] of Object.entries(perUser)) {
            const clean = normEmail(email);
            if (!clean.includes('@')) throw new Error(`Not an email address: ${email}`);
            if (!validQuota(value)) throw new Error(`Quota for ${clean} must be a number ≥ 0, or null.`);
            cleanPerUser[clean] = value;
        }
    }
    return updateStore(store => {
        const next = {
            defaultMonthlyUsd: defaultMonthlyUsd === undefined ? store.quotas.defaultMonthlyUsd : defaultMonthlyUsd,
            perUser: perUser === undefined ? store.quotas.perUser : cleanPerUser
        };
        if (JSON.stringify(next) === JSON.stringify(store.quotas)) return false;
        store.quotas = next;
        return true;
    });
}

/**
 * The monthly USD cap that applies to `email`, or null for none. Per-user override
 * wins; otherwise admins are uncapped and everyone else gets the default.
 */
function effectiveQuotaFor(email) {
    const clean = normEmail(email);
    if (!clean) return null;
    const q = readStoreSync().quotas;
    if (Object.prototype.hasOwnProperty.call(q.perUser, clean)) return q.perUser[clean];
    if (isAdmin(clean)) return null;
    return q.defaultMonthlyUsd;
}

module.exports = {
    envAllowedEmails,
    envAdminEmails,
    isStoreAllowed,
    listAllowed,
    addAllowedEmail,
    removeAllowedEmail,
    isAdmin,
    listAdmins,
    bootstrapAdminEmail,
    addAdmin,
    removeAdmin,
    getQuotas,
    setQuotas,
    effectiveQuotaFor,
    _storePath: storePath,
    _readStoreSync: readStoreSync
};
