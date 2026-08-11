/**
 * utils/tokens.js — personal access tokens (multi-user Phase 1).
 *
 * Chosen over `APP_SECRET` for scripts and over a hosted IdP (decision 2026-08-09):
 * a token is minted from a signed-in Google session, belongs to one person, is
 * individually revocable, and — critically — carries an OWNER EMAIL, so it resolves
 * to the same identity a session cookie does. `APP_SECRET` is not retired; it stays
 * in Railway env as break-glass, never on a laptop.
 *
 * Design, mirroring utils/auth.js:
 *  - DECISIONS LIVE HERE. This module owns what a token is, how it's hashed, and
 *    whether one is currently valid. routes/tokens.js only wires it to URLs, and
 *    server.js's requireAuth calls `verifyToken` exactly the way it calls
 *    `getSessionEmail`.
 *  - HASH ONLY AT REST. The store keeps SHA-256(token) and metadata; the plaintext
 *    exists once, in the response to the create call. There is no "show token
 *    again" route because there is nothing to show — that's the point.
 *  - THE ALLOWLIST IS STILL THE KILL SWITCH. `verifyToken` deliberately does NOT
 *    check ALLOWED_EMAILS; requireAuth re-checks the returned owner against it on
 *    every request, exactly as it does for a cookie. Removing someone from the
 *    allowlist must kill their tokens instantly, without anyone revoking anything.
 *  - LAZY ENV READ. DATA_ROOT is resolved per call, not at module load, so the
 *    route harness can point one process at a throwaway store per test.
 *
 * Hashing is a bare SHA-256, not bcrypt/scrypt: the secret is 32 bytes of CSPRNG
 * output, not a human-chosen password, so there is no dictionary to grind and a
 * work factor buys nothing. It would only slow down every authenticated request.
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const TOKEN_PREFIX = 'pgo_';
const TOKEN_BYTES = 32;
const STORE_FILENAME = 'access-tokens.json';
const MAX_NAME_LENGTH = 80;

// Writing `lastUsed` on every request would turn a read-only API call into a disk
// write. A minute's resolution is all this field is for — "is this token still in
// use, can I revoke it" — so a write is skipped unless the stamp is actually stale.
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

function storePath() {
    const dataRoot = path.resolve(process.env.DATA_ROOT || path.resolve(__dirname, '..', 'data'));
    return path.join(dataRoot, STORE_FILENAME);
}

// ─── Store I/O ────────────────────────────────────────────────────────────────

// One file, one writer. Every mutation goes through this chain, so a create landing
// while a revoke is mid-flight cannot read-modify-write over the top of it. Same
// shape as server.js's per-project write lock, scoped to a single file.
let writeChain = Promise.resolve();

async function readStore(target = storePath()) {
    try {
        const raw = await fs.readFile(target, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.tokens) ? parsed : { version: 1, tokens: [] };
    } catch {
        // Missing or unreadable: an empty store. A token store that can't be read
        // authenticates nobody, which is the safe direction to fail.
        return { version: 1, tokens: [] };
    }
}

async function writeStore(store, target = storePath()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmpPath = path.join(path.dirname(target), `.tmp-${crypto.randomBytes(6).toString('hex')}`);
    await fs.writeFile(tmpPath, JSON.stringify(store, null, 2));
    await fs.rename(tmpPath, target);
}

/**
 * Serialized read-modify-write over the store.
 *
 * ⚠️ CONTRACT: an updater that changed nothing must return `false`, and then no
 * write happens at all. This is not an optimisation. A read-modify-write that
 * rewrites the whole file even on a no-op has a lost-update window for its entire
 * duration — and `touchToken` runs fire-and-forget, off the back of requests, so a
 * no-op stamp landing between another writer's read and write would silently erase
 * a token that had just been minted. Caught 2026-08-11 by exactly that race: a
 * freshly minted token came back 201 and then failed to authenticate.
 *
 * The path is resolved ONCE here and passed to both halves, so a read and its
 * matching write can never target two different files.
 *
 * Within one process `writeChain` makes the whole sequence atomic. Across processes
 * (two Railway instances on one volume) it is not — skipping no-op writes shrinks
 * that window to real mutations only, which is as far as a JSON-file store goes.
 */
async function updateStore(updater) {
    const run = writeChain.catch(() => {}).then(async () => {
        const target = storePath();
        const store = await readStore(target);
        const result = await updater(store);
        if (result !== false) await writeStore(store, target);
        return result;
    });
    writeChain = run.catch(() => {});
    return run;
}

// ─── Token shape ──────────────────────────────────────────────────────────────

function hashToken(rawToken) {
    return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

/**
 * Whether a presented credential is shaped like one of ours.
 *
 * requireAuth uses this to decide whether to spend a store read on a header, so it
 * has to be cheap and it has to be a fact about OUR format, not a guess: every token
 * we mint starts with `pgo_`, and nothing else we accept does.
 */
function looksLikeAccessToken(value) {
    return typeof value === 'string' && value.startsWith(TOKEN_PREFIX);
}

/** The client-safe view of a token record — everything except the hash. */
function publicRecord(record) {
    return {
        id: record.id,
        name: record.name,
        owner: record.owner,
        created: record.created,
        lastUsed: record.lastUsed || null,
        expires: record.expires || null
    };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Mint a token for `owner`. Returns `{ token, record }` — `token` is the plaintext
 * and this is the only moment it exists anywhere.
 */
async function createToken({ name, owner, expiresInDays } = {}) {
    const cleanOwner = String(owner || '').trim().toLowerCase();
    if (!cleanOwner) throw new Error('createToken requires an owner email');

    const cleanName = String(name || '').trim().slice(0, MAX_NAME_LENGTH) || 'Unnamed token';
    const token = TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('base64url');

    const now = new Date().toISOString();
    const record = {
        id: crypto.randomUUID(),
        name: cleanName,
        owner: cleanOwner,
        hash: hashToken(token),
        created: now,
        lastUsed: null,
        expires: Number.isFinite(expiresInDays) && expiresInDays > 0
            ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
            : null
    };

    // `true`, explicitly: the updateStore contract keys the write off the return
    // value, and a bare push returning undefined is one edit away from returning
    // something falsy and silently not persisting.
    await updateStore(store => { store.tokens.push(record); return true; });
    return { token, record: publicRecord(record) };
}

/** Every token belonging to `owner`, newest first. Never includes hashes. */
async function listTokens(owner) {
    const cleanOwner = String(owner || '').trim().toLowerCase();
    const store = await readStore();
    return store.tokens
        .filter(t => t.owner === cleanOwner)
        .sort((a, b) => String(b.created).localeCompare(String(a.created)))
        .map(publicRecord);
}

/**
 * Delete one token. Scoped to `owner` on purpose: an id is not a capability, so a
 * caller must not be able to revoke a token they don't own by guessing one.
 * Returns true if something was deleted.
 */
async function revokeToken(id, owner) {
    const cleanOwner = String(owner || '').trim().toLowerCase();
    return updateStore(store => {
        const index = store.tokens.findIndex(t => t.id === id && t.owner === cleanOwner);
        if (index < 0) return false;
        store.tokens.splice(index, 1);
        return true;
    });
}

/**
 * Resolve a presented token to its record, or null.
 *
 * ⚠️ A non-null return means the token EXISTS and has not expired. It does not mean
 * the request is authorized — the caller must still check `record.owner` against the
 * live allowlist. That check is deliberately not made here so there is exactly one
 * place in the codebase that decides what an authenticated identity is allowed to
 * do, and it is the same place for cookies and tokens.
 */
async function verifyToken(rawToken) {
    if (!looksLikeAccessToken(rawToken)) return null;
    const hash = hashToken(rawToken);
    const store = await readStore();
    const record = store.tokens.find(t => t.hash === hash);
    if (!record) return null;
    if (record.expires && Date.now() > Date.parse(record.expires)) return null;
    return publicRecord(record);
}

/**
 * Stamp `lastUsed`, at most once per minute per token. Fire-and-forget: a failed
 * bookkeeping write must never turn an authenticated request into a 401.
 */
async function touchToken(id) {
    try {
        await updateStore(store => {
            const record = store.tokens.find(t => t.id === id);
            if (!record) return false;
            const last = record.lastUsed ? Date.parse(record.lastUsed) : 0;
            if (Date.now() - last < LAST_USED_WRITE_INTERVAL_MS) return false;
            record.lastUsed = new Date().toISOString();
            return true;
        });
    } catch (err) {
        console.warn('[tokens] could not update lastUsed:', err.message);
    }
}

module.exports = {
    TOKEN_PREFIX,
    createToken,
    listTokens,
    revokeToken,
    verifyToken,
    touchToken,
    looksLikeAccessToken,
    hashToken,
    _storePath: storePath // tests assert the store lands under DATA_ROOT
};
