/**
 * utils/request_identity.js — who is making the current request (multi-user Phase 2).
 *
 * WHY AsyncLocalStorage instead of passing `req` down.
 *
 * Ownership has to be enforced where the project file is resolved — in
 * `readProjectJSONById`, `updateProjectJSON` and `writeProjectJSON` — not in each
 * route. There are ~110 call sites across 8 route modules, and the failure mode of
 * missing one is the worst kind this project has: serving user A's script to user B,
 * 200 OK, with nothing in any log. Threading an argument through all of them means a
 * new route can silently opt out of the check by not passing it, and it would look
 * completely normal in review.
 *
 * With a request-scoped store the chokepoint reads the identity itself, so a route
 * cannot fail to supply it — there is nothing to supply. A new route added next year
 * is enforced without its author knowing this file exists.
 *
 * ⚠️ NO IDENTITY MEANS SYSTEM CONTEXT, AND SYSTEM CONTEXT IS TRUSTED. Startup
 * seeding, migrations and tests run outside any request and must be able to touch
 * every project. That makes it load-bearing that EVERY request runs inside a context:
 * `requireAuth` enters one on every path that calls `next()`, including the open-mode
 * and break-glass paths, so a request can never be mistaken for a system call.
 */

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Run `fn` with the given identity attached to the current async context.
 *
 * `identity` is `{ email, method }`. `email` may be null (open mode, or break-glass,
 * which authenticates as the deployment rather than as a person). `method` is one of
 * 'session' | 'token' | 'secret' | 'open'.
 */
function runWithIdentity(identity, fn) {
    return storage.run(identity || null, fn);
}

/** The current request's identity, or null when this is a system call. */
function currentIdentity() {
    return storage.getStore() || null;
}

/**
 * True when this call is happening inside a request whose caller is a specific
 * person. Break-glass and open mode both return false — deliberately:
 *
 *  - `secret` is APP_SECRET, the admin/maintenance credential. It resolves to no
 *    email by design, so there is no owner to compare against and it sees everything.
 *    That is what break-glass is for, and it never leaves Railway's env.
 *  - `open` is unconfigured localhost dev, which is single-user by definition.
 */
function hasScopedIdentity() {
    const identity = currentIdentity();
    return Boolean(identity && identity.email);
}

/** The current caller's email, or null. */
function currentUserEmail() {
    return currentIdentity()?.email || null;
}

module.exports = {
    runWithIdentity,
    currentIdentity,
    currentUserEmail,
    hasScopedIdentity
};
