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
        modelRegistry,
        providerKeyFor,
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
