# Codex Handoff — Full Audit Before Live Testing (2026-07-08)

Carsten is about to do a live conversational shakedown of the entire app (roadmap R6) —
first real hands-on use since the tool-calling assistant rebuild AND since a brand-new
Google sign-in system went live on production today. Before he does, run a full audit
pass: **read everything below, verify what you can, fix what's clearly safe to fix, and
write up a findings report for anything you fix or can't resolve yourself.** This is an
audit-and-report task first, a fix task second — don't silently change behavior without
saying so in your findings.

Read `CLAUDE.md` and `specs/pageone-roadmap-2026-07-03.md` first for full context. This
doc covers what's changed **since** that roadmap was written and where to point your
attention.

## What shipped since the 2026-07-03 roadmap (all on `main`, all pushed, all live on Railway)

In commit order:
1. `d965963` — Settings model dropdown updated to Claude Fable 5 / Opus 4.8 / Sonnet 5
   (dropped Opus 4.6/4.7, Sonnet 4.6 from the UI list, kept in pricing table for history).
   `CLAUDE_NO_TEMPERATURE` in `agents/ai-client.js` extended to cover the new models
   (they 400 if `temperature` is sent).
2. `489827e` — `GET /api/maintenance/provider-health`: pings Anthropic/Gemini with the
   server's *configured* key, reports ok/invalid/missing without exposing the key
   (returns a last-4 + length hint only). Used to confirm a key rotation took effect.
3. `cbad241` — **Google OAuth sign-in with an email allowlist**, layered on top of the
   existing `APP_SECRET` passphrase. This is the big one — full detail below.

Live verification already done by me (Claude) before you start:
- Full test suite green at 162 tests (`node --test 'test/*.test.js'`) as of `cbad241`.
- All three auth modes (open / secret / google) boot-tested end-to-end via curl against
  a locally-booted server — see the "already verified" list under Auth below.
- Deployed to Railway, confirmed live: `curl https://pageone-production.up.railway.app/api/auth-config`
  currently returns `{"mode":"google","googleEnabled":true}` — Google sign-in is LIVE
  on the tester site right now, not just staged.
- Carsten walked through Google Cloud Console himself (OAuth consent/Audience →
  Production, Web client created, redirect URI `https://pageone-production.up.railway.app/auth/google/callback`)
  and added `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`ALLOWED_EMAILS` to Railway. Redeployed
  and confirmed `mode: "google"` live. He has NOT yet done a real login (allowlisted
  account clicking through the actual Google consent screen) — that's part of what he's
  about to test.

## Auth system — read this first: `utils/auth.js` (new file, ~200 lines)

Design intent (also see the doc-comment at the top of the file): three layers, each
dormant unless configured, checked in this order inside `requireAuth` (server.js):
1. **Google session** — valid HMAC-signed session cookie for an email currently in
   `ALLOWED_EMAILS`. Enabled only when `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` +
   `ALLOWED_EMAILS` are ALL set.
2. **`APP_SECRET` break-glass** — the original shared-secret header check, unchanged,
   still valid even when Google mode is on (this is intentional — it's how the
   maintenance endpoints and any CLI/admin scripts still get in).
3. **Open** — if neither is configured, no auth at all (localhost dev).

Session mechanism: stateless, no session store. `signSession(email, secret)` builds
`base64url(JSON{email,exp}).base64url(HMAC-SHA256(payload, secret))`; `verifySession`
re-derives the HMAC with `crypto.timingSafeEqual` and checks expiry. Secret is
`SESSION_SECRET` env var, falling back to `APP_SECRET`. **The allowlist is re-checked on
every request** (`getSessionEmail` calls `isAllowedEmail` after verifying the signature),
so removing an email from `ALLOWED_EMAILS` revokes access immediately even for someone
holding an already-valid, unexpired cookie — this is deliberate and unit-tested.

Routes (registered directly from `utils/auth.js` via `registerAuthRoutes(app, {APP_SECRET})`,
called in server.js right after `express.json()`, before the other route modules):
- `GET /api/auth-config` — public, tells frontend which login UI to render (`google`|`secret`|`open`)
- `GET /api/me` — public route, but returns 401 unless a valid session cookie is present; `{email}` on success
- `GET /auth/google` — sets a random `state` in an httpOnly cookie, redirects to Google's consent screen
- `GET /auth/google/callback` — verifies `state` matches the cookie (CSRF guard), exchanges the code,
  verifies the ID token via `google-auth-library`'s `OAuth2Client.verifyIdToken`, checks
  `email_verified` + allowlist, signs a session cookie, redirects to `/`
- `POST /auth/logout` — clears the session cookie

Frontend (`public/app.js` + `public/index.html`): the login overlay now has two panels
(Google button / passphrase form) and `initAuthMode()` fetches `/api/auth-config` before
deciding which to show — this was specifically designed so the overlay can never show the
wrong login method for the backend's actual mode (that mismatch caused the closure-scope
lockout bug back on 2026-06-11 — see the process-lesson note in the roadmap). Settings
modal gets a new "Signed in as `<email>` · Sign out" panel, Google-mode only.

### What I already verified (don't re-do, but spot-check if you want)
- 10 unit tests in `test/auth.test.js`: session sign/verify round-trip, tamper rejection,
  wrong-secret rejection, expiry rejection, malformed-input rejection, config gating
  (all three of clientId/secret/allowlist required), case-insensitive allowlist matching,
  and — the one I'd call the most important — **live allowlist revocation**: a session
  signed while an email was allowlisted is rejected once that email is removed from
  `ALLOWED_EMAILS`, using the *same* signed token.
- Manual E2E via curl against a locally-booted server in all three modes: open serves
  freely; secret-mode 401s without header and 200s with the right `X-Api-Key`; google-mode
  401s `/api/me` and `/api/projects` with no cookie, 401s with a forged-secret cookie,
  401s with a valid-signature cookie for a non-allowlisted email, 200s with a valid cookie
  for an allowlisted email (`{"email":"writer@example.com"}`), and the `APP_SECRET`
  break-glass header still works even with Google mode on. `/auth/google` redirects (302).
- Confirmed via grep that all 7 route modules (`routes/*.js`) destructure and apply
  `requireAuth` — I did not manually re-verify every individual route inside every file.

### What I did NOT test — this is your primary job
1. **No automated test exercises the actual Express routes** (`/auth/google`,
   `/auth/google/callback`, `/api/me`, `/api/auth-config`, `/auth/logout`) as wired
   through `registerAuthRoutes` — my testing of those was manual curl, not a committed
   test. Consider adding route-level tests (supertest or a minimal http-request harness —
   check what's already used elsewhere in this repo, if anything, for route testing
   precedent) at least for: `/api/auth-config` reflects env correctly; `/api/me` 401
   without cookie / 200 with valid cookie; `/auth/google/callback` rejects a
   state-cookie mismatch; `/auth/logout` actually clears the cookie (check `Set-Cookie`
   header has an expiry in the past / `maxAge: 0`).
2. **The real Google OAuth handshake has never been exercised** — only the parts on our
   side (the redirect, and manually-minted cookies simulating a successful callback). The
   actual `client.getToken()` / `client.verifyIdToken()` calls are 100% untested against
   real Google infrastructure. This is Carsten's job in his live test (he'll click "Sign
   in with Google" for real), but LOOK CLOSELY at the callback handler for correctness
   issues that would only surface in the real flow:
   - Is `redirectUri` in the callback handler byte-identical to the one used in
     `/auth/google` (both derived from `requestBaseUrl(req)` — confirm this resolves
     identically on both legs of the flow on Railway, where requests go through a
     reverse proxy; specifically check `x-forwarded-host`/`x-forwarded-proto` are
     present and consistent on Railway's edge — if they're ever absent or different
     between the two requests, the redirect_uri mismatch will make the token exchange
     fail with a Google-side error, not one of ours).
   - `isSecureRequest()` also depends on `x-forwarded-proto` — if that header is ever
     missing on Railway, cookies would be set with `secure: false` behind an HTTPS proxy,
     which usually still works but is worth flagging if you find evidence it could be wrong.
   - Confirm error paths are graceful: if the user denies consent, or Google returns an
     error, or the token exchange throws — does the user get redirected somewhere sane
     with a message (`/?auth=error` / `/?auth=denied`), or would they see a raw stack
     trace / hang? Read through `app.get('/auth/google/callback', ...)`'s catch block.
3. **Security review pass on `utils/auth.js` with fresh eyes** — I wrote this file
   quickly under time pressure for a live tester deployment. Things worth specifically
   trying to break:
   - Cookie parsing (`parseCookies`) — hand-rolled, not a library. Try to find an edge
     case (multiple cookies with the same name, unusual characters, missing `=`, etc.)
     that could let a value smuggle past it or get misparsed.
   - Is there any path where `getSessionEmail` could return a truthy value for an
     attacker without a validly-signed cookie? (i.e., re-derive the threat model from
     scratch, don't just trust my test list.)
   - `STATE_COOKIE` / CSRF state — is 10 minutes (`STATE_TTL_MS`) reasonable, and is the
     state cookie cleared/single-use correctly (I clear it in the callback handler before
     validating — confirm that ordering doesn't create a replay window)?
   - Should `/auth/google/callback` and `/auth/google` have rate limiting? They currently
     use no rate limiter (unlike `aiLimiter`/`strictLimiter` elsewhere in the codebase).
     Low risk (Google's own infra absorbs most abuse potential) but worth a decision, not
     a silent gap — flag it, fix it if you think it's cheap and clearly right, otherwise
     leave it for Carsten to decide.
4. **Documentation drift — already found, needs fixing.** Neither `CLAUDE.md` nor
   `DEPLOYMENT.md` mention the Google auth system at all. `CLAUDE.md`'s
   "Authentication (`APP_SECRET`)" section under Deployment Notes is now incomplete —
   it describes only layer 2 of 3. `DEPLOYMENT.md`'s Railway env var list doesn't mention
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`ALLOWED_EMAILS`/`SESSION_SECRET`. **Given
   this repo's history of doc-drift causing real confusion (see the R5 item in the June
   roadmap — CLAUDE.md documented a deleted architecture as current for weeks), please
   fix this one directly** rather than just flagging it: update both files to describe
   all three auth layers, list the new env vars, and note that `APP_SECRET` remains
   required as break-glass even when Google auth is the primary login path.
5. **Structural nit, your call:** `registerAuthRoutes` lives in `utils/auth.js` rather
   than a `routes/auth.js`, which is inconsistent with the `routes/*.js` pattern the rest
   of the app now follows (assistant/export/generation/knowledge/projects/rewrite/styles).
   I did this deliberately to keep the security-sensitive logic and its routes in one
   file, but if you think consistency wins, moving the route-registration function to
   `routes/auth.js` (importing the crypto/config helpers from `utils/auth.js`) is a clean,
   low-risk refactor. Optional — don't spend real time on it if the audit below turns up
   anything more important.

## Also re-verify (regression risk from the auth change, even though unrelated on paper)

- **Every route in every `routes/*.js` file still requires `requireAuth`** — I confirmed
  the parameter is destructured and used in all 7 files via grep, but did not manually
  walk every individual `app.get`/`app.post` line to confirm none of them was added
  without it. Do that walk. An endpoint missing `requireAuth` would now be a real
  security gap (previously it would've just been dormant-open like everything else).
- **The tool-calling assistant contract is untouched by any of this** (auth is
  middleware, sits in front of routes, doesn't touch `agents/assistant.js` or
  `agents/tool_messages.js`) — but since Carsten's about to live-test that system for
  the first time across multiple stages, a final `node --test 'test/*.test.js'` +
  `npm run test:knowledge` pass plus a boot smoke is cheap insurance. Confirm 162+ tests
  still green.
- **Settings model list / `CLAUDE_NO_TEMPERATURE`** — confirm no saved project still
  references an old model string (`claude-opus-4-7` etc.) in a way that would now break;
  check `agents/ai-client.js` still has the old model IDs in whatever code path actually
  calls the SDK (dropdown removal ≠ API-call removal — the old models should still be
  *callable* for any project/settings.json that still names them, just not offered as new
  choices). If you find evidence that isn't true, that's a real bug — old saved settings
  pointing at Opus 4.6/4.7 would silently 400 without the temperature fix.
- **`public/app.js:10682`** has a `// TODO: verify Sonnet 5 list price` comment on the
  Sonnet 5 pricing row (currently mirrors Sonnet 4.6's $3/$15). If you have access to
  current, verified pricing, correct it and drop the comment; if not, leave it — this is
  low priority and cosmetic (only affects the in-app spend estimate, not billing).

## What NOT to do
- Don't touch the assistant tool-calling contract (`agents/assistant.js`,
  `agents/tool_messages.js`, the `turnState` round-trip, `toolResultsContainFailure`) —
  out of scope for this pass, and Carsten's about to live-test it as-is.
- Don't rotate or regenerate the live `GOOGLE_CLIENT_SECRET`/`APP_SECRET` on Railway.
- Don't flip `ALLOWED_EMAILS` or touch Railway env vars — that's Carsten's live config now.
- Don't merge/rebase away the existing `test/auth.test.js` — extend it, don't replace it.

## Gate for every change you make
```sh
node --test 'test/*.test.js'      # expect 162+ passing (glob form — bare `test/` breaks on Node 24)
npm run test:knowledge
PORT=3467 node server.js &        # boot smoke
curl -s http://127.0.0.1:3467/health
curl -s http://127.0.0.1:3467/api/auth-config   # confirm mode reflects your local env (probably "open" with no env vars set)
```
One commit per logical fix, as you've been doing. Write a findings section (in your
final response to Carsten, or as a new dated section appended to this file — your call)
covering: what you fixed, what you found but left for Carsten to decide, and what you
verified was already fine. He's using this to decide what to focus on in his live test,
so be concrete about severity, not just a list of things you looked at.
