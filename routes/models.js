/**
 * routes/models.js — the model registry over HTTP (Phase 5 item 1).
 *
 * Split by kind like routes/admin.js: `utils/model_registry.js` decides what a model
 * row IS and what may be written to it; this file wires those decisions to URLs and
 * adds the per-request policy.
 *
 * TWO GUARDS, THE SAME SPLIT AS routes/admin.js:
 *  - `GET /api/models` is `requireAuth` — every writer's Settings dropdowns are
 *    built from it, and the browser loads the price table from it.
 *  - Every mutation is `requireAdminSession`: a live Google SESSION of an admin,
 *    never a token. Adding a model row is adding a way to spend the deployment's
 *    money, and (with an openai-compatible row) a URL the server will post prompts
 *    to. That belongs to somebody at the keyboard, for the same reason a token
 *    cannot manage tokens or edit the allowlist.
 *
 * ⚠️ DISCOVERY NEVER WRITES. `POST /api/admin/models/discover` asks a provider what
 * models it serves and returns the ids it found, marked as already-registered or
 * not. It cannot add rows, because **no provider API exposes pricing** — an
 * auto-added row would arrive priced at $0.00, which is precisely the silent
 * under-count that cost this project weeks in August. A price is typed in by a
 * person, with the URL they read it from.
 */

const { PROVIDERS } = require('../utils/model_registry');
const { VERIFIABLE_STAGES, stageProbe } = require('../agents/stage_schemas');
const { generateContent } = require('../agents/ai-client');
const { parseJsonWithRepair } = require('../agents/json_parse');

/** Where "discover" asks each provider family what it serves. */
const DISCOVERY = {
    gemini: {
        url: () => 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
        headers: key => ({ 'x-goog-api-key': key }),
        parse: body => (body?.models || []).map(m => ({
            id: String(m.name || '').replace(/^models\//, ''),
            label: m.displayName || null
        }))
    },
    anthropic: {
        url: () => 'https://api.anthropic.com/v1/models?limit=100',
        headers: key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
        parse: body => (body?.data || []).map(m => ({ id: m.id, label: m.display_name || null }))
    },
    'openai-compatible': {
        url: baseUrl => `${String(baseUrl).replace(/\/+$/, '')}/models`,
        headers: key => ({ authorization: `Bearer ${key}` }),
        parse: body => (body?.data || []).map(m => ({ id: m.id, label: m.name || null }))
    }
};

function registerModelRoutes(app, deps) {
    const {
        requireAuth,
        getSessionEmail,
        isGoogleAuthEnabled,
        isAdminEmail,
        isAllowedEmail,
        modelRegistry,
        accessControl,
        userKeys,
        providerKeyFor,
        recordVerificationUsage,
        BadRequestError,
        sendApiError
    } = deps;

    // Same guard as routes/admin.js — see the header there for why mutations are
    // session-only. Duplicated rather than shared because it is policy, not
    // mechanism, and the two files must be able to diverge without surprising anyone.
    function requireAdminSession(req, res, next) {
        if (!isGoogleAuthEnabled()) {
            return res.status(404).json({ error: 'Administration requires Google sign-in to be configured.' });
        }
        const email = getSessionEmail(req);
        if (!email) return res.status(401).json({ error: 'Sign in with Google to administer this deployment.' });
        if (!isAdminEmail(email)) {
            console.warn(`[models] denied ${email} a registry mutation (${req.method} ${req.path})`);
            return res.status(403).json({ error: 'This operation is restricted to the deployment administrator.' });
        }
        req.userEmail = email;
        return next();
    }

    /** The registry as the client needs it: rows, the price table, and Auto's map. */
    function registryPayload() {
        const models = modelRegistry.listModels();
        return {
            models,
            // Per-TOKEN rates, the shape window.ModelPricing.setPricingTable wants.
            // Served here so the browser has exactly the rows the server prices with
            // — there is one table and this is how the other half of it arrives.
            pricingTable: modelRegistry.pricingTable(),
            recommended: modelRegistry.getRecommended(),
            stalePricing: modelRegistry.stalePricing(),
            staleAfterDays: modelRegistry.PRICE_STALE_DAYS,
            providers: PROVIDERS
        };
    }

    app.get('/api/models', requireAuth, (_req, res) => {
        try {
            res.json(registryPayload());
        } catch (error) {
            console.error('model registry read error:', error.message);
            sendApiError(res, error, 'Failed to load the model registry');
        }
    });

    app.post('/api/admin/models', requireAdminSession, async (req, res) => {
        try {
            const body = req.body || {};
            try {
                await modelRegistry.addModel(body, { by: req.userEmail });
            } catch (err) {
                throw new BadRequestError(err.message);
            }
            console.log(`[models] ${req.userEmail} added ${body.id} (${body.provider})`);
            res.status(201).json({ ok: true, ...registryPayload() });
        } catch (error) {
            sendApiError(res, error, 'Failed to add the model');
        }
    });

    app.put('/api/admin/models/:id', requireAdminSession, async (req, res) => {
        try {
            const id = String(req.params.id || '').trim();
            const patch = { ...(req.body || {}) };
            // Not patchable, and silently ignored rather than refused: the client
            // round-trips whole rows, so rejecting them would make every save fail.
            // Renaming would orphan every usage record keyed by the old id, and a
            // hand-set `verified` is a claim nobody tested (see the registry header).
            delete patch.id;
            delete patch.verified;
            try {
                const changed = await modelRegistry.updateModel(id, patch);
                console.log(`[models] ${req.userEmail} ${changed ? 'updated' : 'saved (no change to)'} ${id}`);
            } catch (err) {
                throw new BadRequestError(err.message);
            }
            res.json({ ok: true, ...registryPayload() });
        } catch (error) {
            sendApiError(res, error, 'Failed to update the model');
        }
    });

    app.delete('/api/admin/models/:id', requireAdminSession, async (req, res) => {
        try {
            const id = String(req.params.id || '').trim();
            const row = modelRegistry.getModel(id);
            if (!row) return res.status(404).json({ error: `${id} is not in the registry.` });
            // ⚠️ Removing a priced row silently re-prices every past call on that
            // model to $0.00 and shrinks the admin spend view with nothing to show
            // for it. Disabling keeps the price and takes it out of the dropdowns,
            // which is what "I don't want people using this" actually means.
            if (row.pricing.inputPerMTok !== null && !row.deprecated) {
                return res.status(409).json({
                    error: `${id} carries a price, so past spend on it would silently re-price to $0.00. `
                        + 'Disable it instead (it leaves the dropdowns and keeps its rate), or mark it deprecated first.'
                });
            }
            await modelRegistry.removeModel(id);
            console.log(`[models] ${req.userEmail} removed ${id} from the registry`);
            res.json({ ok: true, ...registryPayload() });
        } catch (error) {
            sendApiError(res, error, 'Failed to remove the model');
        }
    });

    app.put('/api/admin/models-recommended', requireAdminSession, async (req, res) => {
        try {
            try {
                await modelRegistry.setRecommended(req.body?.recommended || {});
            } catch (err) {
                throw new BadRequestError(err.message);
            }
            console.log(`[models] ${req.userEmail} updated the recommended map`);
            res.json({ ok: true, ...registryPayload() });
        } catch (error) {
            sendApiError(res, error, 'Failed to save the recommended models');
        }
    });

    // ── Your own API keys (bring-your-own-keys) ────────────────────────────────
    //
    // ⚠️ SESSION-ONLY, LIKE TOKENS AND THE ALLOWLIST. A token must not be able to
    // write the keys of the account it belongs to: one leaked token would otherwise
    // become a way to redirect that person's spend to an attacker's account, and it
    // would survive revoking the token. Entering a key requires being at the keyboard.
    //
    // ⚠️ PLAINTEXT NEVER COMES BACK. `GET` returns masks and `usable` flags only —
    // there is deliberately no "show it to me again", exactly as with access tokens.

    function requireOwnSession(req, res, next) {
        if (!isGoogleAuthEnabled()) {
            // Nothing to key a personal store on. Absent, not unauthorized.
            return res.status(404).json({ error: 'Personal API keys need Google sign-in to be configured.' });
        }
        const email = getSessionEmail(req);
        if (!email) return res.status(401).json({ error: 'Sign in with Google to manage your API keys.' });
        req.userEmail = email;
        return next();
    }

    /** Read `{ provider, baseUrl }` from a body or query, refusing anything else. */
    function providerTarget(source = {}) {
        const provider = String(source.provider || '').trim();
        const baseUrl = String(source.baseUrl || '').trim();
        if (!PROVIDERS.includes(provider)) throw new BadRequestError(`Provider must be one of: ${PROVIDERS.join(', ')}.`);
        if (provider === 'openai-compatible' && !/^https?:\/\//i.test(baseUrl)) {
            throw new BadRequestError('An OpenAI-compatible key belongs to one endpoint — send its baseUrl.');
        }
        return { provider, baseUrl: provider === 'openai-compatible' ? baseUrl : null };
    }

    app.get('/api/my-keys', requireOwnSession, (req, res) => {
        try {
            res.json({
                mode: accessControl.keyModeFor(req.userEmail),
                canStoreKeys: userKeys.canStoreKeys(),
                keys: userKeys.listKeys(req.userEmail),
                // Which endpoints a byok writer actually needs a key for, so the
                // panel can ask for exactly those rather than for "a key".
                needed: neededKeySlots()
            });
        } catch (error) {
            sendApiError(res, error, 'Failed to load your API keys');
        }
    });

    app.put('/api/my-keys', requireOwnSession, async (req, res) => {
        try {
            const { provider, baseUrl } = providerTarget(req.body || {});
            const value = String(req.body?.key || '').trim();
            if (!value) throw new BadRequestError('An API key is required.');
            if (value.includes('•')) throw new BadRequestError('That is the masked display, not a key. Paste the real one.');
            try {
                await userKeys.setKey(req.userEmail, provider, value, baseUrl);
            } catch (err) {
                throw new BadRequestError(err.message);
            }
            // The value itself is never logged, here or anywhere.
            console.log(`[keys] ${req.userEmail} stored a ${provider} key${baseUrl ? ` for ${baseUrl}` : ''}`);
            res.json({ ok: true, keys: userKeys.listKeys(req.userEmail) });
        } catch (error) {
            sendApiError(res, error, 'Failed to save your API key');
        }
    });

    app.delete('/api/my-keys', requireOwnSession, async (req, res) => {
        try {
            const { provider, baseUrl } = providerTarget({ ...req.query, ...(req.body || {}) });
            const removed = await userKeys.removeKey(req.userEmail, provider, baseUrl);
            if (!removed) return res.status(404).json({ error: 'No such key on your account.' });
            console.log(`[keys] ${req.userEmail} removed their ${provider} key${baseUrl ? ` for ${baseUrl}` : ''}`);
            res.json({ ok: true, keys: userKeys.listKeys(req.userEmail) });
        } catch (error) {
            sendApiError(res, error, 'Failed to remove your API key');
        }
    });

    /** Every provider/endpoint an enabled model in the registry needs a key for. */
    function neededKeySlots() {
        const seen = new Map();
        for (const model of modelRegistry.listModels({ enabled: true })) {
            if (!model.provider) continue;
            const slot = model.provider === 'openai-compatible'
                ? `openai-compatible:${model.baseUrl}`
                : model.provider;
            if (!seen.has(slot)) {
                seen.set(slot, { slot, provider: model.provider, baseUrl: model.baseUrl || null, models: [] });
            }
            seen.get(slot).models.push(model.label || model.id);
        }
        return [...seen.values()];
    }

    // ── Verify: does this model actually work for these stages? ────────────────
    //
    // ⚠️ THE HONEST ANSWER, BEFORE THIS EXISTED, WAS "WE DON'T KNOW." The only
    // per-stage evidence was for the two Gemini defaults, arrived at by using them.
    // The Claude models had never run a single stage on prod, and the `minItems`
    // incident proved models differ on the exact schemas. So: one REAL request per
    // stage, carrying the stage's own schema object (agents/stage_schemas.js — the
    // same object the stage passes, never a copy), and the result written to
    // `verified[stage]`.
    //
    // ⚠️ IT COSTS MONEY, ON THE ADMIN'S OWN BUDGET. Opt-in per model per stage,
    // never automatic, and the spend lands on a fixture project owned by the admin
    // who ran it so it shows up in the same overview as everyone else's.
    app.post('/api/admin/models/:id/verify', requireAdminSession, async (req, res) => {
        try {
            const id = String(req.params.id || '').trim();
            const row = modelRegistry.getModel(id);
            if (!row) return res.status(404).json({ error: `${id} is not in the registry.` });

            const asked = Array.isArray(req.body?.stages) && req.body.stages.length
                ? req.body.stages.map(Number)
                : VERIFIABLE_STAGES;
            const stages = asked.filter(stage => VERIFIABLE_STAGES.includes(stage));
            if (!stages.length) {
                throw new BadRequestError(`Stages must be some of: ${VERIFIABLE_STAGES.join(', ')}.`);
            }

            const key = providerKeyFor(row.provider, row.baseUrl);
            if (!key) {
                throw new BadRequestError(
                    `No API key is available for ${row.provider}${row.baseUrl ? ` at ${row.baseUrl}` : ''}, `
                    + 'so there is nothing to verify with.'
                );
            }

            const results = [];
            for (const stage of stages) {
                const probe = stageProbe(stage);
                // Sequential, not parallel: verifying nine stages at once against a
                // fresh account is the shape that trips a provider's rate limiter,
                // and a 429 recorded as "this model does not work" would be a lie
                // that then makes Auto avoid a perfectly good model.
                const outcome = await runStageProbe({ row, probe, key, by: req.userEmail });
                await modelRegistry.setVerified(id, stage, outcome);
                results.push({ stage, visible: probe.visible, label: probe.label, kind: probe.kind, ...outcome });
            }

            const passed = results.filter(r => r.ok).length;
            console.log(`[models] ${req.userEmail} verified ${id}: ${passed}/${results.length} stage(s) passed`);
            res.json({ ok: true, id, results, ...registryPayload() });
        } catch (error) {
            sendApiError(res, error, 'Failed to verify the model');
        }
    });

    /**
     * One real request. Returns `{ ok, error }` — never throws, because a provider
     * refusing the schema IS the result we are recording, not a failure of the route.
     */
    async function runStageProbe({ row, probe, key, by }) {
        const started = Date.now();
        try {
            const response = await generateContent({
                model: row.id,
                geminiApiKey: row.provider === 'gemini' ? key : undefined,
                anthropicApiKey: row.provider === 'anthropic' ? key : undefined,
                openaiApiKey: row.provider === 'openai-compatible' ? key : undefined,
                baseUrl: row.baseUrl || undefined,
                contents: [probe.probe],
                config: {
                    temperature: 0.2,
                    // Small on purpose: this is an acceptance check, not a sample of
                    // the stage's real output, and every token is the admin's money.
                    maxOutputTokens: probe.kind === 'schema' ? 2000 : 400,
                    systemInstruction: probe.kind === 'schema'
                        ? 'Answer with the smallest valid response that fills every required field.'
                        : 'Answer briefly.'
                },
                ...(probe.schema ? { schema: probe.schema } : {})
            });

            // Record the spend against the admin who chose to pay for it.
            await recordVerificationUsage(by, response.usage);

            const text = String(response.text || '').trim();
            if (!text) return { ok: false, by, error: 'the model returned nothing' };
            if (probe.kind === 'schema') {
                // Accepting the schema is half of it; returning JSON that parses
                // against it is the half the pipeline actually depends on.
                try {
                    parseJsonWithRepair(text, { schema: probe.schema, label: `${row.id} stage ${probe.stage} verification` });
                } catch (err) {
                    return { ok: false, by, error: `returned unparseable JSON: ${err.message}`.slice(0, 400) };
                }
            }
            return { ok: true, by, ms: Date.now() - started };
        } catch (err) {
            // The provider's own words — "INVALID_ARGUMENT" on a minItems bound is
            // precisely the finding this action exists to surface.
            return { ok: false, by, error: String(err.message || err).slice(0, 400) };
        }
    }

    // ── Key mode, per person (admin) ───────────────────────────────────────────
    app.put('/api/admin/key-mode', requireAdminSession, async (req, res) => {
        try {
            const email = String(req.body?.email || '').trim().toLowerCase();
            const mode = String(req.body?.mode || '').trim();
            if (!email.includes('@')) throw new BadRequestError('A valid email address is required.');
            if (!isAllowedEmail(email)) throw new BadRequestError(`${email} is not on the allowlist — add them first.`);
            try {
                await accessControl.setKeyMode(email, mode);
            } catch (err) {
                throw new BadRequestError(err.message);
            }
            console.log(`[keys] ${req.userEmail} set ${email} to ${mode} keys`);
            res.json({ ok: true, email, mode, allowlist: accessControl.listAllowed() });
        } catch (error) {
            sendApiError(res, error, 'Failed to change the key mode');
        }
    });

    // ── Discover ───────────────────────────────────────────────────────────────
    // Ask a provider what it serves. Read-only by design — see the header.
    app.post('/api/admin/models/discover', requireAdminSession, async (req, res) => {
        try {
            const provider = String(req.body?.provider || '').trim();
            const baseUrl = String(req.body?.baseUrl || '').trim();
            const spec = DISCOVERY[provider];
            if (!spec) throw new BadRequestError(`Provider must be one of: ${PROVIDERS.join(', ')}.`);
            if (provider === 'openai-compatible' && !/^https?:\/\//i.test(baseUrl)) {
                throw new BadRequestError('An OpenAI-compatible provider needs a baseUrl to ask.');
            }

            const key = providerKeyFor(provider, baseUrl);
            if (!key) {
                throw new BadRequestError(
                    `No API key is configured for ${provider}${provider === 'openai-compatible' ? ` at ${baseUrl}` : ''}, `
                    + 'so there is nothing to ask with.'
                );
            }

            let payload;
            try {
                const response = await fetch(spec.url(baseUrl), {
                    headers: { accept: 'application/json', ...spec.headers(key) },
                    signal: AbortSignal.timeout(20_000)
                });
                const text = await response.text();
                if (!response.ok) {
                    // Relay the provider's own words — "invalid x-api-key" is a far
                    // more useful answer than "discovery failed".
                    throw new BadRequestError(`${provider} answered ${response.status}: ${text.slice(0, 300)}`);
                }
                payload = JSON.parse(text);
            } catch (err) {
                if (err instanceof BadRequestError) throw err;
                throw new BadRequestError(`Could not reach ${provider}: ${err.message}`);
            }

            const known = new Set(modelRegistry.listModels().map(m => m.id));
            const found = spec.parse(payload)
                .filter(m => m.id)
                .map(m => ({ ...m, registered: known.has(m.id) }));
            console.log(`[models] ${req.userEmail} discovered ${found.length} model(s) from ${provider}`);
            res.json({
                ok: true,
                provider,
                baseUrl: provider === 'openai-compatible' ? baseUrl : null,
                found,
                // Said out loud every time, because it is the reason discovery does
                // not simply add what it finds.
                note: 'No provider publishes prices through its API. Add a price and its source URL by hand.'
            });
        } catch (error) {
            sendApiError(res, error, 'Failed to discover models');
        }
    });
}

module.exports = { registerModelRoutes, DISCOVERY };
