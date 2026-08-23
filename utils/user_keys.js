/**
 * utils/user_keys.js — each person's own API keys, encrypted at rest (Phase 5 item 3).
 *
 * WHY IT EXISTS. Carsten's brief of 2026-08-21: BYOK matters, but **testers must not
 * have to deal with API keys**. So the deployment whitelists who runs on the house
 * keys (`house`, the default, capped by their monthly budget) and who must bring
 * their own (`byok`, their money, uncapped unless given an explicit budget). The
 * mode lives beside the allowlist in `utils/access_control.js`; the keys live here.
 *
 * ⚠️ ENCRYPTED, NOT HASHED. A token can be hashed because it is only ever compared;
 * an API key has to be USED, so it has to come back out. AES-256-GCM with a key
 * derived (scrypt) from `SESSION_SECRET`, falling back to `APP_SECRET` — the same
 * secret that already signs sessions, so there is no new thing to configure and no
 * new thing to lose. The IV is per value and the auth tag is stored with it, so a
 * tampered file fails to decrypt instead of yielding a silently wrong key.
 *
 * ⚠️ CHANGING SESSION_SECRET ORPHANS EVERY STORED KEY. There is no way around that
 * — it is what "encrypted at rest with a secret you hold" means. A value that will
 * not decrypt is treated as ABSENT and logged loudly, so the writer gets the honest
 * "add your Gemini key" 4xx rather than a 401 from the provider that reads like the
 * key is wrong. Rotating the secret means everyone re-enters their keys.
 *
 * ⚠️ PLAINTEXT LEAVES THIS MODULE ONLY THROUGH `getKey`. `listKeys` returns masks
 * (`••••abcd`) and nothing else; there is deliberately no "show me my key again"
 * call, exactly as with access tokens. The value exists twice: in the request that
 * set it and in the encrypted file.
 *
 * Shape, `<DATA_ROOT>/user-keys.json`:
 *   { version: 1, users: { "me@example.com": { "gemini": {…}, "openai-compatible:https://api.moonshot.ai/v1": {…} } } }
 *
 * Mechanics match utils/access_control.js — mtime-cached synchronous reads (key
 * resolution happens inside `getModelConfig`, which is sync and has ~30 call sites),
 * serialised atomic writes, no-op updaters return `false`.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_FILENAME = 'user-keys.json';
const SCRYPT_SALT = 'pageone-user-keys-v1';

function storePath() {
    const dataRoot = path.resolve(process.env.DATA_ROOT || path.resolve(__dirname, '..', 'data'));
    return path.join(dataRoot, STORE_FILENAME);
}

function normEmail(email) {
    return String(email || '').trim().toLowerCase();
}

/**
 * The provider slot a key belongs to. `gemini` and `anthropic` are one account each;
 * an OpenAI-compatible key is per ENDPOINT, because Moonshot and DeepSeek speak the
 * same protocol and are different accounts.
 */
function keySlot(provider, baseUrl = null) {
    if (provider === 'gemini' || provider === 'anthropic') return provider;
    if (provider === 'openai-compatible') {
        const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
        if (!clean) throw new Error('An OpenAI-compatible key needs the endpoint it belongs to.');
        return `openai-compatible:${clean}`;
    }
    throw new Error(`Unknown provider: ${provider}`);
}

/** Split a slot back into { provider, baseUrl } for display. */
function parseSlot(slot) {
    if (slot === 'gemini' || slot === 'anthropic') return { provider: slot, baseUrl: null };
    if (slot.startsWith('openai-compatible:')) {
        return { provider: 'openai-compatible', baseUrl: slot.slice('openai-compatible:'.length) };
    }
    return { provider: null, baseUrl: null };
}

// ─── Crypto ───────────────────────────────────────────────────────────────────

let derived = { secret: null, key: null };

/**
 * The encryption key. Null when the deployment has no secret at all (unconfigured
 * local dev) — in which case storing a key is refused rather than stored in clear.
 */
function encryptionKey() {
    const secret = process.env.SESSION_SECRET || process.env.APP_SECRET || '';
    if (!secret) return null;
    if (derived.secret === secret && derived.key) return derived.key;
    derived = { secret, key: crypto.scryptSync(secret, SCRYPT_SALT, 32) };
    return derived.key;
}

function encrypt(plaintext) {
    const key = encryptionKey();
    if (!key) {
        throw new Error('This deployment has no SESSION_SECRET or APP_SECRET, so there is nothing to encrypt a key with. Set one before storing API keys.');
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return {
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ct: ct.toString('base64'),
        // Kept in the clear on purpose: the masked display and the "which key is
        // this" question must not require decrypting, so a deployment whose secret
        // has rotated can still SHOW the writer which keys they need to re-enter.
        last4: String(plaintext).slice(-4),
        added: new Date().toISOString()
    };
}

/** Plaintext, or null when it cannot be decrypted (rotated secret, tampered file). */
function decrypt(record, { slot = '', email = '' } = {}) {
    const key = encryptionKey();
    if (!key || !record?.iv || !record?.tag || !record?.ct) return null;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(record.ct, 'base64')), decipher.final()]).toString('utf8');
    } catch {
        // Loud, because the honest failure downstream ("add your key") reads like
        // the writer never added one — and they did.
        console.error(`[user-keys] cannot decrypt ${slot} for ${email}: the session secret has changed since it was stored. `
            + 'That key must be entered again.');
        return null;
    }
}

// ─── Store I/O ────────────────────────────────────────────────────────────────

function emptyStore() {
    return { version: 1, users: {} };
}

function normaliseStore(parsed) {
    const store = emptyStore();
    if (!parsed || typeof parsed !== 'object') return store;
    const users = parsed.users && typeof parsed.users === 'object' ? parsed.users : {};
    for (const [email, slots] of Object.entries(users)) {
        const clean = normEmail(email);
        if (!clean || !slots || typeof slots !== 'object') continue;
        const kept = {};
        for (const [slot, record] of Object.entries(slots)) {
            if (!record || typeof record !== 'object' || !record.ct) continue;
            if (!parseSlot(slot).provider) continue;
            kept[slot] = record;
        }
        if (Object.keys(kept).length) store.users[clean] = kept;
    }
    return store;
}

let cache = { key: null, store: null };

function readStoreSync() {
    const target = storePath();
    let stat;
    try {
        stat = fs.statSync(target);
    } catch {
        cache = { key: null, store: null };
        return emptyStore();
    }
    const cacheKey = `${target}|${stat.mtimeMs}|${stat.size}`;
    if (cache.key === cacheKey && cache.store) return cache.store;
    let store;
    try {
        store = normaliseStore(JSON.parse(fs.readFileSync(target, 'utf-8')));
    } catch {
        store = emptyStore();
    }
    cache = { key: cacheKey, store };
    return store;
}

let writeChain = Promise.resolve();

async function writeStore(store, target) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmpPath = path.join(path.dirname(target), `.tmp-${crypto.randomBytes(6).toString('hex')}`);
    // 0600: the file is encrypted, but there is no reason for it to be world-readable
    // on a volume that other processes may share.
    await fs.promises.writeFile(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fs.promises.rename(tmpPath, target);
    cache = { key: null, store: null };
}

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
 * This person's key for a provider, decrypted — or null. THE ONLY PLAINTEXT EXIT.
 */
function getKey(email, provider, baseUrl = null) {
    const clean = normEmail(email);
    if (!clean) return null;
    let slot;
    try { slot = keySlot(provider, baseUrl); } catch { return null; }
    const record = readStoreSync().users[clean]?.[slot];
    if (!record) return null;
    return decrypt(record, { slot, email: clean });
}

/** True when this person has a usable key for the provider. */
function hasKey(email, provider, baseUrl = null) {
    return Boolean(getKey(email, provider, baseUrl));
}

/**
 * What this person has stored, MASKED — for the Settings panel. Never plaintext.
 * `usable: false` means it is there but will not decrypt (rotated secret), which the
 * UI must say out loud so "add your key" does not look like a lie.
 */
function listKeys(email) {
    const clean = normEmail(email);
    if (!clean) return [];
    const slots = readStoreSync().users[clean] || {};
    return Object.entries(slots).map(([slot, record]) => ({
        slot,
        ...parseSlot(slot),
        mask: record.last4 ? `••••${record.last4}` : '••••',
        added: record.added || null,
        usable: Boolean(decrypt(record, { slot, email: clean }))
    }));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/** Store (or replace) one key. Throws when there is no secret to encrypt with. */
async function setKey(email, provider, value, baseUrl = null) {
    const clean = normEmail(email);
    if (!clean.includes('@')) throw new Error('A valid email address is required.');
    const slot = keySlot(provider, baseUrl);
    const plaintext = String(value || '').trim();
    if (!plaintext) throw new Error('An API key is required.');
    const record = encrypt(plaintext); // throws before any write if there is no secret
    return updateStore(store => {
        if (!store.users[clean]) store.users[clean] = {};
        store.users[clean][slot] = record;
        return true;
    });
}

async function removeKey(email, provider, baseUrl = null) {
    const clean = normEmail(email);
    const slot = keySlot(provider, baseUrl);
    return updateStore(store => {
        if (!store.users[clean]?.[slot]) return false;
        delete store.users[clean][slot];
        if (!Object.keys(store.users[clean]).length) delete store.users[clean];
        return true;
    });
}

/** Drop everything for one person — used when their access is removed. */
async function forgetUser(email) {
    const clean = normEmail(email);
    return updateStore(store => {
        if (!store.users[clean]) return false;
        delete store.users[clean];
        return true;
    });
}

/** True when this deployment can store keys at all. */
function canStoreKeys() {
    return Boolean(encryptionKey());
}

module.exports = {
    keySlot,
    parseSlot,
    getKey,
    hasKey,
    listKeys,
    setKey,
    removeKey,
    forgetUser,
    canStoreKeys,
    _storePath: storePath
};
