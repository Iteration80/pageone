/**
 * routes/admin.js — the administrator surface (multi-user Phase 4).
 *
 * Split by kind, like routes/auth.js and routes/tokens.js: utils/access_control.js
 * decides what the allowlist, the admin list and the quotas ARE; this file only
 * wires those decisions to URLs and adds the per-request policy (who may call).
 *
 * TWO GUARDS, DELIBERATELY DIFFERENT:
 *
 *  - Reads (`GET /api/admin/overview`) are `requireAuth, requireAdmin` — an admin's
 *    access token may read them, so a backup script can also report spend.
 *  - Mutations are `requireAdminSession` — a live Google SESSION of an admin, never
 *    a token, for the same reason a token cannot manage tokens: a leaked admin token
 *    that could add its holder's own address to the allowlist would turn one stolen
 *    credential into persistent access that survives revoking it. Editing who may
 *    enter requires being at the keyboard.
 *
 * WHAT THE ROUTES REFUSE, AND WHY:
 *  - Removing an env-listed address (409): the environment is the floor; the store
 *    cannot override it, so pretending to remove it would be a lie the next request
 *    exposes. Change ALLOWED_EMAILS / ADMIN_EMAILS instead.
 *  - Removing / demoting YOURSELF (400): the last click an admin should be able to
 *    make from the UI is not "lock me out". Another admin can do it.
 *  - Promoting someone not on the allowlist (400): an admin who cannot sign in is a
 *    phantom, and the UI would show a name that cannot act.
 */

function registerAdminRoutes(app, deps) {
    const {
        requireAuth,
        requireAdmin,
        getSessionEmail,
        isGoogleAuthEnabled,
        isAdminEmail,
        isAllowedEmail,
        accessControl,
        usageRollup,
        currentMonthStartMs,
        priceUsage,
        BadRequestError,
        sendApiError
    } = deps;

    // A conflict with configuration the UI cannot change — 409, with the reason.
    class ConflictError extends BadRequestError {
        constructor(message) {
            super(message);
            this.statusCode = 409;
            this.code = 'CONFLICT';
        }
    }

    function requireAdminSession(req, res, next) {
        if (!isGoogleAuthEnabled()) {
            // Same reasoning as routes/tokens.js: with no Google identity there is no
            // one to be an admin, so the feature is absent rather than unauthorized.
            return res.status(404).json({ error: 'Administration requires Google sign-in to be configured.' });
        }
        const email = getSessionEmail(req);
        if (!email) return res.status(401).json({ error: 'Sign in with Google to administer this deployment.' });
        if (!isAdminEmail(email)) {
            console.warn(`[admin] denied ${email} an admin mutation (${req.method} ${req.path})`);
            return res.status(403).json({ error: 'This operation is restricted to the deployment administrator.' });
        }
        req.userEmail = email;
        return next();
    }

    function emailParam(req) {
        const email = String(req.params.email || '').trim().toLowerCase();
        if (!email.includes('@')) throw new BadRequestError('A valid email address is required.');
        return email;
    }

    function emailBody(req) {
        const email = String(req.body?.email || '').trim().toLowerCase();
        if (!email.includes('@')) throw new BadRequestError('A valid email address is required.');
        return email;
    }

    // ── Overview: everything the admin panel renders, in one call ──────────────
    app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
        try {
            const monthStart = currentMonthStartMs();
            const [allTime, month] = await Promise.all([
                usageRollup({ owner: null }),
                usageRollup({ owner: null, since: monthStart })
            ]);
            const monthByOwner = new Map(month.owners.map(b => [b.owner || '', b]));
            const allowlist = accessControl.listAllowed();
            const admins = accessControl.listAdmins();
            const quotas = accessControl.getQuotas();
            const adminSet = new Set(admins.map(a => a.email));

            const usage = new Map();
            const rowFor = owner => {
                const key = owner || '';
                if (!usage.has(key)) {
                    usage.set(key, {
                        owner: owner || null,
                        allowed: owner ? isAllowedEmail(owner) : null,
                        admin: owner ? adminSet.has(owner) : null,
                        quotaUsd: owner ? accessControl.effectiveQuotaFor(owner) : null,
                        projects: 0,
                        month: { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, byModel: [], unpriced: [] },
                        allTime: { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, byModel: [], unpriced: [] }
                    });
                }
                return usage.get(key);
            };
            // Every allowlisted person appears even with zero projects — the admin
            // is looking for "who is here and what have they spent", and a tester
            // who has spent nothing is an answer, not an omission.
            for (const entry of allowlist) rowFor(entry.email);
            for (const bucket of allTime.owners) {
                const row = rowFor(bucket.owner);
                const priced = priceUsage(bucket.byModel);
                row.projects = bucket.projects;
                row.allTime = { usd: priced.totalUsd, calls: bucket.calls, inputTokens: bucket.inputTokens, outputTokens: bucket.outputTokens, byModel: priced.rows, unpriced: priced.unpriced };
                const m = monthByOwner.get(bucket.owner || '');
                if (m) {
                    const pm = priceUsage(m.byModel);
                    row.month = { usd: pm.totalUsd, calls: m.calls, inputTokens: m.inputTokens, outputTokens: m.outputTokens, byModel: pm.rows, unpriced: pm.unpriced };
                }
            }

            res.json({
                me: req.userEmail || null,
                googleEnabled: isGoogleAuthEnabled(),
                monthStart: new Date(monthStart).toISOString(),
                allowlist: allowlist.map(e => ({ ...e, admin: adminSet.has(e.email) })),
                admins,
                quotas,
                usage: [...usage.values()].sort((a, b) => b.month.usd - a.month.usd || b.allTime.usd - a.allTime.usd)
            });
        } catch (error) {
            console.error('admin overview error:', error.message);
            sendApiError(res, error, 'Failed to load the admin overview');
        }
    });

    // ── Allowlist ──────────────────────────────────────────────────────────────
    app.post('/api/admin/allowlist', requireAdminSession, async (req, res) => {
        try {
            const email = emailBody(req);
            const added = await accessControl.addAllowedEmail(email, { by: req.userEmail });
            console.log(`[admin] ${req.userEmail} ${added ? 'added' : 're-added (no change)'} ${email} to the allowlist`);
            res.status(added ? 201 : 200).json({ ok: true, email, added, allowlist: accessControl.listAllowed() });
        } catch (error) {
            sendApiError(res, error, 'Failed to add to the allowlist');
        }
    });

    app.delete('/api/admin/allowlist/:email', requireAdminSession, async (req, res) => {
        try {
            const email = emailParam(req);
            if (email === req.userEmail) throw new BadRequestError('You cannot remove your own access. Ask another administrator.');
            if (accessControl.envAllowedEmails().includes(email)) {
                throw new ConflictError(`${email} is set by the ALLOWED_EMAILS environment variable and can only be removed there.`);
            }
            const removed = await accessControl.removeAllowedEmail(email);
            if (!removed) return res.status(404).json({ error: `${email} is not on the allowlist.` });
            console.log(`[admin] ${req.userEmail} removed ${email} from the allowlist`);
            res.json({ ok: true, email, allowlist: accessControl.listAllowed() });
        } catch (error) {
            sendApiError(res, error, 'Failed to remove from the allowlist');
        }
    });

    // ── Admins ─────────────────────────────────────────────────────────────────
    app.post('/api/admin/admins', requireAdminSession, async (req, res) => {
        try {
            const email = emailBody(req);
            if (!isAllowedEmail(email)) throw new BadRequestError(`${email} is not on the allowlist — add them first.`);
            const added = await accessControl.addAdmin(email, { by: req.userEmail });
            console.log(`[admin] ${req.userEmail} ${added ? 'promoted' : 'confirmed'} ${email} as admin`);
            res.status(added ? 201 : 200).json({ ok: true, email, added, admins: accessControl.listAdmins() });
        } catch (error) {
            sendApiError(res, error, 'Failed to promote');
        }
    });

    app.delete('/api/admin/admins/:email', requireAdminSession, async (req, res) => {
        try {
            const email = emailParam(req);
            if (email === req.userEmail) throw new BadRequestError('You cannot demote yourself. Ask another administrator.');
            if (accessControl.envAdminEmails().includes(email)) {
                throw new ConflictError(`${email} is set by the ADMIN_EMAILS environment variable and can only be demoted there.`);
            }
            const removed = await accessControl.removeAdmin(email);
            if (!removed) {
                // Either not an admin at all, or admin only by the bootstrap rule
                // (first ALLOWED_EMAILS address, nobody else named) — that one is
                // demoted by naming someone else, which the UI does by promoting.
                if (accessControl.bootstrapAdminEmail() === email) {
                    throw new ConflictError(`${email} is the bootstrap administrator (first ALLOWED_EMAILS address). Promote another admin explicitly and the bootstrap switches off.`);
                }
                return res.status(404).json({ error: `${email} is not an administrator.` });
            }
            console.log(`[admin] ${req.userEmail} demoted ${email}`);
            res.json({ ok: true, email, admins: accessControl.listAdmins() });
        } catch (error) {
            sendApiError(res, error, 'Failed to demote');
        }
    });

    // ── Quotas ─────────────────────────────────────────────────────────────────
    app.put('/api/admin/quotas', requireAdminSession, async (req, res) => {
        try {
            const body = req.body || {};
            const patch = {};
            if ('defaultMonthlyUsd' in body) patch.defaultMonthlyUsd = body.defaultMonthlyUsd === '' ? null : body.defaultMonthlyUsd;
            if ('perUser' in body) patch.perUser = body.perUser;
            if (!('defaultMonthlyUsd' in patch) && !('perUser' in patch)) {
                throw new BadRequestError('Send defaultMonthlyUsd and/or perUser.');
            }
            try {
                await accessControl.setQuotas(patch);
            } catch (err) {
                throw new BadRequestError(err.message);
            }
            console.log(`[admin] ${req.userEmail} updated quotas`);
            res.json({ ok: true, quotas: accessControl.getQuotas() });
        } catch (error) {
            sendApiError(res, error, 'Failed to update quotas');
        }
    });
}

module.exports = { registerAdminRoutes };
