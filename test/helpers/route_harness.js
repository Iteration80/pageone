/**
 * Route-invocation test harness.
 *
 * This project has spent months without one, and it has cost three production bugs:
 * `794c332` (removing code left a reference behind), `f923414` (removing code took a
 * declaration with it — visible Stage 3 dead for 16 days), and the Stage 1 pitch
 * loss. All three were invisible to `node --check` and to source-string tests, and
 * all three would have been caught by one real request. **A green suite has never
 * been evidence that a route works.**
 *
 * It boots the REAL app — `server.js` already exports `app` and only calls listen
 * under `require.main === module` — on an ephemeral port, against a throwaway
 * DATA_ROOT, and makes real HTTP requests through Node's fetch.
 *
 * Env captured at module load (APP_SECRET, DATA_ROOT) cannot be changed after
 * server.js is required, so `startTestServer` re-requires the whole first-party
 * module graph per call. That is what lets one test file exercise open / secret /
 * google mode in the same process. It costs a few ms and buys real coverage.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

/** Drop every first-party module from the require cache so server.js rebuilds. */
function evictFirstPartyModules() {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(REPO_ROOT) && !key.includes(NODE_MODULES)) delete require.cache[key];
    }
}

function setEnv(values) {
    const previous = {};
    for (const [key, value] of Object.entries(values)) {
        previous[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = String(value);
    }
    return previous;
}

function restoreEnv(previous) {
    for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

function setCookiesFrom(response) {
    const jar = {};
    const raw = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    for (const line of raw) {
        const [pair, ...attrs] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        jar[pair.slice(0, eq).trim()] = {
            value: pair.slice(eq + 1).trim(),
            attributes: attrs.map(a => a.trim()),
            raw: line
        };
    }
    return jar;
}

/**
 * Boot the app. `env` values are applied before server.js is required; pass
 * `undefined` to unset one. Always call `await server.close()`.
 */
async function startTestServer({ env = {} } = {}) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pageone-routes-'));
    fs.mkdirSync(path.join(dataRoot, 'projects'), { recursive: true });

    const previousEnv = setEnv({
        DATA_ROOT: dataRoot,
        // Default everything auth-related OFF so each test states its own mode
        // rather than inheriting the developer's .env.
        //
        // ⚠️ Set to '' rather than deleted, deliberately. server.js calls
        // dotenv.config() at require time, and dotenv fills in any key that is
        // ABSENT from process.env — so deleting these would let a local .env
        // silently switch a test into a different auth mode, and the test would
        // still pass, for the wrong reason. An empty string is present-but-falsy,
        // which every auth check treats as unconfigured.
        APP_SECRET: '',
        SESSION_SECRET: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        ALLOWED_EMAILS: '',
        OAUTH_BASE_URL: '',
        // Model keys OFF too, for the same reason. Route tests are written to stop
        // at validation or ownership, before any model call — but with the
        // developer's .env leaking in, a route that got PAST those checks would
        // silently spend real money and take 20 s to do it (2026-08-16: a cross-user
        // multipart POST generated a real pitch into the wrong project, and the
        // only clue was the test's duration). No key means such a route fails
        // fast and honestly with a 500 the test can see.
        GEMINI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        GEMINI_MODEL: '',
        ...env
    });

    evictFirstPartyModules();
    const serverModule = require(path.join(REPO_ROOT, 'server.js'));

    const listener = await new Promise((resolve, reject) => {
        const handle = serverModule.app.listen(0, '127.0.0.1', () => resolve(handle));
        handle.on('error', reject);
    });
    const origin = `http://127.0.0.1:${listener.address().port}`;

    /**
     * One request. Returns status, headers, the set-cookie jar, and the body as
     * both text and (when it parses) JSON — so a test never has to guess which.
     */
    async function request(pathname, { method = 'GET', headers = {}, body, cookies, json } = {}) {
        const requestHeaders = { ...headers };
        if (cookies && Object.keys(cookies).length) {
            requestHeaders.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        }
        let payload = body;
        if (json !== undefined) {
            payload = JSON.stringify(json);
            requestHeaders['content-type'] = 'application/json';
        }
        const response = await fetch(`${origin}${pathname}`, {
            method,
            headers: requestHeaders,
            body: payload,
            redirect: 'manual' // a redirect is the assertion in the OAuth tests
        });
        const text = await response.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        return {
            status: response.status,
            location: response.headers.get('location'),
            headers: response.headers,
            cookies: setCookiesFrom(response),
            text,
            json: parsed
        };
    }

    return {
        origin,
        dataRoot,
        request,
        module: serverModule,
        async close() {
            await new Promise(resolve => listener.close(resolve));
            restoreEnv(previousEnv);
            fs.rmSync(dataRoot, { recursive: true, force: true });
            evictFirstPartyModules();
        }
    };
}

/** True when a Set-Cookie line actually expires the cookie rather than setting it. */
function cookieIsCleared(entry) {
    if (!entry) return false;
    if (entry.value === '') return true;
    return entry.attributes.some(attr => /^max-age=0$/i.test(attr))
        || entry.attributes.some(attr => /^expires=/i.test(attr) && new Date(attr.slice(8)).getTime() <= Date.now());
}

module.exports = { startTestServer, cookieIsCleared };
