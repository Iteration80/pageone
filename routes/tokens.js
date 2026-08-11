/**
 * routes/tokens.js — personal access token management (multi-user Phase 1).
 *
 * Split by kind, the same way routes/auth.js is: utils/tokens.js decides what a
 * token is and whether one is valid; this file only wires those decisions to URLs.
 *
 * ⚠️ These three routes are guarded by `requireSession`, NOT `requireAuth` — a
 * token cannot manage tokens. Two reasons, and both are load-bearing:
 *
 *  1. A leaked token would otherwise be able to mint fresh ones and revoke the
 *     owner's real ones, which turns a single stolen credential into persistent
 *     access that survives revoking the credential that was stolen.
 *  2. `APP_SECRET` resolves to no email at all (that is exactly why PATs exist), so
 *     "list my tokens" has no answer for it. Break-glass access can still reach the
 *     store the way it reaches everything else on the volume — through the file.
 *
 * The practical consequence: token management requires a live Google sign-in in a
 * browser. That is the intended shape — you mint a token from a session, then the
 * token does script work.
 */

function registerTokenRoutes(app, deps) {
    const {
        getSessionEmail,
        isGoogleAuthEnabled,
        createToken,
        listTokens,
        revokeToken,
        BadRequestError,
        sendApiError
    } = deps;

    /**
     * Only a browser session gets past this. `getSessionEmail` already re-checks the
     * live allowlist, so an email removed from ALLOWED_EMAILS loses management access
     * on its next request — the same instant its tokens stop working.
     */
    function requireSession(req, res, next) {
        if (!isGoogleAuthEnabled()) {
            // Tokens are minted from a Google identity and authenticate as one. With
            // Google auth unconfigured there is no identity to own them, so the
            // feature is genuinely absent rather than merely unauthorized — say so,
            // instead of returning a 401 that invites the caller to find a credential.
            return res.status(404).json({ error: 'Access tokens require Google sign-in to be configured.' });
        }
        const email = getSessionEmail(req);
        if (!email) return res.status(401).json({ error: 'Sign in with Google to manage access tokens.' });
        req.userEmail = email;
        return next();
    }

    // List the caller's tokens. Metadata only — the store holds no plaintext to leak.
    app.get('/api/tokens', requireSession, async (req, res) => {
        try {
            res.json({ tokens: await listTokens(req.userEmail) });
        } catch (err) {
            sendApiError(res, err);
        }
    });

    // Mint one. The plaintext in this response is the only copy that will ever exist.
    app.post('/api/tokens', requireSession, async (req, res) => {
        try {
            const name = String(req.body?.name || '').trim();
            if (!name) throw new BadRequestError('A token name is required.');

            const rawExpiry = req.body?.expiresInDays;
            let expiresInDays;
            if (rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== '') {
                expiresInDays = Number(rawExpiry);
                if (!Number.isFinite(expiresInDays) || expiresInDays <= 0) {
                    throw new BadRequestError('expiresInDays must be a positive number of days.');
                }
            }

            const { token, record } = await createToken({ name, owner: req.userEmail, expiresInDays });
            console.log(`[tokens] minted "${record.name}" for ${record.owner}`);
            res.status(201).json({ token, ...record });
        } catch (err) {
            sendApiError(res, err);
        }
    });

    // Revoke one. Owner-scoped in the store, so a guessed id belonging to someone
    // else is a 404 here rather than a deletion there.
    app.delete('/api/tokens/:id', requireSession, async (req, res) => {
        try {
            const removed = await revokeToken(req.params.id, req.userEmail);
            if (!removed) return res.status(404).json({ error: 'Token not found.' });
            console.log(`[tokens] revoked ${req.params.id} for ${req.userEmail}`);
            res.json({ ok: true });
        } catch (err) {
            sendApiError(res, err);
        }
    });
}

module.exports = { registerTokenRoutes };
