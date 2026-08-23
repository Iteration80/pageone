/**
 * utils/api_keys.js — the one answer to "which key talks to this provider".
 *
 * WHY IT IS A MODULE AND NOT AN ARGUMENT. Roughly thirty call sites across
 * `agents/*` destructure `{ model, geminiApiKey, anthropicApiKey }` and hand them to
 * `generateContent` one at a time. Adding a third provider by adding two more
 * parameters would mean editing all thirty, and the failure mode of missing one is
 * the quiet kind: a stage that keeps working on Gemini and throws "no key" the day
 * someone points it at Kimi. Worse, Phase 5 item 3 makes the answer depend on WHO is
 * asking, and a per-call argument is something a new route can forget to pass.
 *
 * So resolution lives here, `getModelConfig` asks it, and `ai-client.js` asks it for
 * anything a caller did not supply. There is one place to make it identity-aware.
 *
 * TWO MODES, PER PERSON (Phase 5 item 3, `utils/access_control.js`):
 *
 *  - `house` (the default) — the deployment's keys, counted against that person's
 *    monthly budget. The point of the default: a tester Carsten whitelists never
 *    has to deal with an API key at all.
 *  - `byok` — that person's own keys (`utils/user_keys.js`) and NOTHING ELSE.
 *
 * ⚠️ A BYOK CALLER MUST NEVER TOUCH A HOUSE KEY. This is the silent-200 family: a
 * fallback would work perfectly, cost Carsten money, and show up nowhere. So the
 * byok branch returns the person's key or `null` — it does not consult the house
 * keys at all, and there is no `||` at the end of it. Callers turn that null into an
 * honest 4xx naming the provider (`resolveKeysForModel` in server.js) instead of a
 * 500 from a provider that looks like the key is wrong.
 *
 * ⚠️ NO IDENTITY MEANS HOUSE. Startup, migrations, break-glass and open dev all run
 * without a scoped caller and are already trusted with the deployment — the same
 * rule the ownership chokepoints use.
 *
 * ⚠️ OPENAI-COMPATIBLE KEYS ARE PER ENDPOINT, NOT PER FAMILY. Moonshot, DeepSeek,
 * Groq and a local server all speak the same protocol and are four different
 * accounts. `OPENAI_KEYS` is a `<baseUrl>=<key>` list (comma- or newline-separated);
 * `OPENAI_API_KEY` is the catch-all for a deployment that only talks to one.
 */

const accessControl = require('./access_control');
const userKeys = require('./user_keys');
const { currentUserEmail } = require('./request_identity');

/**
 * Where the runtime (Settings-stored) keys come from, installed by server.js.
 * Kept as a hook rather than a require so this module has no dependency on the
 * server's `appSettings` object — which would be circular, and would also make the
 * module untestable on its own.
 */
let houseOverrides = () => ({});

function setHouseKeyOverrides(fn) {
    houseOverrides = typeof fn === 'function' ? fn : () => ({});
}

function normaliseUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

/** Parse `OPENAI_KEYS` into a `{ baseUrl: key }` map. Malformed entries are skipped. */
function openAiKeyMap() {
    const map = {};
    for (const entry of String(process.env.OPENAI_KEYS || '').split(/[,\n]/)) {
        const at = entry.indexOf('=');
        if (at < 0) continue;
        const host = normaliseUrl(entry.slice(0, at));
        const key = entry.slice(at + 1).trim();
        if (host && key) map[host] = key;
    }
    return map;
}

/** The deployment's own key for a provider, or null. */
function houseKeyFor(provider, baseUrl = null) {
    const overrides = houseOverrides() || {};
    if (provider === 'gemini') {
        return overrides.geminiApiKey || process.env.GEMINI_API_KEY || null;
    }
    if (provider === 'anthropic') {
        return overrides.anthropicApiKey || process.env.ANTHROPIC_API_KEY || null;
    }
    if (provider === 'openai-compatible') {
        const wanted = normaliseUrl(baseUrl);
        const fromSettings = overrides.openaiKeys && overrides.openaiKeys[wanted];
        return fromSettings || openAiKeyMap()[wanted] || process.env.OPENAI_API_KEY || null;
    }
    return null;
}

/**
 * Which mode applies. Defaults to the async-context identity, so a caller that does
 * not pass one still gets the right answer — the same reason `getModelConfig` reads
 * the context instead of taking a parameter. Pass `email: null` explicitly to ask
 * about the deployment itself.
 */
function modeFor(email) {
    const who = email === undefined ? currentUserEmail() : email;
    if (!who) return { email: null, mode: 'house' }; // system, break-glass, open dev
    return { email: who, mode: accessControl.keyModeFor(who) };
}

/**
 * The key to use, or null.
 *
 * Returning null rather than throwing is deliberate: the caller knows whether a
 * missing key is a 4xx the writer should read ("add your Gemini key in Settings")
 * or a feature that simply is not available ("nothing to discover with").
 */
function keyFor(provider, { baseUrl = null, email } = {}) {
    const { email: who, mode } = modeFor(email);
    if (mode === 'byok') {
        // ⚠️ NO FALLBACK, DELIBERATELY — there is no `||` at the end of this line.
        // A byok caller quietly running on the house key is the exact failure this
        // mode exists to prevent, it would work perfectly, and it would be invisible.
        return userKeys.getKey(who, provider, baseUrl);
    }
    return houseKeyFor(provider, baseUrl);
}

/**
 * The same question answered in full, for a caller that has to explain itself:
 * `{ provider, baseUrl, email, mode, key }` with `key: null` when there is none.
 */
function resolveKey(provider, { baseUrl = null, email } = {}) {
    const { email: who, mode } = modeFor(email);
    return {
        provider,
        baseUrl: baseUrl ? normaliseUrl(baseUrl) : null,
        email: who,
        mode,
        key: keyFor(provider, { baseUrl, email: who })
    };
}

module.exports = { keyFor, resolveKey, houseKeyFor, setHouseKeyOverrides, _openAiKeyMap: openAiKeyMap };
