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
 * HOUSE KEYS ONLY IN THIS FILE TODAY. `keyFor(provider, { baseUrl, email })` already
 * takes the caller, and ignores it: every deployment runs on the house keys until
 * item 3 adds the per-person store and the `house` / `byok` modes. When it does, the
 * change is here and nowhere else.
 *
 * ⚠️ OPENAI-COMPATIBLE KEYS ARE PER ENDPOINT, NOT PER FAMILY. Moonshot, DeepSeek,
 * Groq and a local server all speak the same protocol and are four different
 * accounts. `OPENAI_KEYS` is a `<baseUrl>=<key>` list (comma- or newline-separated);
 * `OPENAI_API_KEY` is the catch-all for a deployment that only talks to one.
 */

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

/**
 * The key to use, or null.
 *
 * `email` is accepted and currently unused — see the header. Returning null rather
 * than throwing is deliberate: the caller knows whether a missing key is a 4xx the
 * writer should read ("add your Gemini key in Settings") or a feature that simply
 * is not available ("nothing to discover with").
 */
function keyFor(provider, { baseUrl = null, email = null } = {}) {
    void email; // identity-aware in item 3
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

module.exports = { keyFor, setHouseKeyOverrides, _openAiKeyMap: openAiKeyMap };
